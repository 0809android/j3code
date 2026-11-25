import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { type ControlWrite, makeGrantOutbox } from "./grantOutbox.ts";

/** A control socket that is down until `up` is set, recording what reached the relay. */
const control = () => {
  const sent: Array<object> = [];
  let up = false;
  const write: ControlWrite<string> = (frame) =>
    up ? Effect.sync(() => void sent.push(frame)) : Effect.fail("closed");
  return {
    sent,
    write,
    setUp: (value: boolean) => {
      up = value;
    },
  };
};

describe("grant outbox", () => {
  it.effect("sends a grant made while the control was down once it is back", () =>
    Effect.gen(function* () {
      const outbox = makeGrantOutbox<string>();
      const relay = control();
      // The user approved while the relay control was away: nothing could be written.
      yield* outbox.send("phone", { type: "grant-register", n: 1 }, undefined);
      expect(yield* outbox.pending).toEqual(["phone"]);
      // A write that fails keeps it too.
      yield* outbox.send("tablet", { type: "grant-register", n: 2 }, relay.write);
      expect(relay.sent).toEqual([]);
      expect(yield* outbox.pending).toEqual(["phone", "tablet"]);

      relay.setUp(true);
      yield* outbox.flush(relay.write);
      expect(relay.sent).toEqual([
        { type: "grant-register", n: 1 },
        { type: "grant-register", n: 2 },
      ]);
      expect(yield* outbox.pending).toEqual([]);
      // Delivered grants are not sent again on the next reconnect.
      yield* outbox.flush(relay.write);
      expect(relay.sent).toHaveLength(2);
    }),
  );

  it.effect("keeps only the newest grant per device, and none for a revoked one", () =>
    Effect.gen(function* () {
      const outbox = makeGrantOutbox<string>();
      const relay = control();
      yield* outbox.send("phone", { n: 1 }, undefined);
      yield* outbox.send("phone", { n: 2 }, undefined);
      yield* outbox.send("lost", { n: 3 }, undefined);
      yield* outbox.drop("lost");
      relay.setUp(true);
      yield* outbox.flush(relay.write);
      expect(relay.sent).toEqual([{ n: 2 }]);
    }),
  );
});
