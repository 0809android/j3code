import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeMuxClient } from "./client.ts";
import { MuxConnectionClosedError, type MuxStreamError, MuxStreamLimitError } from "./errors.ts";
import { makeMuxFetch } from "./fetch.ts";
import { MUX_DATA_CHUNK_BYTES } from "./frame.ts";
import { makeMuxHandler, makeMuxHost, serveHttp, serveWebSocket } from "./host.ts";
import { makeMemorySocketPair } from "./memorySocket.ts";
import type { MuxLimits } from "./session.ts";
import { makeMuxWebSocket, type MuxWebSocketInstance } from "./websocket.ts";

const WINDOW = 256 * 1024;

/** What a test wants to observe on the host, created per test. */
const makeProbe = Effect.gen(function* () {
  return {
    started: yield* Deferred.make<void>(),
    interrupted: yield* Deferred.make<string>(),
    wsClosedByPeer: yield* Deferred.make<{ code: number; reason: string }>(),
    release: yield* Deferred.make<void>(),
  };
});
type Probe = Effect.Success<typeof makeProbe>;

const pattern = (length: number, offset = 0) =>
  Uint8Array.from({ length }, (_, index) => (offset + index) % 251);

const chunked = (total: number, chunkBytes: number): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = [];
  for (let offset = 0; offset < total; offset += chunkBytes) {
    chunks.push(pattern(Math.min(chunkBytes, total - offset), offset));
  }
  return chunks;
};

const readAll = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Effect.map(Stream.runCollect(body), (chunks) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  });

type HostFailure = MuxStreamError | string;

const hostHandler = (probe: Probe) =>
  makeMuxHandler({
    http: serveHttp<HostFailure, never>((request) => {
      const url = new URL(request.path, "http://mux.invalid");
      const interruptedBy = (name: string) =>
        Effect.onInterrupt(() => Deferred.succeed(probe.interrupted, name));
      switch (url.pathname) {
        case "/echo":
          return Effect.succeed({
            status: 200,
            headers: [["content-type", "application/octet-stream"]],
            body: request.body,
          });
        case "/headers":
          return Effect.succeed({
            status: 200,
            statusText: "Fine",
            headers: [["x-method", request.method]],
            body: JSON.stringify(request.headers),
          });
        case "/big":
          return Effect.succeed({
            status: 200,
            headers: [],
            body: Stream.fromIterable(chunked(Number(url.searchParams.get("size")), 65536)),
          });
        case "/204":
          return Effect.succeed({ status: 204, headers: [] });
        case "/hang":
          return Effect.succeed({
            status: 200,
            headers: [],
            body: Stream.fromIterable([pattern(10)]).pipe(
              Stream.concat(Stream.fromEffect(Effect.never)),
              Stream.onExit((exit) =>
                exit._tag === "Failure" ? Deferred.succeed(probe.interrupted, "body") : Effect.void,
              ),
            ),
          });
        case "/slow-head":
          return Deferred.succeed(probe.started, undefined).pipe(
            Effect.andThen(Effect.never),
            interruptedBy("head"),
          );
        case "/fail":
          return Effect.fail("boom");
        case "/fail-mid-body":
          return Effect.succeed({
            status: 200,
            headers: [],
            body: Stream.fromIterable([pattern(10)]).pipe(
              Stream.concat(Stream.fromEffect(Effect.fail("boom"))),
            ),
          });
        case "/stall":
          return Effect.gen(function* () {
            yield* Stream.runForEachArray(Stream.take(request.body, 1), () => Effect.void);
            yield* Deferred.await(probe.release);
            const rest = yield* readAll(request.body);
            return { status: 200, headers: [], body: String(rest.length) };
          });
        default:
          return Effect.succeed({ status: 404, headers: [], body: "missing" });
      }
    }),
    ws: serveWebSocket<HostFailure, never>((request) =>
      Effect.gen(function* () {
        switch (request.path) {
          case "/ws/echo": {
            const channel = yield* request.accept();
            yield* Stream.runForEach(channel.messages, channel.send);
            return;
          }
          case "/ws/protocol": {
            const channel = yield* request.accept(request.protocols[0]);
            yield* channel.send(`protocol:${request.protocols[0]}`);
            return;
          }
          case "/ws/peer-close": {
            const channel = yield* request.accept();
            yield* Stream.runDrain(channel.messages);
            const code = channel.peerCloseCode() ?? 0;
            yield* Deferred.succeed(probe.wsClosedByPeer, { code, reason: "" });
            return;
          }
          case "/ws/close-4000": {
            const channel = yield* request.accept();
            yield* channel.close(4000, "server says");
            return yield* Effect.never;
          }
          case "/ws/fail": {
            yield* request.accept();
            return yield* Effect.fail("boom");
          }
          case "/ws/silent": {
            yield* request.accept();
            return yield* Effect.never;
          }
          default:
            return yield* request.reject(401, { body: "no" });
        }
      }),
    ),
  });

