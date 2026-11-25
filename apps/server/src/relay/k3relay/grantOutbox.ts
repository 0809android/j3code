import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** Writes one control frame; fails when the control socket is gone or the write did not go out. */
export type ControlWrite<E> = (frame: object) => Effect.Effect<void, E>;

/**
 * Grant registrations the relay still has to learn. A grant it never learns leaves the device
 * paired on the host but locked out at the relay, so each one stays here, newest per device,
 * until a write of it succeeds: sent at once when the control is up, and again when it is back.
 */
export const makeGrantOutbox = <E>() => {
  const unsent = new Map<string, object>();

  const flush = (write: ControlWrite<E> | undefined) =>
    write === undefined
      ? Effect.void
      : Effect.forEach(
          [...unsent],
          ([deviceId, frame]) =>
            Effect.flatMap(Effect.exit(write(frame)), (exit) =>
              Effect.sync(() => {
                // A newer grant for the device may have arrived while this one was written.
                if (Exit.isSuccess(exit) && unsent.get(deviceId) === frame) unsent.delete(deviceId);
              }),
            ),
          { discard: true },
        );

  return {
    /** Queues the device's grant and tries to send everything queued. */
    send: (deviceId: string, frame: object, write: ControlWrite<E> | undefined) =>
      Effect.suspend(() => {
        unsent.set(deviceId, frame);
        return flush(write);
      }),
    flush,
    /** A revoked device's grant must not reach the relay later. */
    drop: (deviceId: string) =>
      Effect.sync(() => {
        unsent.delete(deviceId);
      }),
    pending: Effect.sync(() => [...unsent.keys()]),
  };
};
