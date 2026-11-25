import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";

/** Two `Socket`s wired back to back in memory, for tests of anything that runs over a socket. */

type Chunk = Uint8Array | string;

const closeError = (code: number) =>
  new Socket.SocketError({
    reason: new Socket.SocketCloseError({ code }),
  });

export interface MemorySocketOptions {
  /** Runs before each chunk written on side `a` reaches side `b`; holds the write until it finishes. */
  readonly beforeWriteFromA?: ((chunk: Chunk) => Effect.Effect<void>) | undefined;
}

export const makeMemorySocketPair = Effect.fn("MemorySocket.pair")(function* (
  options: MemorySocketOptions = {},
) {
  const toA = yield* Queue.unbounded<Chunk, Socket.SocketError>();
  const toB = yield* Queue.unbounded<Chunk, Socket.SocketError>();

  const side = (
    inbound: Queue.Queue<Chunk, Socket.SocketError>,
    outbound: Queue.Queue<Chunk, Socket.SocketError>,
    before: ((chunk: Chunk) => Effect.Effect<void>) | undefined,
  ): Socket.Socket => {
    const write = (chunk: Chunk | Socket.CloseEvent) =>
      Socket.isCloseEvent(chunk)
        ? Effect.asVoid(
            Queue.fail(outbound, closeError(chunk.code)).pipe(
              Effect.andThen(Queue.fail(inbound, closeError(chunk.code))),
            ),
          )
        : (before?.(chunk) ?? Effect.void).pipe(Effect.andThen(Queue.offer(outbound, chunk)));
    return Socket.make({
      reader: Effect.succeed({
        upgrade: () =>
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketUpgradeError({ cause: "unsupported" }),
            }),
          ),
        pull: Effect.map(Queue.take(inbound), (chunk) => [chunk] as const),
      }),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      }),
    });
  };

  return {
    a: side(toA, toB, options.beforeWriteFromA),
    b: side(toB, toA, undefined),
    /** The link drops: both readers fail once they have drained what was already sent. */
    drop: Effect.asVoid(
      Queue.fail(toA, closeError(1006)).pipe(Effect.andThen(Queue.fail(toB, closeError(1006)))),
    ),
  };
});
