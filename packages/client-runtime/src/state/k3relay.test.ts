import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { hostLacksK3Relay } from "./k3relay.ts";

describe("hostLacksK3Relay", () => {
  it("recognises an older host's refusal of the unknown relay method", () => {
    expect(
      hostLacksK3Relay(AsyncResult.failure(Cause.die("Unknown request tag: k3relay.subscribe"))),
    ).toBe(true);
    expect(
      hostLacksK3Relay(
        AsyncResult.failure(Cause.die(new Error("Unknown request tag: k3relay.subscribe"))),
      ),
    ).toBe(true);
  });

  it("leaves real failures and answers alone", () => {
    expect(hostLacksK3Relay(AsyncResult.failure(Cause.fail(new Error("offline"))))).toBe(false);
    expect(hostLacksK3Relay(AsyncResult.success({}))).toBe(false);
    expect(hostLacksK3Relay(AsyncResult.initial())).toBe(false);
  });
});
