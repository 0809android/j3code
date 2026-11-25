import { encodeBase64url } from "@t3tools/shared/relay";
import { layerE2eeCrypto } from "@t3tools/shared/socketE2ee";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";

import type { K3RelayAdmissionError } from "./admission.ts";
import { type K3RelayTunnel, type K3RelayTunnelInput, openK3RelayTunnel } from "./tunnel.ts";

/** A tunnel with no open stream for this long closes, so a closed session does not leave one behind. */
const IDLE_CHECK_INTERVAL = "15 seconds";

/**
 * One tunnel per saved relay connection, shared by its RPC socket and HTTP requests. A tunnel
 * that dies is forgotten, and the next `acquire` (the supervisor's reconnect) opens a fresh one.
 */
export class K3RelayTunnels extends Context.Service<
  K3RelayTunnels,
  {
    readonly acquire: (
      connectionId: string,
      input: K3RelayTunnelInput,
    ) => Effect.Effect<K3RelayTunnel, K3RelayAdmissionError>;
    readonly close: (connectionId: string) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/k3relay/tunnels/K3RelayTunnels") {}

interface Entry {
  readonly fingerprint: string;
  readonly tunnel: K3RelayTunnel;
  readonly scope: Scope.Closeable;
  readonly watchers: ReadonlyArray<Fiber.Fiber<void>>;
}

// The grant only matters at admission, so a renewed grant does not replace a live tunnel.
const fingerprint = (input: K3RelayTunnelInput) =>
  [
    input.relayUrl,
    input.hostId,
    encodeBase64url(input.hostIdentityKey),
    input.signer.alg,
    encodeBase64url(input.signer.publicKey),
  ].join("|");

/** @public */
export const make = Effect.gen(function* () {
  const layerScope = yield* Effect.scope;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const entries = new Map<string, Entry>();
  const lock = yield* Semaphore.make(1);

  const closeEntry = (connectionId: string, entry: Entry) =>
    Effect.suspend(() => {
      if (entries.get(connectionId) === entry) entries.delete(connectionId);
      return Scope.close(entry.scope, Exit.void);
    });

  const idleReaper = Effect.fnUntraced(function* (connectionId: string, entry: Entry) {
    let idleChecks = 0;
    while (entries.get(connectionId) === entry) {
      yield* Effect.sleep(IDLE_CHECK_INTERVAL);
      const stats = yield* entry.tunnel.mux.stats;
      idleChecks = stats.activeStreams === 0 ? idleChecks + 1 : 0;
      if (idleChecks >= 2) return yield* closeEntry(connectionId, entry);
    }
  });

  const open = Effect.fnUntraced(function* (connectionId: string, input: K3RelayTunnelInput) {
    const scope = yield* Scope.fork(layerScope);
    const tunnel = yield* openK3RelayTunnel(input).pipe(
      Scope.provide(scope),
      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
      Effect.provide(layerE2eeCrypto),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    const entry: { -readonly [K in keyof Entry]: Entry[K] } = {
      fingerprint: fingerprint(input),
      tunnel,
      scope,
      watchers: [],
    };
    entries.set(connectionId, entry);
    entry.watchers = [
      yield* tunnel.closed.pipe(
        Effect.andThen(closeEntry(connectionId, entry)),
        Effect.forkIn(layerScope),
      ),
      yield* idleReaper(connectionId, entry).pipe(Effect.forkIn(layerScope)),
    ];
    return tunnel;
  });

  return K3RelayTunnels.of({
    acquire: Effect.fn("K3RelayTunnels.acquire")(function* (connectionId, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = entries.get(connectionId);
          if (existing !== undefined) {
            if (existing.fingerprint === fingerprint(input)) return existing.tunnel;
            yield* closeEntry(connectionId, existing);
          }
          return yield* open(connectionId, input);
        }),
      );
    }),
    close: Effect.fn("K3RelayTunnels.close")(function* (connectionId) {
      const existing = entries.get(connectionId);
      if (existing !== undefined) yield* closeEntry(connectionId, existing);
    }),
  });
});

export const layer = Layer.effect(K3RelayTunnels, make);
