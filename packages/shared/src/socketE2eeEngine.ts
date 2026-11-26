import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import type { NonEmptyReadonlyArray } from "effect/Array";

import type { RelayGrant } from "./relay/grant.ts";
import type { E2eeDeviceIdentity } from "./socketE2eeDevice.ts";

import {
  type E2eeFailure,
  E2eeProtocolError,
  type E2eeRejectionReason,
} from "./socketE2eeRecord.ts";

/**
 * Runs a per-connection E2EE handshake over a `Socket` and then routes every
 * frame through the channel it produced. Protocol versions plug in a handshake.
 */

const E2EE_HANDSHAKE_TIMEOUT = "15 seconds";

/** Binary frames of the current connection, one at a time, during the handshake. */
export interface E2eeFrameSource {
  readonly next: Effect.Effect<Uint8Array, E2eeProtocolError | Socket.SocketError>;
}

export interface E2eeChannel {
  /** Called under the write lock, so it may send several records atomically. */
  readonly send: (
    writer: Socket.Writer,
    chunk: Uint8Array | string,
  ) => Effect.Effect<void, E2eeFailure>;
  /** May return no frames, for a fragment of a larger one. */
  readonly receive: (
    chunk: Uint8Array,
  ) => Effect.Effect<ReadonlyArray<Uint8Array | string>, E2eeFailure>;
  readonly sendClose?: (
    writer: Socket.Writer,
    reason: E2eeRejectionReason,
  ) => Effect.Effect<void, E2eeFailure>;
}

/**
 * What an established connection proved. `transcriptHash` (`th`) binds the pairing proof and the
 * confirmation code to this handshake. Only a v2 session whose confirm record carried a valid
 * device signature, accepted by the host, is `deviceAuthenticated`.
 */
export type E2eeSessionInfo = {
  readonly version: 1 | 2;
  readonly transcriptHash: Uint8Array;
} & (
  | {
      readonly deviceAuthenticated: false;
      readonly device: undefined;
      readonly grant: undefined;
    }
  | {
      readonly deviceAuthenticated: true;
      readonly device: E2eeDeviceIdentity;
      /** The relay grant the device presented, already verified by the host when required. */
      readonly grant: RelayGrant | undefined;
    }
);

export interface E2eeHandshakeResult {
  readonly channel: E2eeChannel;
  readonly info: E2eeSessionInfo;
  /** Runs after writers are released, for a verdict the peer sends back. */
  readonly confirm?: Effect.Effect<void, E2eeFailure> | undefined;
}

export type E2eeHandshake = (
  source: E2eeFrameSource,
  writer: Socket.Writer,
) => Effect.Effect<E2eeHandshakeResult, E2eeFailure>;

export interface E2eeSocket extends Socket.Socket {
  /**
   * The current connection's session, once its handshake (and, for clients, the host's verdict)
   * succeeded. The reader acquisition runs the handshake, so await this after acquiring it.
   */
  readonly sessionInfo: Effect.Effect<E2eeSessionInfo, Socket.SocketError>;
  /** Sends the protocol's authenticated close reason, when it has one, then closes. */
  readonly closeWithReason: (
    reason: E2eeRejectionReason,
  ) => Effect.Effect<void, Socket.SocketError>;
}

interface ActiveConnection {
  readonly channel: E2eeChannel;
}

const readError = (cause: unknown): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });

const writeError = (cause: unknown): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) });

/** Close code for a connection the E2EE layer refused (policy violation). */
const CLOSE_CODE_POLICY = 1008;

