import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

import type { MuxMessageChannel } from "@t3tools/shared/mux";

/** Protocol-level ping interval on every socket to the relay (spec §4.1). */
const KEEPALIVE_INTERVAL = "25 seconds";

const socketError = (reason: Socket.SocketError["reason"]) => new Socket.SocketError({ reason });

/**
 * One connection to the relay that never reconnects by itself: a reconnect would re-run the E2E
 * handshake or reuse a spent data token. Compression stays off (spec §6.6). It pings every 25
 * seconds and drops a connection that missed the previous pong, so a NAT that silently forgot
 * the connection is noticed and the host reconnects.
 */
export const openRelayWebSocket = (url: string, options: { readonly maxPayload: number }) =>
  Socket.fromWebSocket(
    Effect.gen(function* () {
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new NodeWS.WebSocket(url, {
            perMessageDeflate: false,
            maxPayload: options.maxPayload,
            handshakeTimeout: 10_000,
          });
          // Effect drops its listeners on release; an unhandled `error` would exit the server.
          socket.on("error", () => undefined);
          return socket;
        }),
        (socket) => Effect.sync(() => socket.close(1000)),
      );
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      yield* Effect.sync(() => {
        if (ws.readyState !== NodeWS.WebSocket.OPEN) return;
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }).pipe(Effect.delay(KEEPALIVE_INTERVAL), Effect.forever, Effect.forkScoped);
      return ws;
    }),
    { openTimeout: "10 seconds", disableReconnects: true },
  );

/**
 * A `Socket` over one mux WebSocket stream, which is what the server's WebSocket routes read
 * after an in-process upgrade. A peer close fails `pull` with its code, as a real socket does.
 */
export const socketFromMuxChannel = (channel: MuxMessageChannel): Socket.Socket =>
  Socket.make({
    reader: Effect.gen(function* () {
      const released = yield* Deferred.make<never, Socket.SocketError>();
      yield* Effect.addFinalizer(() =>
        Deferred.fail(released, socketError(new Socket.SocketCloseError({ code: 1000 }))),
      );
      const receive = Effect.flatMap(channel.receive, (event) =>
        event._tag === "Close"
          ? Effect.fail(
              socketError(
                new Socket.SocketCloseError({ code: event.code, closeReason: event.reason }),
              ),
            )
          : Effect.succeed([event.data] as const),
      ).pipe(
        Effect.mapError((cause) =>
          Socket.isSocketError(cause) ? cause : socketError(new Socket.SocketReadError({ cause })),
        ),
      );
      return {
        pull: Effect.raceFirst(receive, Deferred.await(released)),
        upgrade: () =>
          Effect.fail(socketError(new Socket.SocketUpgradeError({ cause: "unsupported" }))),
      } satisfies Socket.Reader;
    }),
    writer: Effect.succeed(
      (() => {
        const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
          (Socket.isCloseEvent(chunk)
            ? channel.close(chunk.code, chunk.reason)
            : channel.send(chunk)
          ).pipe(Effect.mapError((cause) => socketError(new Socket.SocketWriteError({ cause }))));
        return {
          write,
          writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
        } satisfies Socket.Writer;
      })(),
    ),
  });
