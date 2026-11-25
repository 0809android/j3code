import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import type { MuxConnectionClosedError, MuxStreamError } from "./errors.ts";
import { MuxResetCode, MuxStreamStateError } from "./errors.ts";
import { makeMuxMessageChannel, type MuxMessageChannel } from "./messageChannel.ts";
import type { MuxHeaders, MuxHttpOpen, MuxOpen, MuxWebSocketOpen } from "./open.ts";
import {
  type MuxHandler,
  type MuxLimits,
  type MuxSession,
  type MuxStream,
  makeMuxSession,
} from "./session.ts";

/**
 * The host's side of the mux. `makeMuxHost` turns every OPEN into a call of your handler; the
 * helpers below shape that call for HTTP and WebSocket. Wiring a handler to the server's router is
 * the caller's job: this module only defines the shapes.
 */

export interface MuxHttpRequest {
  readonly method: string;
  readonly path: string;
  /** Without `X-Forwarded-*` and `cf-*`. */
  readonly headers: MuxHeaders;
  readonly body: Stream.Stream<Uint8Array, MuxStreamError>;
}

export interface MuxHttpResponse<E = never> {
  readonly status: number;
  readonly statusText?: string | undefined;
  readonly headers: MuxHeaders;
  readonly body?: Stream.Stream<Uint8Array, E> | Uint8Array | string | undefined;
}

export type MuxHttpHandler<E, R> = (
  request: MuxHttpRequest,
) => Effect.Effect<MuxHttpResponse<E>, E, R>;

/** Adapts an HTTP handler to a `MuxHandler`. A failure resets the stream; the client sees a network error. */
export const serveHttp =
  <E, R>(handler: MuxHttpHandler<E, R>) =>
  (open: MuxHttpOpen, stream: MuxStream): Effect.Effect<void, E | MuxStreamError, R> =>
    Effect.gen(function* () {
      const response = yield* handler({
        method: open.method,
        path: open.path,
        headers: open.headers,
        body: stream.incoming,
      });
      yield* stream.respond({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      const { body } = response;
      if (body === undefined) {
        // Nothing to send.
      } else if (typeof body === "string") {
        yield* stream.send(new TextEncoder().encode(body));
      } else if (body instanceof Uint8Array) {
        yield* stream.send(body);
      } else {
        yield* Stream.runForEach(body, stream.send);
      }
      yield* stream.close();
    });

export interface MuxWebSocketRequest {
  readonly path: string;
  readonly headers: MuxHeaders;
  readonly protocols: ReadonlyArray<string>;
  /** Answers the upgrade (101). `protocol` must be one the client offered. */
  readonly accept: (protocol?: string) => Effect.Effect<MuxMessageChannel, MuxStreamError>;
  /** Answers with an HTTP error instead, and ends the stream. */
  readonly reject: (
    status: number,
    response?: { readonly headers?: MuxHeaders; readonly body?: string | Uint8Array },
  ) => Effect.Effect<void, MuxStreamError>;
}

/**
 * Adapts a WebSocket handler. After `accept`, the channel is closed for the handler when it
 * returns (echoing the peer's close code), or with 1011 when it fails.
 */
export const serveWebSocket =
  <E, R>(handler: (request: MuxWebSocketRequest) => Effect.Effect<void, E, R>) =>
  (open: MuxWebSocketOpen, stream: MuxStream): Effect.Effect<void, E | MuxStreamError, R> => {
    let accepted: MuxMessageChannel | undefined;
    const request: MuxWebSocketRequest = {
      path: open.path,
      headers: open.headers,
      protocols: open.protocols,
      accept: Effect.fnUntraced(function* (protocol?: string) {
        if (protocol !== undefined && !open.protocols.includes(protocol)) {
          return yield* new MuxStreamStateError({
            detail: "The accepted subprotocol was not offered.",
          });
        }
        yield* stream.respond({ status: 101, headers: [], protocol });
        accepted = makeMuxMessageChannel(stream);
        return accepted;
      }),
      reject: Effect.fnUntraced(function* (status, response) {
        yield* stream.respond({ status, headers: response?.headers ?? [] });
        const body = response?.body;
        if (body !== undefined) {
          yield* stream.send(typeof body === "string" ? new TextEncoder().encode(body) : body);
        }
        yield* stream.close();
      }),
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(handler(request));
      if (accepted === undefined) return yield* exit;
      if (Exit.isSuccess(exit)) {
        const peerCode = accepted.peerCloseCode();
        // Echo the peer's code; "no status" cannot be sent.
        yield* Effect.ignore(
          accepted.close(peerCode === undefined || peerCode === 1005 ? 1000 : peerCode),
        );
      } else if (Cause.hasInterruptsOnly(exit.cause)) {
        return yield* exit;
      } else {
        // Say why on the socket itself: a stream reset would drop the close frame.
        yield* Effect.logWarning("Mux WebSocket handler failed", Cause.pretty(exit.cause));
        yield* Effect.ignore(accepted.close(1011, "Internal error"));
      }
    });
  };

/** Sends each kind of OPEN to its handler; a kind without one is refused. */
export const makeMuxHandler =
  <E1 = never, R1 = never, E2 = never, R2 = never>(handlers: {
    readonly http?: (open: MuxHttpOpen, stream: MuxStream) => Effect.Effect<void, E1, R1>;
    readonly ws?: (open: MuxWebSocketOpen, stream: MuxStream) => Effect.Effect<void, E2, R2>;
  }): MuxHandler<E1 | E2, R1 | R2> =>
  (open: MuxOpen, stream: MuxStream): Effect.Effect<void, E1 | E2, R1 | R2> =>
    (open.kind === "http" ? handlers.http?.(open, stream) : handlers.ws?.(open, stream)) ??
    stream.reset(MuxResetCode.Refused, `No handler for ${open.kind}.`);

export interface MuxHostOptions<E, R> {
  readonly socket: Socket.Socket;
  readonly handler: MuxHandler<E, R>;
  readonly limits?: Partial<MuxLimits> | undefined;
}

/** Serves one E2E channel. The session ends with the scope or the socket. */
export const makeMuxHost = <E, R>(
  options: MuxHostOptions<E, R>,
): Effect.Effect<MuxSession, MuxConnectionClosedError, R | Scope.Scope> =>
  makeMuxSession({
    socket: options.socket,
    role: "host",
    handler: options.handler,
    limits: options.limits,
  });