export const makeE2eeSocket = Effect.fn("socketE2ee.makeSocket")(function* (
  socket: Socket.Socket,
  handshake: E2eeHandshake,
  options: { readonly mapReceiveError: (error: E2eeFailure) => E2eeFailure },
) {
  // The deferred for the connection a writer may send on. Each reader
  // acquisition claims the pending deferred (or a fresh one) before the
  // handshake and resolves it on completion, so a writer either sends on the
  // live session or waits for the next handshake.
  const tickets = yield* Ref.make<Deferred.Deferred<ActiveConnection, Socket.SocketError>>(
    yield* Deferred.make<ActiveConnection, Socket.SocketError>(),
  );
  const writeLock = Semaphore.makeUnsafe(1);
  // Resolved only after the peer's verdict, unlike the ticket, which releases writers earlier.
  const sessions = yield* Ref.make(yield* Deferred.make<E2eeSessionInfo, Socket.SocketError>());

  // The writer is acquired independently of the reader, so it sends only once
  // the current connection's handshake is done. A write that races a reconnect
  // may carry the old session's keys onto the new connection, which the peer
  // rejects, closing the socket and triggering a fresh reconnect.
  const writerLoop = (
    writer: Socket.Writer,
    chunk: Uint8Array | string | Socket.CloseEvent,
  ): Effect.Effect<void, Socket.SocketError> => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      return writer.write(chunk);
    }
    // Counter assignment, encryption and the write must be one atomic step:
    // concurrent writers would otherwise reorder records or stamp the wrong counter.
    const send = Effect.flatMap(Ref.get(tickets), (ticket) =>
      Effect.flatMap(Deferred.await(ticket), (connection) =>
        writeLock.withPermit(connection.channel.send(writer, chunk)),
      ),
    );
    return Effect.mapError(send, writeError);
  };

  /** When this connection's scope closes, make later writers wait for the next handshake. */
  const retireTicket = (ticket: Deferred.Deferred<ActiveConnection, Socket.SocketError>) =>
    Ref.modify(tickets, (current) => {
      const next =
        current === ticket ? Deferred.makeUnsafe<ActiveConnection, Socket.SocketError>() : current;
      return [undefined, next] as const;
    }).pipe(Effect.asVoid);

  /**
   * The deferred this connection resolves: the pending one if it is still open, so writers and
   * session readers that arrived before the reader are served by this handshake.
   */
  const claimPending = <A>(ref: Ref.Ref<Deferred.Deferred<A, Socket.SocketError>>) =>
    Ref.modify(ref, (current) => {
      const next = Deferred.isDoneUnsafe(current)
        ? Deferred.makeUnsafe<A, Socket.SocketError>()
        : current;
      return [next, next] as const;
    });

  const retireSession = (session: Deferred.Deferred<E2eeSessionInfo, Socket.SocketError>) =>
    Ref.update(sessions, (current) =>
      current === session ? Deferred.makeUnsafe<E2eeSessionInfo, Socket.SocketError>() : current,
    );

  /** Copies, so a caller that mutates the bytes cannot change what the next caller reads. */
  const sessionInfo = Effect.flatMap(Ref.get(sessions), Deferred.await).pipe(
    Effect.map((info): E2eeSessionInfo =>
      info.deviceAuthenticated
        ? {
            ...info,
            transcriptHash: Uint8Array.from(info.transcriptHash),
            device: { ...info.device, publicKey: Uint8Array.from(info.device.publicKey) },
          }
        : { ...info, transcriptHash: Uint8Array.from(info.transcriptHash) },
    ),
  );

  const makeSource = (reader: Socket.Reader) => {
    const buffered: Array<Uint8Array | string> = [];
    const source: E2eeFrameSource = {
      next: Effect.gen(function* () {
        if (buffered.length === 0) buffered.push(...(yield* reader.pull));
        const frame = buffered.shift();
        if (!(frame instanceof Uint8Array)) {
          return yield* new E2eeProtocolError({
            detail: "Unexpected frame during the E2EE handshake.",
          });
        }
        return frame;
      }),
    };
    return { source, buffered };
  };

  const closeWithReason = (reason: E2eeRejectionReason): Effect.Effect<void, Socket.SocketError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const ticket = yield* Ref.get(tickets);
        const connection = yield* Effect.exit(Deferred.await(ticket));
        if (Exit.isSuccess(connection)) {
          const sendClose = connection.value.channel.sendClose;
          if (sendClose !== undefined) {
            yield* writeLock.withPermit(sendClose(writer, reason));
          }
        }
        yield* writer.write(new Socket.CloseEvent(CLOSE_CODE_POLICY));
      }),
    ).pipe(Effect.mapError(writeError));

  const wrapped = Socket.make({
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const ticket = yield* claimPending(tickets);
      const session = yield* claimPending(sessions);
      const { source, buffered } = makeSource(reader);
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const result = yield* handshake(source, writer);
          yield* Deferred.succeed(ticket, { channel: result.channel });
          if (result.confirm !== undefined) yield* result.confirm;
          yield* Deferred.succeed(session, result.info);
          return result.channel;
        }).pipe(
          Effect.timeout(E2EE_HANDSHAKE_TIMEOUT),
          Effect.catchIf(
            Cause.isTimeoutError,
            () => new E2eeProtocolError({ detail: "The E2EE handshake timed out." }),
          ),
        ),
      );
      if (Exit.isFailure(outcome)) {
        const failure = Cause.findErrorOption(outcome.cause);
        // Interruption or a defect: no typed failure to report, so propagate it as is.
        if (Option.isNone(failure))
          return yield* Effect.failCause(outcome.cause as Cause.Cause<never>);
        const socketError = readError(failure.value);
        yield* retireTicket(ticket);
        yield* Deferred.fail(ticket, socketError);
        yield* retireSession(session);
        yield* Deferred.fail(session, socketError);
        return yield* socketError;
      }
      const channel = outcome.value;
      yield* Effect.addFinalizer(() =>
        Effect.andThen(retireTicket(ticket), retireSession(session)),
      );
      const receiveChunk = (chunk: Uint8Array | string) =>
        typeof chunk === "string"
          ? Effect.fail(
              readError(
                new E2eeProtocolError({ detail: "A plaintext frame arrived on an E2EE socket." }),
              ),
            )
          : Effect.mapError(channel.receive(chunk), (error) =>
              readError(options.mapReceiveError(error)),
            );
      const pull: Effect.Effect<
        NonEmptyReadonlyArray<Uint8Array | string>,
        Socket.SocketError
      > = Effect.gen(function* () {
        while (true) {
          const batch = buffered.length > 0 ? buffered.splice(0) : yield* reader.pull;
          const frames = (yield* Effect.forEach(batch, receiveChunk)).flat();
          if (frames.length > 0)
            return frames as unknown as NonEmptyReadonlyArray<Uint8Array | string>;
        }
      });
      return { upgrade: reader.upgrade, pull } satisfies Socket.Reader;
    }),
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) => writerLoop(writer, chunk),
      writeAll: (chunks) =>
        Effect.forEach(chunks, (chunk) => writerLoop(writer, chunk), { discard: true }),
    })),
  });
  return Object.assign(wrapped, { closeWithReason, sessionInfo }) satisfies E2eeSocket;
});