const start = (probe: Probe, limits?: Partial<MuxLimits>) =>
  Effect.gen(function* () {
    const pair = yield* makeMemorySocketPair();
    yield* makeMuxHost({ socket: pair.b, handler: hostHandler(probe) });
    const client = yield* makeMuxClient({ socket: pair.a, limits });
    return {
      pair,
      client,
      fetch: makeMuxFetch(client),
      WebSocket: makeMuxWebSocket(client),
    };
  });

interface Observed {
  readonly type: string;
  readonly data?: unknown;
  readonly code?: number | undefined;
  readonly reason?: string | undefined;
  readonly wasClean?: boolean | undefined;
}

const watch = Effect.fn("watch")(function* (ws: MuxWebSocketInstance) {
  const log = yield* Queue.unbounded<Observed>();
  for (const type of ["open", "message", "error", "close"] as const) {
    ws.addEventListener(type, (event) =>
      Queue.offerUnsafe(log, {
        type,
        data: event.data,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      }),
    );
  }
  return log;
});

const expectEvent = Effect.fn("expectEvent")(function* (log: Queue.Queue<Observed>, type: string) {
  const event = yield* Queue.take(log);
  assert.equal(event.type, type);
  return event;
});

const checkPattern = (bytes: Uint8Array, length: number) => {
  assert.equal(bytes.length, length);
  assert.isTrue(bytes.every((byte, index) => byte === index % 251));
};

const streamingBody = (total: number, onPull?: (bytes: number) => void) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = pattern(Math.min(65536, total - sent), sent);
      sent += chunk.length;
      onPull?.(sent);
      controller.enqueue(chunk);
      if (sent >= total) controller.close();
    },
  });
};

const makeController = () => new AbortController();

const post = (body: BodyInit): RequestInit =>
  ({ method: "POST", body, duplex: "half" }) as RequestInit;

