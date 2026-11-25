import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpEffect from "effect/http/HttpEffect";
import type * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  GUEST_ROUTE_PREFIX,
  K3_RELAY_PROVISIONAL_ORIGIN,
  type K3RelayUnsupportedFeature,
  SPEECH_STREAM_PATH,
  k3RelayUnsupportedResponse,
} from "@t3tools/contracts";
import {
  type MuxHandler,
  type MuxHeaders,
  type MuxHttpRequest,
  type MuxHttpResponse,
  type MuxStreamError,
  MuxStreamStateError,
  makeMuxHandler,
  serveHttp,
  serveWebSocket,
} from "@t3tools/shared/mux";

import { markRelayRequest } from "../../auth/transportSecurity.ts";
import { socketFromMuxChannel } from "./relaySockets.ts";

/**
 * The in-process bridge (spec §7): each mux stream becomes a request the server's own router
 * answers, with no loopback TCP in between. Every request is built here and marked as relayed,
 * so its transport is `k3relay` whatever the device put in its headers.
 */

/** The server's router and the context its routes run in. */
export interface RelayRouter {
  readonly router: HttpRouter.HttpRouter;
  readonly context: Context.Context<never>;
}

/** Device-only routes the connector answers itself, inside the mux. */
export type RelayLocalRoute = (
  request: MuxHttpRequest,
) => Effect.Effect<MuxHttpResponse<never>> | undefined;

type RouterEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

// The router fails with whatever its routes fail with; `toHandled` turns any failure into a
// response, so the bridge treats them as one error type.
const routerEffect = (relay: RelayRouter): RouterEffect =>
  Effect.mapError(
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the router's own signature.
    relay.router.asHttpEffect(),
    (error) => error as HttpServerError.HttpServerError,
  );

// Hop-by-hop and connection-describing headers: the bridge is the connection.
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "proxy-authorization",
  "proxy-connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

// What a proxy in front of the host would say about the client. The device is not such a proxy,
// so whatever it put here is dropped (the mux host already drops most; this is the bridge's own).
const SPOOFABLE_HEADERS = new Set(["forwarded", "x-real-ip", "true-client-ip"]);

const isSpoofable = (lower: string) =>
  SPOOFABLE_HEADERS.has(lower) || lower.startsWith("x-forwarded-") || lower.startsWith("cf-");

const requestHeaders = (headers: MuxHeaders): Headers => {
  const out = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!DROPPED_HEADERS.has(lower) && !isSpoofable(lower)) out.append(name, value);
  }
  return out;
};

/**
 * Routes that cannot work through the relay (spec §12), refused here before the router sees them.
 * They hand out or redeem credentials in URLs, or reach for the Node socket under the request,
 * which a bridged request does not have. Their own handlers refuse relayed requests too.
 */
const REFUSED_ROUTES: ReadonlyArray<readonly [prefix: string, feature: K3RelayUnsupportedFeature]> =
  [
    [GUEST_ROUTE_PREFIX, "guest-share"],
    ["/api/preview/tunnel", "preview-tunnel"],
    ["/api/device-hub", "device-hub"],
    ["/api/preview-stream", "preview-stream"],
    [SPEECH_STREAM_PATH, "voice-input"],
    // Scheduled-task webhooks: a token in the path, for services outside, not for devices.
    ["/api/hooks", "signed-url"],
  ];

/** The refused feature for a relayed path. Matching is loose on purpose: refusing more is safe. */
export const refusedRelayFeature = (path: string): K3RelayUnsupportedFeature | undefined => {
  let pathname: string;
  try {
    pathname = new URL(relayUrl(path)).pathname;
  } catch {
    return undefined;
  }
  const normalized = decodeURIComponentSafe(pathname).toLowerCase().replace(/\/+/gu, "/");
  for (const [prefix, feature] of REFUSED_ROUTES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return feature;
  }
  return undefined;
};

const decodeURIComponentSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const refusalBody = (feature: K3RelayUnsupportedFeature) =>
  new TextEncoder().encode(JSON.stringify(k3RelayUnsupportedResponse(feature)));

const refusalHeaders: MuxHeaders = [
  ["content-type", "application/json"],
  ["cache-control", "no-store"],
];

/**
 * The most a relayed request body may carry. Uploads stream through with backpressure, so this
 * bounds what one request can make the host write, not what it holds in memory.
 */
export const RELAY_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

const responseHeaders = (headers: Headers): MuxHeaders => {
  const out: Array<readonly [string, string]> = [];
  headers.forEach((value, name) => {
    if (name !== "set-cookie" && !DROPPED_HEADERS.has(name)) out.push([name, value]);
  });
  for (const cookie of headers.getSetCookie()) out.push(["set-cookie", cookie]);
  return out;
};

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

// Concatenated, not resolved: a path like `//elsewhere/x` must stay a path on the provisional host.
const relayUrl = (path: string) => `${K3_RELAY_PROVISIONAL_ORIGIN}${path}`;

const relayedResponse = (response: Response): MuxHttpResponse<MuxStreamStateError> => {
  const body = response.body;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
    body:
      body === null
        ? undefined
        : Stream.fromReadableStream({
            evaluate: () => body,
            onError: () => new MuxStreamStateError({ detail: "The relayed response body failed." }),
          }),
  };
};

const tooLarge = (maxBytes: number): MuxHttpResponse<never> => ({
  status: 413,
  headers: [["content-type", "text/plain; charset=utf-8"]],
  body: `A request through the relay carries at most ${maxBytes} bytes.`,
});

