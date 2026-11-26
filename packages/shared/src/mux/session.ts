import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import {
  MuxConnectionClosedError,
  MuxProtocolError,
  MuxResetCode,
  MuxStreamLimitError,
  MuxStreamResetError,
  MuxStreamStateError,
  type MuxStreamError,
} from "./errors.ts";
import {
  decodeFrame,
  decodeResetPayload,
  decodeWindowPayload,
  encodeFrame,
  encodeResetPayload,
  encodeWindowPayload,
  MUX_DATA_CHUNK_BYTES,
  MUX_MAX_PAYLOAD_BYTES,
  MUX_MAX_STREAM_ID,
  MUX_MAX_WINDOW_BYTES,
  type MuxFrame,
  MuxFrameType,
} from "./frame.ts";
import {
  decodeOpen,
  decodeResponseHead,
  encodeMetadata,
  type MuxOpen,
  type MuxResponseHead,
  sanitizeForwardedHeaders,
} from "./open.ts";

export type MuxRole = "client" | "host";

export interface MuxLimits {
  /** Live streams on the connection, both directions together. */
  readonly maxStreams: number;
  /**
   * Bytes a sender may have in flight per stream and direction. Both ends of a connection must
   * use the same value: a sender cannot learn the other side's setting before its OPEN.
   */
  readonly streamWindowBytes: number;
  /**
   * Received bytes that no consumer has read yet, across all streams. Streams that would pass it
   * are reset. The default is `maxStreams * streamWindowBytes`, so a peer that obeys the windows
   * never reaches it.
   */
  readonly maxBufferedBytes: number;
}

export const MUX_DEFAULT_LIMITS: MuxLimits = {
  maxStreams: 64,
  streamWindowBytes: 256 * 1024,
  maxBufferedBytes: 64 * 256 * 1024,
};

export type MuxChunk =
  | { readonly _tag: "Data"; readonly bytes: Uint8Array }
  /** The peer half-closed. `payload` is what its CLOSE frame carried. */
  | { readonly _tag: "End"; readonly payload: Uint8Array };

/** One request/response or WebSocket exchange. Built on the session; read by one consumer at a time. */
export interface MuxStream {
  readonly id: number;
  /** Client side: waits for the host's head (HTTP status line, WebSocket accept). */
  readonly awaitResponse: Effect.Effect<MuxResponseHead, MuxStreamError>;
  /** Host side: answers the OPEN. Must come before `send` and `close`. */
  readonly respond: (head: MuxResponseHead) => Effect.Effect<void, MuxStreamError>;
  /** Next chunk, or `End` once the peer closed; `End` repeats. Returning credit is what lets the peer send more. */
  readonly read: Effect.Effect<MuxChunk, MuxStreamError>;
  readonly incoming: Stream.Stream<Uint8Array, MuxStreamError>;
  /** Waits for window credit. Buffers over one frame are split; one frame or less is sent whole. */
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, MuxStreamError>;
  /** Half-close: nothing more will be sent. Idempotent. */
  readonly close: (payload?: Uint8Array) => Effect.Effect<void, MuxStreamError>;
  /** Tears the stream down in both directions. Does nothing once the stream is over. */
  readonly reset: (code?: MuxResetCode, detail?: string) => Effect.Effect<void>;
}

/** Handles one OPEN on the host. Its failure resets the stream; its interruption means the peer is gone. */
export type MuxHandler<E = never, R = never> = (
  open: MuxOpen,
  stream: MuxStream,
) => Effect.Effect<void, E, R>;

export interface MuxSessionStats {
  readonly activeStreams: number;
  /** Received and not yet read, across streams. */
  readonly bufferedBytes: number;
  /** Frames waiting for the socket. */
  readonly queuedFrames: number;
}

export interface MuxSession {
  readonly role: MuxRole;
  readonly limits: MuxLimits;
  readonly open: (
    open: MuxOpen,
  ) => Effect.Effect<
    MuxStream,
    MuxStreamLimitError | MuxConnectionClosedError | MuxStreamStateError
  >;
  /** Completes with the reason when the socket closes, fails, or the session's scope closes. */
  readonly closed: Effect.Effect<MuxConnectionClosedError>;
  readonly stats: Effect.Effect<MuxSessionStats>;
}

