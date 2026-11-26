import { describe, expect, it } from "vite-plus/test";

import { authSessionCallback } from "./k3relayAccount";

describe("the account sign-in's return to the app", () => {
  it("redeems only a k3relay account callback the auth session returned", () => {
    expect(
      authSessionCallback({ type: "success", url: "k3relay://account/callback?code=c&state=s" }),
    ).toBe("k3relay://account/callback?code=c&state=s");
    expect(authSessionCallback({ type: "success", url: "k3relay://pair?v=2#s=x" })).toBeNull();
    expect(authSessionCallback({ type: "cancel" })).toBeNull();
    expect(authSessionCallback({ type: "dismiss" })).toBeNull();
  });
});