/** The request's scope spans its body too, so aborting it on close never cuts a response short. */
const forwardHttp = Effect.fn("RelayBridge.forwardHttp")(function* (
  relay: RelayRouter,
  deviceId: string,
  request: MuxHttpRequest,
  maxBodyBytes: number,
) {
  const refused = refusedRelayFeature(request.path);
  if (refused !== undefined) {
    return {
      status: 403,
      headers: refusalHeaders,
      body: refusalBody(refused),
    } satisfies MuxHttpResponse<never>;
  }
  const declared = request.headers.find(([name]) => name.toLowerCase() === "content-length")?.[1];
  if (declared !== undefined && Number(declared) > maxBodyBytes) return tooLarge(maxBodyBytes);
  const signal = yield* Effect.abortSignal;
  let received = 0;
  let overflowed = false;
  const body = METHODS_WITHOUT_BODY.has(request.method.toUpperCase())
    ? undefined
    : Stream.toReadableStream(
        request.body.pipe(
          Stream.mapEffect((chunk) => {
            received += chunk.byteLength;
            if (received <= maxBodyBytes) return Effect.succeed(chunk);
            overflowed = true;
            return Effect.fail(
              new MuxStreamStateError({ detail: "The relayed request body is too large." }),
            );
          }),
        ),
      );
  const init: RequestInit & { readonly duplex?: "half" } = {
    method: request.method,
    headers: requestHeaders(request.headers),
    signal,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  };
  const webRequest = new Request(relayUrl(request.path), init);
  markRelayRequest({ source: webRequest }, { deviceId });
  const handler = HttpEffect.toWebHandlerWith<
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >(relay.context)(routerEffect(relay));
  const response = yield* Effect.promise(() => handler(webRequest));
  if (overflowed) {
    // Whatever the route made of a cut-off body, the answer is that it was too large.
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
    return tooLarge(maxBodyBytes);
  }
  return relayedResponse(response);
});

const serveRelayedHttp =
  (relay: RelayRouter, deviceId: string, local: RelayLocalRoute, maxBodyBytes: number) =>
  (...args: Parameters<ReturnType<typeof serveHttp>>) =>
    Effect.scoped(
      serveHttp(
        (request: MuxHttpRequest) =>
          local(request) ??
          (forwardHttp(relay, deviceId, request, maxBodyBytes) as Effect.Effect<
            MuxHttpResponse<MuxStreamStateError>,
            never,
            Scope.Scope
          >),
      )(...args),
    );

const forwardWebSocket = Effect.fn("RelayBridge.forwardWebSocket")(function* (
  relay: RelayRouter,
  deviceId: string,
  request: Parameters<Parameters<typeof serveWebSocket>[0]>[0],
) {
  const refused = refusedRelayFeature(request.path);
  if (refused !== undefined) {
    return yield* request.reject(403, { headers: refusalHeaders, body: refusalBody(refused) });
  }
  const webRequest = new Request(relayUrl(request.path), {
    method: "GET",
    headers: requestHeaders(request.headers),
  });
  markRelayRequest({ source: webRequest }, { deviceId });
  let upgraded = false;
  const upgrade = Effect.suspend(() => {
    if (upgraded) return Effect.die("A relayed WebSocket request upgrades once.");
    upgraded = true;
    return Effect.map(request.accept(), socketFromMuxChannel);
  }).pipe(Effect.orDie);
  const serverRequest: HttpServerRequest.HttpServerRequest = Object.create(
    HttpServerRequest.fromWeb(webRequest),
    { upgrade: { value: upgrade }, upgradeWith: { value: () => upgrade } },
  );
  // A route that answers without upgrading (refused auth, policy) is sent back as HTTP.
  const sendRefusal = (_request: unknown, response: HttpServerResponse.HttpServerResponse) =>
    upgraded
      ? Effect.void
      : Effect.gen(function* () {
          const web = HttpServerResponse.toWeb(response, { context: relay.context });
          const bytes = new Uint8Array(yield* Effect.promise(() => web.arrayBuffer()));
          yield* request.reject(web.status, {
            headers: responseHeaders(web.headers),
            body: bytes,
          });
        });
  yield* HttpEffect.toHandled(Effect.interruptible(routerEffect(relay)), sendRefusal).pipe(
    Effect.provideContext(
      Context.add(relay.context, HttpServerRequest.HttpServerRequest, serverRequest),
    ),
  );
});

/** The mux handler for one E2E-authenticated device session. */
export const makeRelayMuxHandler = (input: {
  readonly relay: RelayRouter;
  readonly deviceId: string;
  readonly local: RelayLocalRoute;
  /** Defaults to {@link RELAY_MAX_REQUEST_BODY_BYTES}. */
  readonly maxRequestBodyBytes?: number | undefined;
}): MuxHandler<MuxStreamError> =>
  makeMuxHandler({
    http: serveRelayedHttp(
      input.relay,
      input.deviceId,
      input.local,
      input.maxRequestBodyBytes ?? RELAY_MAX_REQUEST_BODY_BYTES,
    ),
    ws: serveWebSocket((request) => forwardWebSocket(input.relay, input.deviceId, request)),
  });

/**
 * Captures the router and the routes' context from inside the routes layer. Each request gets its
 * own scope from `toHandled`, so the layer's scope in this context is never used by a route.
 */
export const captureRelayRouter = (router: HttpRouter.HttpRouter) =>
  Effect.map(Effect.context<never>(), (context): RelayRouter => ({ router, context }));
