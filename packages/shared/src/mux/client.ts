import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Socket from "effect/socket/Socket";

import { type MuxLimits, type MuxSession, makeMuxSession } from "./session.ts";

/**
 * A mux session plus the way back from Promise and callback code, which `fetch` and `WebSocket`
 * need. The runners keep the services of the fiber that created the client.
 */
export interface MuxClient extends MuxSession {
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}

export interface MuxClientOptions {
  readonly socket: Socket.Socket;
  readonly limits?: Partial<MuxLimits> | undefined;
}

/** Runs over one E2E channel. The session ends with the scope or the socket. */
export const makeMuxClient = Effect.fn("MuxClient.make")(function* (options: MuxClientOptions) {
  const session = yield* makeMuxSession({
    socket: options.socket,
    role: "client",
    limits: options.limits,
  });
  const services = yield* Effect.context<never>();
  const client: MuxClient = {
    ...session,
    runPromise: Effect.runPromiseWith(services),
    runFork: Effect.runForkWith(services),
  };
  return client;
});
