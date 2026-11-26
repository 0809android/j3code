import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthRelayConfigureScope, AuthSettingsWriteScope } from "./auth.ts";
import { DEFAULT_K3_RELAY_URL, K3RelaySettings } from "./k3Relay.ts";
import { ServerSettings, requiredScopesForServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeRelaySettings = Schema.decodeSync(K3RelaySettings);

describe("K3 relay settings", () => {
  it("is off by default and points at the K3 relay", () => {
    expect(decodeServerSettings({}).relay).toEqual({
      enabled: false,
      url: DEFAULT_K3_RELAY_URL,
      maxSessions: 8,
      maxSessionBufferBytes: 16 * 1024 * 1024,
      notifications: true,
    });
    expect(DEFAULT_K3_RELAY_URL).toBe("wss://relay.k3.kinocode.jp");
  });

  it("bounds the session limits", () => {
    expect(() => decodeRelaySettings({ maxSessions: 0 })).toThrow();
    expect(() => decodeRelaySettings({ maxSessions: 65 })).toThrow();
    expect(() => decodeRelaySettings({ maxSessionBufferBytes: 1024 })).toThrow();
  });

  it("needs the owner's relay scope to change, never just settings:write", () => {
    expect(requiredScopesForServerSettingsPatch({ relay: { enabled: true } })).toEqual([
      AuthRelayConfigureScope,
    ]);
    expect(
      requiredScopesForServerSettingsPatch({ relay: { enabled: true }, worktreesDirectory: "/w" }),
    ).toEqual([AuthSettingsWriteScope, AuthRelayConfigureScope]);
  });
});
