import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Socket from "effect/socket/Socket";

import {
  decodeFrame,
  decodeResetPayload,
  decodeWindowPayload,
  encodeFrame,
  encodeWindowPayload,
  MUX_DATA_CHUNK_BYTES,
  type MuxFrame,
  MuxFrameType,
} from "./frame.ts";
import {
  MuxConnectionClosedError,
  MuxProtocolError,
  MuxResetCode,
  type MuxStreamError,
  MuxStreamLimitError,
} from "./errors.ts";
import { makeMemorySocketPair } from "./memorySocket.ts";
import { type MuxHandler, type MuxLimits, makeMuxSession } from "./session.ts";

const WINDOW = 256 * 1024;
const encoder = new TextEncoder();
const isProtocolError = Schema.is(MuxProtocolError);

const openFrame = (streamId: number, kind: "http" | "ws" = "http"): MuxFrame => ({
  streamId,
  type: MuxFrameType.Open,
  payload: encoder.encode(
    JSON.stringify(
      kind === "http"
        ? { kind, method: "POST", path: "/upload", headers: [] }
        : { kind, path: "/ws", headers: [], protocols: [] },
    ),
  ),
});

const dataFrame = (streamId: number, length = MUX_DATA_CHUNK_BYTES): MuxFrame => ({
  streamId,
  type: MuxFrameType.Data,
  payload: new Uint8Array(length).fill(1),
});

/** The other end of a session, driven by hand. */
interface Peer {
  readonly read: Effect.Effect<MuxFrame>;
  readonly readType: (type: MuxFrame["type"]) => Effect.Effect<MuxFrame>;
  readonly write: (frame: MuxFrame) => Effect.Effect<void>;
  readonly writeRaw: (chunk: Uint8Array | string) => Effect.Effect<void>;
}

const makeRawPeer = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const buffered: Array<Uint8Array | string> = [];
    const nextChunk = Effect.gen(function* () {
      while (buffered.length === 0) buffered.push(...(yield* reader.pull));
      return buffered.shift()!;
    }).pipe(Effect.orDie);
    const read: Effect.Effect<MuxFrame> = Effect.gen(function* () {
      const chunk = yield* nextChunk;
      assert.instanceOf(chunk, Uint8Array);
      const frame = decodeFrame(chunk as Uint8Array);
      assert.isTrue(Result.isSuccess(frame));
      return (frame as Result.Success<MuxFrame, MuxProtocolError>).success;
    });
    const readType = (type: MuxFrame["type"]) =>
      Effect.gen(function* () {
        while (true) {
          const frame = yield* read;
          if (frame.type === type) return frame;
        }
      });
    const peer: Peer = {
      read,
      readType,
      write: (frame: MuxFrame) => Effect.orDie(writer.write(encodeFrame(frame))),
      writeRaw: (chunk: Uint8Array | string) => Effect.orDie(writer.write(chunk)),
    };
    return peer;
  });

const startHost = (handler: MuxHandler<MuxStreamError>, limits?: Partial<MuxLimits>) =>
  Effect.gen(function* () {
    const pair = yield* makeMemorySocketPair();
    const session = yield* makeMuxSession({ socket: pair.a, role: "host", handler, limits });
    const peer = yield* makeRawPeer(pair.b);
    return { pair, session, peer };
  });

const respondOk: MuxHandler<MuxStreamError> = (_open, stream) =>
  Effect.andThen(stream.respond({ status: 200, headers: [] }), stream.close());

const violations: ReadonlyArray<readonly [string, () => Uint8Array | string, string]> = [
  ["a frame cut off inside its header", () => new Uint8Array([0, 0, 0, 1, 2]), "Truncated"],
  ["an unknown frame type", () => new Uint8Array([0, 0, 0, 1, 99, 0, 0, 0, 0]), "Unknown"],
  ["a text message", () => "hello", "Text message"],
  ["a DATA frame for a stream nobody opened", () => encodeFrame(dataFrame(7, 4)), "never opened"],
  ["an OPEN with the host's id parity", () => encodeFrame(openFrame(2)), "never opened"],
];

