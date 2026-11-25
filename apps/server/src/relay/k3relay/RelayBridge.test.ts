import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { makeMuxClient, makeMuxFetch, makeMuxHost } from "@t3tools/shared/mux";

import { classifyRequestTransport, relayDeviceIdOf } from "../../auth/transportSecurity.ts";
import { captureRelayRouter, makeRelayMuxHandler, refusedRelayFeature } from "./RelayBridge.ts";

/**
 * The bridge on its own: a router with a few routes, a mux over an in-memory socket, and the
 * device's `fetch`. What the routes see is what the server's real routes would see.
 */

/** Two sockets back to back in memory: the E2E channel without the relay or the crypto. */
const socketPair = Effect.gen(function* () {
  const toA = yield* Queue.unbounded<Uint8Array | string, Socket.SocketError>();
  const toB = yield* Queue.unbounded<Uint8Array | string, Socket.SocketError>();
  const side = (
    inbound: Queue.Queue<Uint8Array | string, Socket.SocketError>,
    outbound: Queue.Queue<Uint8Array | string, Socket.SocketError>,
  ) => {
    const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      Socket.isCloseEvent(chunk) ? Effect.void : Effect.asVoid(Queue.offer(outbound, chunk));
    return Socket.make({
      reader: Effect.succeed({
        upgrade: () => Effect.die("unsupported"),
        pull: Effect.map(Queue.take(inbound), (chunk) => [chunk] as const),
      }),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      }),
    });
  };
  return { a: side(toA, toB), b: side(toB, toA) };
});

let routeCalls = 0;

const routes = Layer.mergeAll(
  // Counts the body as it streams in, without holding it.
  HttpRouter.add(
    "POST",
    "/count",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      let bytes = 0;
      let chunks = 0;
      yield* Stream.runForEach(request.stream, (chunk) =>
        Effect.sync(() => {
          bytes += chunk.byteLength;
          chunks += 1;
        }),
      );
      return HttpServerResponse.jsonUnsafe({ bytes, chunks });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/seen",
    Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
      HttpServerResponse.jsonUnsafe({
        transport: classifyRequestTransport(request),
        deviceId: relayDeviceIdOf(request) ?? null,
        forwardedFor: request.headers["x-forwarded-for"] ?? null,
        realIp: request.headers["x-real-ip"] ?? null,
        cf: request.headers["cf-connecting-ip"] ?? null,
        url: request.url,
      }),
    ),
  ),
  // As the device hub, preview stream and preview tunnel do: the Node socket under the request.
  HttpRouter.add(
    "*",
    "/api/device-hub/*",
    Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
      routeCalls += 1;
      NodeHttpServerRequest.toIncomingMessage(request).socket.destroy();
      return HttpServerResponse.empty();
    }),
  ),
);

const layerRouter = routes.pipe(Layer.provideMerge(HttpRouter.layer));

const DEVICE = "device-under-test";

const openBridge = (maxRequestBodyBytes?: number) =>
  Effect.gen(function* () {
    const relay = yield* captureRelayRouter(yield* HttpRouter.HttpRouter);
    const pair = yield* socketPair;
    yield* makeMuxHost({
      socket: pair.b,
      handler: makeRelayMuxHandler({
        relay,
        deviceId: DEVICE,
        local: () => undefined,
        maxRequestBodyBytes,
      }),
    });
    const client = yield* makeMuxClient({ socket: pair.a });
    return makeMuxFetch(client, { baseUrl: "https://k3host.invalid" });
  });

const chunkedBody = (chunks: number, chunkBytes: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(sent % 251));
    },
  });
};

