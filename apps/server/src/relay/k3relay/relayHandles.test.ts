import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { markRelayRequest } from "../../auth/transportSecurity.ts";
import { forgetRelayHandlesOf, issueRelayHandle, redeemRelayHandle } from "./relayHandles.ts";

const relayedBy = (deviceId: string) => markRelayRequest({ source: {} }, { deviceId });

describe("relay handles", () => {
  it.effect("are redeemed only by a relayed request from the device they were issued to", () =>
    Effect.gen(function* () {
      const handle = yield* issueRelayHandle({
        deviceId: "phone",
        kind: "asset",
        claims: { secret: 1 },
        expiresAt: 60_000,
      });
      expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      expect(yield* redeemRelayHandle(relayedBy("phone"), "asset", handle)).toEqual({ secret: 1 });
      // Another device behind the relay, a request that did not come through it, another kind.
      expect(yield* redeemRelayHandle(relayedBy("laptop"), "asset", handle)).toBeUndefined();
      expect(yield* redeemRelayHandle({ source: {} }, "asset", handle)).toBeUndefined();
      expect(yield* redeemRelayHandle({}, "asset", handle)).toBeUndefined();
      expect(yield* redeemRelayHandle(relayedBy("phone"), "upload", handle)).toBeUndefined();
      expect(yield* redeemRelayHandle(relayedBy("phone"), "asset", `${handle}x`)).toBeUndefined();
    }),
  );

  it.effect("expire, and go with the device", () =>
    Effect.gen(function* () {
      const expiring = yield* issueRelayHandle({
        deviceId: "phone",
        kind: "upload",
        claims: "a",
        expiresAt: 1_000,
      });
      const kept = yield* issueRelayHandle({
        deviceId: "phone",
        kind: "upload",
        claims: "b",
        expiresAt: 10_000_000,
      });
      const other = yield* issueRelayHandle({
        deviceId: "tablet",
        kind: "upload",
        claims: "c",
        expiresAt: 10_000_000,
      });
      yield* TestClock.adjust(1_000);
      expect(yield* redeemRelayHandle(relayedBy("phone"), "upload", expiring)).toBeUndefined();
      expect(yield* redeemRelayHandle(relayedBy("phone"), "upload", kept)).toBe("b");
      yield* forgetRelayHandlesOf("phone");
      expect(yield* redeemRelayHandle(relayedBy("phone"), "upload", kept)).toBeUndefined();
      expect(yield* redeemRelayHandle(relayedBy("tablet"), "upload", other)).toBe("c");
    }),
  );
});