describe("mux session", () => {
  it.effect(
    "sends one frame per stream in turn, so a small message waits for one frame of a bulk transfer",
    () =>
      Effect.gen(function* () {
        const gate = Semaphore.makeUnsafe(0);
        const pair = yield* makeMemorySocketPair({
          beforeWriteFromA: () => Semaphore.take(gate, 1),
        });
        const client = yield* makeMuxSession({ socket: pair.a, role: "client" });
        const peer = yield* makeRawPeer(pair.b);

        const bulk = yield* client.open({ kind: "http", method: "PUT", path: "/big", headers: [] });
        const small = yield* client.open({ kind: "ws", path: "/ws", headers: [], protocols: [] });
        // Exactly one window: all of it is queued behind the held socket write.
        yield* bulk.send(new Uint8Array(WINDOW));
        yield* small.send(new Uint8Array([3, 1, 2, 3]));
        yield* Semaphore.release(gate, 1000);

        const seen: Array<MuxFrame> = [];
        while (
          !seen.some((frame) => frame.streamId === small.id && frame.type === MuxFrameType.Data)
        ) {
          seen.push(yield* peer.read);
        }
        const smallAt = seen.findIndex(
          (frame) => frame.streamId === small.id && frame.type === MuxFrameType.Data,
        );
        assert.isAtMost(smallAt, 4, "the small message must not wait for the bulk backlog");
        const remaining =
          Math.ceil(WINDOW / MUX_DATA_CHUNK_BYTES) -
          seen.filter((f) => f.streamId === bulk.id && f.type === MuxFrameType.Data).length;
        assert.isAtLeast(remaining, 10, "the bulk transfer was still mostly queued");
      }),
  );

  it.effect("stops at the window and sends exactly the credit it is given", () =>
    Effect.gen(function* () {
      const pair = yield* makeMemorySocketPair();
      const client = yield* makeMuxSession({ socket: pair.a, role: "client" });
      const peer = yield* makeRawPeer(pair.b);
      const stream = yield* client.open({ kind: "http", method: "PUT", path: "/", headers: [] });
      const sender = yield* Effect.forkChild(stream.send(new Uint8Array(WINDOW + 1000)));

      let received = 0;
      while (received < WINDOW) {
        const frame = yield* peer.readType(MuxFrameType.Data);
        received += frame.payload.length;
      }
      assert.equal(received, WINDOW);

      yield* peer.write({
        streamId: stream.id,
        type: MuxFrameType.Window,
        payload: encodeWindowPayload(500),
      });
      const next = yield* peer.readType(MuxFrameType.Data);
      assert.equal(next.payload.length, 500);

      yield* peer.write({
        streamId: stream.id,
        type: MuxFrameType.Window,
        payload: encodeWindowPayload(500),
      });
      yield* Fiber.join(sender);
      const last = yield* peer.readType(MuxFrameType.Data);
      assert.equal(last.payload.length, 500);
    }),
  );

  it.effect("returns credit when the consumer reads, not when data arrives", () =>
    Effect.gen(function* () {
      const reads = 9;
      const release = yield* Deferred.make<void>();
      const { peer } = yield* startHost((_open, stream) =>
        Effect.gen(function* () {
          yield* stream.respond({ status: 200, headers: [] });
          for (let i = 0; i < reads; i += 1) yield* stream.read;
          yield* Deferred.await(release);
        }),
      );
      yield* peer.write(openFrame(1));
      for (let i = 0; i < WINDOW / MUX_DATA_CHUNK_BYTES - 1; i += 1)
        yield* peer.write(dataFrame(1));
      const credit = yield* peer.readType(MuxFrameType.Window);
      assert.equal(decodeWindowPayload(credit.payload), reads * MUX_DATA_CHUNK_BYTES);
    }),
  );

  it.effect("drains a body nobody reads once the handler is done, and frees the stream", () =>
    Effect.gen(function* () {
      const { peer } = yield* startHost(respondOk, { maxStreams: 1 });
      yield* peer.write(openFrame(1));
      yield* peer.readType(MuxFrameType.Open);
      for (let i = 0; i < 10; i += 1) yield* peer.write(dataFrame(1));
      const credit = yield* peer.readType(MuxFrameType.Window);
      assert.isAtLeast(decodeWindowPayload(credit.payload), WINDOW / 2);
      yield* peer.write({ streamId: 1, type: MuxFrameType.Close, payload: new Uint8Array(0) });

      // The slot is free again: a second stream is served, not refused.
      yield* peer.write(openFrame(3));
      const frame = yield* peer.readType(MuxFrameType.Open);
      assert.equal(frame.streamId, 3);
    }),
  );

  it.effect("resets a stream that sends past its window and releases what it buffered", () =>
    Effect.gen(function* () {
      const { peer, session } = yield* startHost((_open, stream) =>
        Effect.andThen(stream.respond({ status: 200, headers: [] }), Effect.never),
      );
      yield* peer.write(openFrame(1));
      const frames = Math.floor(WINDOW / MUX_DATA_CHUNK_BYTES);
      for (let i = 0; i <= frames; i += 1) yield* peer.write(dataFrame(1));
      const reset = yield* peer.readType(MuxFrameType.Reset);
      assert.equal(decodeResetPayload(reset.payload).code, MuxResetCode.Protocol);
      const stats = yield* session.stats;
      assert.equal(stats.bufferedBytes, 0);
      assert.equal(stats.activeStreams, 0);
    }),
  );

  it.effect("refuses a stream whose data would pass the connection's unread-byte limit", () =>
    Effect.gen(function* () {
      const { peer, session } = yield* startHost(
        (_open, stream) =>
          Effect.andThen(stream.respond({ status: 200, headers: [] }), Effect.never),
        { streamWindowBytes: 32768, maxBufferedBytes: 40_000, maxStreams: 8 },
      );
      yield* peer.write(openFrame(1));
      yield* peer.write(dataFrame(1));
      yield* peer.write(dataFrame(1));
      yield* peer.write(openFrame(3));
      yield* peer.write(dataFrame(3));
      const reset = yield* peer.readType(MuxFrameType.Reset);
      assert.equal(reset.streamId, 3);
      assert.equal(decodeResetPayload(reset.payload).code, MuxResetCode.Refused);
      assert.equal((yield* session.stats).bufferedBytes, 2 * MUX_DATA_CHUNK_BYTES);
    }),
  );

  it.effect("rejects local opens past the stream limit and refuses the peer's", () =>
    Effect.gen(function* () {
      const pair = yield* makeMemorySocketPair();
      const client = yield* makeMuxSession({
        socket: pair.a,
        role: "client",
        limits: { maxStreams: 2 },
      });
      const meta = { kind: "http", method: "GET", path: "/", headers: [] } as const;
      const first = yield* client.open(meta);
      yield* client.open(meta);
      const refused = yield* Effect.flip(client.open(meta));
      assert.instanceOf(refused, MuxStreamLimitError);
      yield* first.reset();
      assert.equal(first.id, 1);
      yield* client.open(meta);

      const { peer } = yield* startHost(respondOk, { maxStreams: 1 });
      yield* peer.write(openFrame(1));
      yield* peer.write(openFrame(3));
      const reset = yield* peer.readType(MuxFrameType.Reset);
      assert.equal(reset.streamId, 3);
      assert.equal(decodeResetPayload(reset.payload).code, MuxResetCode.Refused);
    }),
  );

  it.effect("ends every stream with an error when the socket closes", () =>
    Effect.gen(function* () {
      const pair = yield* makeMemorySocketPair();
      const client = yield* makeMuxSession({ socket: pair.a, role: "client" });
      const meta = { kind: "http", method: "GET", path: "/", headers: [] } as const;
      const waiting = yield* client.open(meta);
      const reading = yield* client.open(meta);
      const full = yield* client.open(meta);
      const failures = yield* Effect.forkChild(
        Effect.all([
          Effect.flip(waiting.awaitResponse),
          Effect.flip(reading.read),
          Effect.flip(full.send(new Uint8Array(WINDOW * 2))),
        ]),
      );
      yield* pair.drop;
      for (const failure of yield* Fiber.join(failures)) {
        assert.instanceOf(failure, MuxConnectionClosedError);
      }
      assert.instanceOf(yield* client.closed, MuxConnectionClosedError);
      assert.instanceOf(yield* Effect.flip(client.open(meta)), MuxConnectionClosedError);
      assert.equal((yield* client.stats).activeStreams, 0);
    }),
  );

  it.effect.each(violations)("ends the connection on %s", ([, bytes, detail]) =>
    Effect.gen(function* () {
      const { peer, session } = yield* startHost(respondOk);
      yield* peer.write(openFrame(1));
      yield* peer.writeRaw(bytes());
      const reason = yield* session.closed;
      assert.isTrue(isProtocolError(reason.cause));
      assert.include(reason.message, detail);
    }),
  );

  it.effect("ends the connection when stream ids do not increase", () =>
    Effect.gen(function* () {
      const { peer, session } = yield* startHost(respondOk);
      yield* peer.write(openFrame(3));
      yield* peer.write(openFrame(1));
      assert.include((yield* session.closed).message, "must increase");
    }),
  );

  it.effect.each([
    [
      "the peer resets its stream",
      (peer: Peer) =>
        peer.write({
          streamId: 1,
          type: MuxFrameType.Reset,
          payload: new Uint8Array([0, 0, 0, 1]),
        }),
    ],
    ["the connection drops", (_peer: Peer, drop: Effect.Effect<void>) => drop],
  ] as const)("interrupts a running handler when %s", ([, end]) =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<number>();
      const { peer, pair } = yield* startHost((_open, stream) =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, stream.id))),
      );
      yield* peer.write(openFrame(1));
      yield* end(peer, pair.drop);
      assert.equal(yield* Deferred.await(interrupted), 1);
    }),
  );
});