describe("RelayBridge", () => {
  it.effect("streams a large body to the route in pieces, not as one buffer", () =>
    Effect.gen(function* () {
      const fetch = yield* openBridge();
      const result = yield* Effect.promise(async () => {
        const response = await fetch("/count", {
          method: "POST",
          body: chunkedBody(64, 64 * 1024),
          duplex: "half",
        } as RequestInit);
        return { status: response.status, body: (await response.json()) as Record<string, number> };
      });
      expect(result.status).toBe(200);
      expect(result.body.bytes).toBe(64 * 64 * 1024);
      // 4 MiB arrives as many mux frames: the bridge never gathered it first.
      expect(result.body.chunks).toBeGreaterThan(64);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerRouter, NodeServices.layer))),
  );

  it.effect("answers 413 to a body over the cap, declared or streamed", () =>
    Effect.gen(function* () {
      const fetch = yield* openBridge(256 * 1024);
      const declared = yield* Effect.promise(async () => {
        const response = await fetch("/count", {
          method: "POST",
          headers: { "content-length": String(1024 * 1024) },
          body: new Uint8Array(1024 * 1024),
        });
        await response.body?.cancel();
        return response.status;
      });
      expect(declared).toBe(413);
      const streamed = yield* Effect.promise(async () => {
        const response = await fetch("/count", {
          method: "POST",
          body: chunkedBody(32, 64 * 1024),
          duplex: "half",
        } as RequestInit);
        await response.body?.cancel();
        return response.status;
      });
      expect(streamed).toBe(413);
      // Under the cap still goes through.
      const small = yield* Effect.promise(async () => {
        const response = await fetch("/count", { method: "POST", body: new Uint8Array(1000) });
        return (await response.json()) as Record<string, number>;
      });
      expect(small.bytes).toBe(1000);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerRouter, NodeServices.layer))),
  );

  it.effect("drops forwarding headers and marks the request with the E2E device", () =>
    Effect.gen(function* () {
      const fetch = yield* openBridge();
      const seen = yield* Effect.promise(async () =>
        (
          await fetch("/seen?x=1", {
            headers: {
              "x-forwarded-for": "127.0.0.1",
              "X-Forwarded-Proto": "http",
              "x-forwarded-host": "localhost",
              "x-real-ip": "127.0.0.1",
              "true-client-ip": "127.0.0.1",
              "cf-connecting-ip": "127.0.0.1",
              forwarded: "for=127.0.0.1",
            },
          })
        ).json(),
      );
      expect(seen).toEqual({
        transport: "k3relay",
        deviceId: DEVICE,
        forwardedFor: null,
        realIp: null,
        cf: null,
        url: "/seen?x=1",
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerRouter, NodeServices.layer))),
  );

  it.effect(
    "refuses routes that need the Node socket before they run, however the path is spelled",
    () =>
      Effect.gen(function* () {
        const fetch = yield* openBridge();
        routeCalls = 0;
        const paths = [
          "/api/device-hub/api/accessibility",
          "/api//device-hub/x",
          "/api/x/../device-hub/x",
          "/API/Device-Hub/x",
          "/api/%64evice-hub/x",
        ];
        for (const path of paths) {
          const refusal = yield* Effect.promise(async () => {
            const response = await fetch(path);
            return { status: response.status, body: await response.json() };
          });
          expect(refusal).toEqual({
            status: 403,
            body: {
              code: "relay-unsupported",
              feature: "device-hub",
              message: "Devices on the host cannot be used through the K3 relay.",
            },
          });
        }
        expect(routeCalls).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerRouter, NodeServices.layer))),
  );
});

describe("refusedRelayFeature", () => {
  it("names what each refused route is", () => {
    expect(refusedRelayFeature("/api/guest/stream?share=a")).toBe("guest-share");
    expect(refusedRelayFeature("/api/guest")).toBe("guest-share");
    expect(refusedRelayFeature("/api/preview/tunnel?port=3000")).toBe("preview-tunnel");
    expect(refusedRelayFeature("/api/device-hub/api/devices/ws")).toBe("device-hub");
    expect(refusedRelayFeature("/api/preview-stream/ws")).toBe("preview-stream");
    expect(refusedRelayFeature("/ws/voice")).toBe("voice-input");
    expect(refusedRelayFeature("/api/hooks/abc/token")).toBe("signed-url");
  });

  it("lets everything else through", () => {
    for (const path of [
      "/ws",
      "/oauth/token",
      "/api/auth/session",
      "/api/assets/file/abc/x.png",
      "/api/attachments/upload/relay/abc",
      "/api/orchestration/shell",
      "/api/guests-list",
      "/api/previews",
      "/.well-known/t3/environment",
    ]) {
      expect(refusedRelayFeature(path)).toBeUndefined();
    }
  });
});
