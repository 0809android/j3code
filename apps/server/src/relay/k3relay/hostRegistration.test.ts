import { describe, expect, it } from "@effect/vitest";

import { relayEndpoints } from "./hostRegistration.ts";

describe("relayEndpoints", () => {
  it("accepts a secure relay origin and derives its HTTPS twin", () => {
    expect(relayEndpoints("wss://relay.k3.kinocode.jp")).toEqual({
      ws: "wss://relay.k3.kinocode.jp",
      http: "https://relay.k3.kinocode.jp",
    });
    expect(relayEndpoints("https://relay.example:8443/")).toEqual({
      ws: "wss://relay.example:8443",
      http: "https://relay.example:8443",
    });
  });

  it("allows plain WebSocket only on loopback, for development", () => {
    expect(relayEndpoints("ws://127.0.0.1:8080")?.http).toBe("http://127.0.0.1:8080");
    expect(relayEndpoints("ws://relay.example")).toBeNull();
    expect(relayEndpoints("http://192.168.1.2:8080")).toBeNull();
  });

  it("refuses anything but a bare origin", () => {
    expect(relayEndpoints("wss://user:pass@relay.example")).toBeNull();
    expect(relayEndpoints("wss://relay.example/v1")).toBeNull();
    expect(relayEndpoints("wss://relay.example/?x=1")).toBeNull();
    expect(relayEndpoints("wss://relay.example/#frag")).toBeNull();
    expect(relayEndpoints("ftp://relay.example")).toBeNull();
    expect(relayEndpoints("not a url")).toBeNull();
  });
});