export interface MuxSessionOptions<E, R> {
  readonly socket: Socket.Socket;
  readonly role: MuxRole;
  readonly limits?: Partial<MuxLimits> | undefined;
  /** Without one, every peer OPEN is refused. */
  readonly handler?: MuxHandler<E, R> | undefined;
}

/** Wakes fibers that wait for a state change. The condition is re-checked synchronously, so no wake-up is lost. */
class Waiters {
  private pending = new Set<Deferred.Deferred<void>>();

  waitUntil(ready: () => boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (ready()) return Effect.void;
      const waiter = Deferred.makeUnsafe<void>();
      this.pending.add(waiter);
      return Deferred.await(waiter).pipe(
        Effect.ensuring(Effect.sync(() => this.pending.delete(waiter))),
        Effect.andThen(this.waitUntil(ready)),
      );
    });
  }

  wake() {
    if (this.pending.size === 0) return;
    const waiters = [...this.pending];
    this.pending.clear();
    for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.void);
  }
}

interface StreamState {
  readonly id: number;
  /** This side opened the stream and expects a response head. */
  readonly initiator: boolean;
  readonly head: Deferred.Deferred<MuxResponseHead, MuxStreamError>;
  responded: boolean;
  localClosed: boolean;
  remoteEnded: boolean;
  /** Reset or connection failure; the stream is already gone from the session. */
  terminal: MuxStreamError | undefined;
  done: boolean;
  /** Handler finished while the peer was still sending: bytes are dropped, credit returned. */
  draining: boolean;
  sendWindow: number;
  /** What the peer may still send before we return credit. */
  granted: number;
  pendingCredit: number;
  buffered: number;
  readonly inbox: Array<MuxChunk>;
  endChunk: MuxChunk | undefined;
  readonly outbox: Array<Uint8Array>;
  inReady: boolean;
  /** Frames of this stream already handed to the socket; its OPEN is the first. */
  framesWritten: number;
  readonly readWaiters: Waiters;
  readonly sendWaiters: Waiters;
  fiber: Fiber.Fiber<void, never> | undefined;
}

const isProtocolError = Schema.is(MuxProtocolError);

const closedError = (cause: unknown, detail: string) =>
  new MuxConnectionClosedError({ detail, cause });