describe("mux fetch", () => {
  it.effect("returns status, headers and body, and hides forwarding headers from the host", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const response = yield* Effect.promise(() =>
        fetch("/headers?a=1", {
          method: "PUT",
          headers: {
            "x-custom": "kept",
            "X-Forwarded-For": "6.6.6.6",
            "cf-connecting-ip": "6.6.6.6",
          },
          body: "x",
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.statusText, "Fine");
      assert.equal(response.headers.get("x-method"), "PUT");
      const seen = (yield* Effect.promise(() => response.json())) as Array<[string, string]>;
      assert.isTrue(seen.some(([name, value]) => name === "x-custom" && value === "kept"));
      assert.isFalse(seen.some(([name]) => name === "x-forwarded-for" || name.startsWith("cf-")));
    }),
  );

  it.effect("handles empty bodies and no-body statuses", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const empty = yield* Effect.promise(() => fetch("/204"));
      assert.equal(empty.status, 204);
      assert.isNull(empty.body);
      const missing = yield* Effect.promise(() => fetch("/nope"));
      assert.equal(missing.status, 404);
      assert.equal(yield* Effect.promise(() => missing.text()), "missing");
    }),
  );

  it.effect("echoes binary request bodies byte for byte", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const bytes = pattern(100_000);
      const response = yield* Effect.promise(() => fetch("/echo", post(bytes)));
      const echoed = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
      checkPattern(echoed, bytes.length);
    }),
  );

  it.effect("takes a stream body as is, pulling it only as the window allows", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const size = 1024 * 1024;
      let pulled = 0;
      // No `duplex`: the stream never goes into a `Request`, which WebKit and React Native refuse.
      const echoed = yield* Effect.promise(async () => {
        const response = await fetch("/echo", {
          method: "POST",
          body: streamingBody(size, (bytes) => {
            pulled = bytes;
          }),
        });
        return new Uint8Array(await response.arrayBuffer());
      });
      checkPattern(echoed, size);
      assert.equal(pulled, size);
    }),
  );

  it.effect("streams large bodies in both directions through the flow-control window", () =>
    Effect.gen(function* () {
      const { fetch, client } = yield* start(yield* makeProbe);
      const size = 8 * 1024 * 1024;
      const echoed = yield* Effect.promise(async () => {
        const response = await fetch("/echo", post(streamingBody(size)));
        return new Uint8Array(await response.arrayBuffer());
      });
      checkPattern(echoed, size);
      const download = yield* Effect.promise(async () => {
        const response = await fetch(`/big?size=${size}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      checkPattern(download, size);
      assert.equal((yield* client.stats).bufferedBytes, 0);
    }),
  );

  it.effect("aborting a response body resets the stream and stops the host", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { fetch } = yield* start(probe);
      const controller = makeController();
      const response = yield* Effect.promise(() => fetch("/hang", { signal: controller.signal }));
      const reader = response.body!.getReader();
      yield* Effect.promise(() => reader.read());
      const pending = yield* Effect.promise(async () => {
        const read = reader.read().catch((error: unknown) => error);
        controller.abort();
        return read;
      });
      assert.equal((pending as DOMException).name, "AbortError");
      assert.equal(yield* Deferred.await(probe.interrupted), "body");
    }),
  );

  it.effect("aborting before the response head rejects and stops the host", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { fetch } = yield* start(probe);
      const controller = makeController();
      const request = yield* Effect.sync(() =>
        fetch("/slow-head", { signal: controller.signal }).catch((error: unknown) => error),
      );
      yield* Deferred.await(probe.started);
      controller.abort(new Error("stop"));
      assert.equal(((yield* Effect.promise(() => request)) as Error).message, "stop");
      assert.equal(yield* Deferred.await(probe.interrupted), "head");

      const done = makeController();
      done.abort();
      const early = yield* Effect.promise(() =>
        fetch("/echo", { signal: done.signal }).catch((error: unknown) => error),
      );
      assert.equal((early as DOMException).name, "AbortError");
    }),
  );

  it.effect("aborting in the same tick as the call leaves the connection healthy", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const controller = makeController();
      const early = yield* Effect.promise(() => {
        const request = fetch("/echo", { signal: controller.signal }).catch(
          (error: unknown) => error,
        );
        controller.abort();
        return request;
      });
      assert.equal((early as DOMException).name, "AbortError");
      const next = yield* Effect.promise(() => fetch("/echo", post("still works")));
      assert.equal(yield* Effect.promise(() => next.text()), "still works");
    }),
  );

  it.effect("cancelling the body stream tells the host to stop", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { fetch } = yield* start(probe);
      const response = yield* Effect.promise(() => fetch("/hang"));
      yield* Effect.promise(() => response.body!.cancel());
      assert.equal(yield* Deferred.await(probe.interrupted), "body");
    }),
  );

  it.effect("turns a host failure into a network error, before or during the body", () =>
    Effect.gen(function* () {
      const { fetch } = yield* start(yield* makeProbe);
      const early = yield* Effect.promise(() => fetch("/fail").catch((error: unknown) => error));
      assert.instanceOf(early, TypeError);
      const response = yield* Effect.promise(() => fetch("/fail-mid-body"));
      const late = yield* Effect.promise(() =>
        response.arrayBuffer().catch((error: unknown) => error),
      );
      assert.instanceOf(late, TypeError);
    }),
  );

  it.effect("rejects requests past the stream limit", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { fetch } = yield* start(probe, { maxStreams: 1 });
      const first = yield* Effect.promise(() => fetch("/hang"));
      const second = yield* Effect.promise(() => fetch("/echo").catch((error: unknown) => error));
      assert.instanceOf(second, TypeError);
      assert.instanceOf((second as TypeError).cause, MuxStreamLimitError);
      yield* Effect.promise(() => first.body!.cancel());
    }),
  );

  it.effect("fails an in-flight request when the link drops, and every request after it", () =>
    Effect.gen(function* () {
      const { fetch, pair } = yield* start(yield* makeProbe);
      const response = yield* Effect.promise(() => fetch("/hang"));
      yield* pair.drop;
      const failure = yield* Effect.promise(() =>
        response.arrayBuffer().catch((error: unknown) => error),
      );
      assert.instanceOf(failure, TypeError);
      assert.instanceOf((failure as TypeError).cause, MuxConnectionClosedError);
      const next = yield* Effect.promise(() => fetch("/echo").catch((error: unknown) => error));
      assert.instanceOf(next, TypeError);
    }),
  );
});

describe("mux WebSocket", () => {
  it.effect("echoes text and binary messages in order, with the browser's event sequence", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/echo");
      ws.binaryType = "arraybuffer";
      const log = yield* watch(ws);
      assert.equal(ws.readyState, 0);
      yield* expectEvent(log, "open");
      assert.equal(ws.readyState, 1);

      ws.send("héllo");
      ws.send(pattern(300));
      ws.send(new Uint8Array([]));
      ws.send("");
      assert.equal((yield* expectEvent(log, "message")).data, "héllo");
      checkPattern(new Uint8Array((yield* expectEvent(log, "message")).data as ArrayBuffer), 300);
      assert.equal(((yield* expectEvent(log, "message")).data as ArrayBuffer).byteLength, 0);
      assert.equal((yield* expectEvent(log, "message")).data, "");

      ws.close(1000, "done");
      assert.equal(ws.readyState, 2);
      const closed = yield* expectEvent(log, "close");
      assert.deepStrictEqual([closed.code, closed.wasClean, ws.readyState], [1000, true, 3]);
    }),
  );

  it.effect("splits large messages into frames and puts them back together", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/echo");
      ws.binaryType = "arraybuffer";
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      const size = 3 * 1024 * 1024;
      ws.send(pattern(size));
      ws.send("x".repeat(500_000));
      checkPattern(new Uint8Array((yield* expectEvent(log, "message")).data as ArrayBuffer), size);
      assert.equal(((yield* expectEvent(log, "message")).data as string).length, 500_000);
      ws.close();
    }),
  );

  it.effect("negotiates a subprotocol and rejects an invalid constructor argument", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/protocol", ["v1.k3", "v2"]);
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      assert.equal(ws.protocol, "v1.k3");
      assert.equal((yield* expectEvent(log, "message")).data, "protocol:v1.k3");
      assert.throws(() => new WebSocket("/ws/protocol", ["bad protocol"]), /Invalid subprotocol/);
      assert.throws(() => ws.close(1001), /3000-4999/);
      ws.close();
    }),
  );

  it.effect("delivers the client's close code to the host and the host's echo back", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { WebSocket } = yield* start(probe);
      const ws = new WebSocket("/ws/peer-close");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      ws.close(4001, "bye");
      assert.equal((yield* Deferred.await(probe.wsClosedByPeer)).code, 4001);
      const closed = yield* expectEvent(log, "close");
      assert.deepStrictEqual([closed.code, closed.wasClean], [4001, true]);
    }),
  );

  it.effect("reports a close the host starts, with its code and reason", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/close-4000");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      const closed = yield* expectEvent(log, "close");
      assert.deepStrictEqual(
        [closed.code, closed.reason, closed.wasClean],
        [4000, "server says", true],
      );
      assert.equal(ws.readyState, 3);
    }),
  );

  it.effect("closes with 1011 when the host handler fails after accepting", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/fail");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      assert.equal((yield* expectEvent(log, "close")).code, 1011);
    }),
  );

  it.effect("reports a refused upgrade as an error and an abnormal close", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/unauthorized");
      const log = yield* watch(ws);
      yield* expectEvent(log, "error");
      const closed = yield* expectEvent(log, "close");
      assert.deepStrictEqual([closed.code, closed.wasClean, ws.readyState], [1006, false, 3]);
      assert.doesNotThrow(() => ws.send("late"));
    }),
  );

  it.effect("gives up on a close handshake the host never answers", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/silent");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      ws.close();
      yield* TestClock.adjust("5 seconds");
      yield* expectEvent(log, "error");
      assert.equal((yield* expectEvent(log, "close")).code, 1006);
    }),
  );

  it.effect("ends an open socket with an error when the link drops", () =>
    Effect.gen(function* () {
      const { WebSocket, pair } = yield* start(yield* makeProbe);
      const ws = new WebSocket("/ws/echo");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      yield* pair.drop;
      yield* expectEvent(log, "error");
      assert.deepStrictEqual([(yield* expectEvent(log, "close")).code, ws.readyState], [1006, 3]);
      const late = new WebSocket("/ws/echo");
      const lateLog = yield* watch(late);
      yield* expectEvent(lateLog, "error");
    }),
  );

  it.effect("works as the WebSocket behind effect's Socket", () =>
    Effect.gen(function* () {
      const { WebSocket } = yield* start(yield* makeProbe);
      const socket = yield* Socket.fromWebSocket(
        Effect.sync(() => new WebSocket("/ws/echo") satisfies Socket.WebSocketLike),
        { disableReconnects: true },
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      yield* writer.write("ping");
      yield* writer.write(new Uint8Array([1, 2, 3]));
      const received: Array<string | Uint8Array> = [];
      while (received.length < 2) received.push(...(yield* reader.pull));
      assert.deepStrictEqual(received, ["ping", new Uint8Array([1, 2, 3])]);
    }),
  );
});

describe("mux interleaving", () => {
  it.effect("keeps WebSocket traffic flowing while a request body is stalled by its window", () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const { fetch, WebSocket } = yield* start(probe);
      let pulled = 0;
      const upload = yield* Effect.promise(async () =>
        fetch("/stall", post(streamingBody(4 * 1024 * 1024, (bytes) => (pulled = bytes)))),
      ).pipe(Effect.forkChild);

      const ws = new WebSocket("/ws/echo");
      const log = yield* watch(ws);
      yield* expectEvent(log, "open");
      for (let round = 0; round < 5; round += 1) {
        ws.send(`ping ${round}`);
        assert.equal((yield* expectEvent(log, "message")).data, `ping ${round}`);
      }
      // The host reads one chunk and stops: the source may only run a window ahead.
      assert.isAtMost(pulled, WINDOW + 3 * 65536);

      yield* Deferred.succeed(probe.release, undefined);
      const response = yield* Fiber.join(upload);
      assert.equal(
        yield* Effect.promise(() => response.text()),
        String(4 * 1024 * 1024 - MUX_DATA_CHUNK_BYTES),
      );
      ws.close();
    }),
  );
});