export const makeMuxSession = Effect.fn("MuxSession.make")(function* <E = never, R = never>(
  options: MuxSessionOptions<E, R>,
) {
  const { role, handler } = options;
  const requested: MuxLimits = { ...MUX_DEFAULT_LIMITS, ...options.limits };
  // A window smaller than a frame could never carry one.
  const limits: MuxLimits = {
    ...requested,
    streamWindowBytes: Math.max(requested.streamWindowBytes, MUX_DATA_CHUNK_BYTES),
  };
  const services = yield* Effect.context<R>();
  const runFork = Effect.runForkWith(services);
  const scope = yield* Effect.scope;
  const reader = yield* options.socket.reader.pipe(
    Effect.mapError((error) => closedError(error, "The socket failed before the mux started.")),
  );
  const writer = yield* options.socket.writer;

  const streams = new Map<number, StreamState>();
  const control: Array<Uint8Array> = [];
  const ready: Array<StreamState> = [];
  const writerWaiters = new Waiters();
  const closedSignal = Deferred.makeUnsafe<MuxConnectionClosedError>();
  const creditThreshold = Math.max(1, Math.floor(limits.streamWindowBytes / 2));
  let nextLocalId = role === "client" ? 1 : 2;
  let highestPeerId = 0;
  let closedReason: MuxConnectionClosedError | undefined;
  let totalBuffered = 0;

  const ownsId = (id: number) => id % 2 === nextLocalId % 2;

  const wakeStream = (stream: StreamState) => {
    stream.readWaiters.wake();
    stream.sendWaiters.wake();
  };

  const pushControl = (frame: MuxFrame) => {
    if (closedReason !== undefined) return;
    control.push(encodeFrame(frame));
    writerWaiters.wake();
  };

  const enqueue = (stream: StreamState, frame: MuxFrame) => {
    stream.outbox.push(encodeFrame(frame));
    if (!stream.inReady) {
      stream.inReady = true;
      ready.push(stream);
    }
    writerWaiters.wake();
  };

  /** Control frames first, then one frame per ready stream in turn, so a bulk stream never starves the others. */
  const nextFrame = (): Uint8Array | undefined => {
    const frame = control.shift();
    if (frame !== undefined) return frame;
    for (let stream = ready.shift(); stream !== undefined; stream = ready.shift()) {
      const next = stream.outbox.shift();
      if (next === undefined) {
        stream.inReady = false;
        continue;
      }
      stream.framesWritten += 1;
      if (stream.outbox.length > 0) ready.push(stream);
      else stream.inReady = false;
      return next;
    }
    return undefined;
  };

  const releaseBuffered = (stream: StreamState) => {
    totalBuffered -= stream.buffered;
    stream.buffered = 0;
    stream.inbox.length = 0;
  };

  const sendCredit = (stream: StreamState) => {
    if (stream.terminal !== undefined || stream.remoteEnded) return;
    if (stream.pendingCredit < creditThreshold) return;
    const increment = stream.pendingCredit;
    stream.pendingCredit = 0;
    stream.granted += increment;
    pushControl({
      streamId: stream.id,
      type: MuxFrameType.Window,
      payload: encodeWindowPayload(increment),
    });
  };

  const failStream = (stream: StreamState, error: MuxStreamError, interrupt: boolean) => {
    if (stream.done) return;
    stream.done = true;
    stream.terminal = error;
    stream.outbox.length = 0;
    releaseBuffered(stream);
    streams.delete(stream.id);
    Deferred.doneUnsafe(stream.head, Effect.fail(error));
    wakeStream(stream);
    if (interrupt) stream.fiber?.interruptUnsafe();
  };

  const resetStream = (stream: StreamState, code: MuxResetCode, detail: string) => {
    if (stream.done) return;
    const peerKnowsStream = !stream.initiator || stream.framesWritten > 0;
    failStream(stream, new MuxStreamResetError({ code, detail, local: true }), false);
    // An OPEN still queued never reached the peer; a RESET for it would look like a protocol error.
    if (!peerKnowsStream) return;
    pushControl({
      streamId: stream.id,
      type: MuxFrameType.Reset,
      payload: encodeResetPayload(code, detail),
    });
  };

  const settle = (stream: StreamState) => {
    if (stream.done || !stream.localClosed || !stream.remoteEnded) return;
    stream.done = true;
    streams.delete(stream.id);
  };

  const terminate = (reason: MuxConnectionClosedError) => {
    if (closedReason !== undefined) return;
    closedReason = reason;
    for (const stream of streams.values()) failStream(stream, reason, true);
    control.length = 0;
    ready.length = 0;
    totalBuffered = 0;
    Deferred.doneUnsafe(closedSignal, Effect.succeed(reason));
    writerWaiters.wake();
  };

  const newStream = (id: number, initiator: boolean): StreamState => ({
    id,
    initiator,
    head: Deferred.makeUnsafe<MuxResponseHead, MuxStreamError>(),
    responded: false,
    localClosed: false,
    remoteEnded: false,
    terminal: undefined,
    done: false,
    draining: false,
    sendWindow: limits.streamWindowBytes,
    granted: limits.streamWindowBytes,
    pendingCredit: 0,
    buffered: 0,
    inbox: [],
    endChunk: undefined,
    outbox: [],
    inReady: false,
    framesWritten: 0,
    readWaiters: new Waiters(),
    sendWaiters: new Waiters(),
    fiber: undefined,
  });

  const stateError = (detail: string) => Effect.fail(new MuxStreamStateError({ detail }));

  const makeStream = (state: StreamState): MuxStream => {
    const read: MuxStream["read"] = Effect.gen(function* () {
      if (state.endChunk !== undefined) return state.endChunk;
      yield* state.readWaiters.waitUntil(
        () => state.terminal !== undefined || state.inbox.length > 0,
      );
      if (state.terminal !== undefined) return yield* state.terminal;
      const chunk = state.inbox.shift()!;
      if (chunk._tag === "End") {
        state.endChunk = chunk;
        return chunk;
      }
      totalBuffered -= chunk.bytes.length;
      state.buffered -= chunk.bytes.length;
      state.pendingCredit += chunk.bytes.length;
      sendCredit(state);
      return chunk;
    });

    const send: MuxStream["send"] = Effect.fnUntraced(function* (bytes) {
      if (!state.initiator && !state.responded) {
        return yield* stateError("Respond to the OPEN before sending.");
      }
      let offset = 0;
      while (offset < bytes.length) {
        // A frame goes out whole or not at all, so a buffer of one frame or less is never split.
        const length = Math.min(bytes.length - offset, MUX_DATA_CHUNK_BYTES);
        yield* state.sendWaiters.waitUntil(
          () => state.terminal !== undefined || state.localClosed || state.sendWindow >= length,
        );
        if (state.terminal !== undefined) return yield* state.terminal;
        if (state.localClosed) return yield* stateError("The stream is closed for sending.");
        state.sendWindow -= length;
        enqueue(state, {
          streamId: state.id,
          type: MuxFrameType.Data,
          payload: bytes.subarray(offset, offset + length),
        });
        offset += length;
      }
    });

    return {
      id: state.id,
      awaitResponse: state.initiator
        ? Deferred.await(state.head)
        : stateError("Only the opening side waits for a response."),
      respond: (head) =>
        Effect.suspend(() => {
          if (state.initiator) return stateError("Only the receiving side responds.");
          if (state.terminal !== undefined) return Effect.fail(state.terminal);
          if (state.responded) return stateError("The stream was already answered.");
          const payload = encodeMetadata({
            status: head.status,
            ...(head.statusText === undefined ? {} : { statusText: head.statusText }),
            headers: head.headers,
            ...(head.protocol === undefined ? {} : { protocol: head.protocol }),
          });
          if (payload === undefined) return stateError("The response head exceeds 16 KiB.");
          state.responded = true;
          enqueue(state, { streamId: state.id, type: MuxFrameType.Open, payload });
          return Effect.void;
        }),
      read,
      incoming: Stream.fromEffectRepeat(
        Effect.flatMap(read, (chunk) =>
          chunk._tag === "End" ? Cause.done() : Effect.succeed(chunk.bytes),
        ),
      ),
      send,
      close: (payload = new Uint8Array(0)) =>
        Effect.suspend(() => {
          if (state.terminal !== undefined) return Effect.fail(state.terminal);
          if (state.localClosed) return Effect.void;
          if (!state.initiator && !state.responded) {
            return stateError("Respond to the OPEN before closing.");
          }
          if (payload.length > MUX_MAX_PAYLOAD_BYTES)
            return stateError("The CLOSE payload exceeds 16 KiB.");
          state.localClosed = true;
          enqueue(state, { streamId: state.id, type: MuxFrameType.Close, payload });
          settle(state);
          state.sendWaiters.wake();
          return Effect.void;
        }),
      reset: (code = MuxResetCode.Cancel, detail = "") =>
        Effect.sync(() => resetStream(state, code, detail)),
    };
  };

  const finishHandler = Effect.fn("MuxSession.finishHandler")(function* (
    state: StreamState,
    exit: Exit.Exit<void, E>,
  ) {
    if (state.done) return;
    if (Exit.isFailure(exit)) {
      if (!Cause.hasInterruptsOnly(exit.cause)) {
        yield* Effect.logWarning("Mux handler failed", Cause.pretty(exit.cause));
      }
      resetStream(state, MuxResetCode.Internal, "The handler failed.");
      return;
    }
    if (!state.responded) {
      resetStream(state, MuxResetCode.Internal, "The handler finished without a response.");
      return;
    }
    if (!state.localClosed) {
      state.localClosed = true;
      enqueue(state, {
        streamId: state.id,
        type: MuxFrameType.Close,
        payload: new Uint8Array(0),
      });
    }
    if (!state.remoteEnded) {
      // The peer may still be sending a body nobody reads: take it and give the credit back.
      state.draining = true;
      state.pendingCredit += state.buffered;
      releaseBuffered(state);
      sendCredit(state);
    }
    settle(state);
  });

  const protocolError = (detail: string) => new MuxProtocolError({ detail });

  /** An id this side may legitimately have used, or that the peer may still have frames for. */
  const isStaleId = (id: number) => (ownsId(id) ? id < nextLocalId : id <= highestPeerId);

  const handleOpen = (frame: MuxFrame): MuxProtocolError | undefined => {
    const id = frame.streamId;
    if (ownsId(id)) {
      const stream = streams.get(id);
      if (stream === undefined) {
        return isStaleId(id) ? undefined : protocolError("OPEN answers a stream never opened.");
      }
      if (!stream.initiator || stream.responded) {
        resetStream(stream, MuxResetCode.Protocol, "Unexpected response head.");
        return undefined;
      }
      const head = decodeResponseHead(frame.payload);
      if (Result.isFailure(head)) {
        resetStream(stream, MuxResetCode.Protocol, head.failure.detail);
        return undefined;
      }
      stream.responded = true;
      Deferred.doneUnsafe(stream.head, Effect.succeed(head.success));
      return undefined;
    }
    if (id <= highestPeerId) return protocolError("Mux stream ids must increase.");
    highestPeerId = id;
    const refuse = (code: MuxResetCode, detail: string): undefined => {
      pushControl({
        streamId: id,
        type: MuxFrameType.Reset,
        payload: encodeResetPayload(code, detail),
      });
    };
    if (handler === undefined) return refuse(MuxResetCode.Refused, "This side takes no streams.");
    if (streams.size >= limits.maxStreams) {
      return refuse(MuxResetCode.Refused, "Too many concurrent streams.");
    }
    const decoded = decodeOpen(frame.payload);
    if (Result.isFailure(decoded)) return refuse(MuxResetCode.Protocol, decoded.failure.detail);
    const state = newStream(id, false);
    streams.set(id, state);
    const open = { ...decoded.success, headers: sanitizeForwardedHeaders(decoded.success.headers) };
    state.fiber = runFork(
      Effect.suspend(() => handler(open, makeStream(state))).pipe(
        Effect.exit,
        Effect.flatMap((exit) => finishHandler(state, exit)),
      ),
    );
    return undefined;
  };

  const handleFrame = (frame: MuxFrame): MuxProtocolError | undefined => {
    if (frame.type === MuxFrameType.Open) return handleOpen(frame);
    const stream = streams.get(frame.streamId);
    if (stream === undefined) {
      return isStaleId(frame.streamId)
        ? undefined
        : protocolError("Frame for a stream never opened.");
    }
    switch (frame.type) {
      case MuxFrameType.Data: {
        if (stream.initiator && !stream.responded) {
          resetStream(stream, MuxResetCode.Protocol, "DATA before the response head.");
          return undefined;
        }
        if (stream.remoteEnded) {
          resetStream(stream, MuxResetCode.Protocol, "DATA after CLOSE.");
          return undefined;
        }
        const length = frame.payload.length;
        if (length > stream.granted) {
          resetStream(stream, MuxResetCode.Protocol, "The stream window was exceeded.");
          return undefined;
        }
        if (!stream.draining && totalBuffered + length > limits.maxBufferedBytes) {
          resetStream(stream, MuxResetCode.Refused, "The connection's receive buffer is full.");
          return undefined;
        }
        stream.granted -= length;
        if (stream.draining) {
          stream.pendingCredit += length;
          sendCredit(stream);
          return undefined;
        }
        stream.buffered += length;
        totalBuffered += length;
        stream.inbox.push({ _tag: "Data", bytes: frame.payload });
        stream.readWaiters.wake();
        return undefined;
      }
      case MuxFrameType.Close: {
        if (stream.initiator && !stream.responded) {
          resetStream(stream, MuxResetCode.Protocol, "CLOSE before the response head.");
          return undefined;
        }
        if (stream.remoteEnded) {
          resetStream(stream, MuxResetCode.Protocol, "Duplicate CLOSE.");
          return undefined;
        }
        stream.remoteEnded = true;
        stream.inbox.push({ _tag: "End", payload: frame.payload });
        stream.readWaiters.wake();
        settle(stream);
        return undefined;
      }
      case MuxFrameType.Window: {
        const increment = decodeWindowPayload(frame.payload);
        if (stream.sendWindow + increment > MUX_MAX_WINDOW_BYTES) {
          resetStream(stream, MuxResetCode.Protocol, "The send window overflowed.");
          return undefined;
        }
        stream.sendWindow += increment;
        stream.sendWaiters.wake();
        return undefined;
      }
      case MuxFrameType.Reset: {
        const { code, detail } = decodeResetPayload(frame.payload);
        failStream(stream, new MuxStreamResetError({ code, detail, local: false }), true);
        return undefined;
      }
    }
    return undefined;
  };

  const readLoop = Effect.gen(function* () {
    while (true) {
      const batch = yield* reader.pull.pipe(
        Effect.mapError((error) => closedError(error, "The socket closed.")),
      );
      for (const message of batch) {
        if (!(message instanceof Uint8Array)) {
          const failure = protocolError("Text message on a mux socket.");
          return yield* closedError(failure, `Protocol error: ${failure.detail}`);
        }
        const frame = decodeFrame(message);
        const failure = Result.isFailure(frame) ? frame.failure : handleFrame(frame.success);
        if (failure !== undefined) {
          return yield* closedError(failure, `Protocol error: ${failure.detail}`);
        }
      }
    }
  });

  const writeLoop = Effect.gen(function* () {
    while (true) {
      const frame = nextFrame();
      if (frame === undefined) {
        yield* writerWaiters.waitUntil(() => control.length > 0 || ready.length > 0);
        continue;
      }
      yield* writer
        .write(frame)
        .pipe(Effect.mapError((error) => closedError(error, "The socket write failed.")));
    }
  });

  yield* Effect.raceFirst(readLoop, writeLoop).pipe(
    Effect.catch((error: MuxConnectionClosedError) =>
      Effect.sync(() => terminate(error)).pipe(
        Effect.andThen(
          isProtocolError(error.cause)
            ? writer.write(new Socket.CloseEvent(1002, "mux protocol error")).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() =>
      terminate(new MuxConnectionClosedError({ detail: "The mux session ended." })),
    ),
  );

  const session: MuxSession = {
    role,
    limits,
    open: (open) =>
      Effect.suspend((): ReturnType<MuxSession["open"]> => {
        if (closedReason !== undefined) return Effect.fail(closedReason);
        if (streams.size >= limits.maxStreams) {
          return Effect.fail(new MuxStreamLimitError({ limit: limits.maxStreams }));
        }
        if (nextLocalId > MUX_MAX_STREAM_ID) {
          return Effect.fail(new MuxStreamLimitError({ limit: MUX_MAX_STREAM_ID }));
        }
        const { kind, ...rest } = open;
        const payload = encodeMetadata({ kind, ...rest });
        if (payload === undefined) {
          return stateError("The request line and headers exceed 16 KiB.");
        }
        const state = newStream(nextLocalId, true);
        nextLocalId += 2;
        streams.set(state.id, state);
        enqueue(state, { streamId: state.id, type: MuxFrameType.Open, payload });
        return Effect.succeed(makeStream(state));
      }),
    closed: Deferred.await(closedSignal),
    stats: Effect.sync(() => ({
      activeStreams: streams.size,
      bufferedBytes: totalBuffered,
      queuedFrames: ready.reduce((sum, stream) => sum + stream.outbox.length, control.length),
    })),
  };
  return session;
});
