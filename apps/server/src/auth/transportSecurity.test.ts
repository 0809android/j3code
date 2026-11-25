import { Headers } from "effect/http";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import {
  classifyRequestTransport,
  isPrivateTransport,
  isRelayRequest,
  markRelayRequest,
  transportAllowedByPolicy,
  transportSatisfiesE2eeRequirement,
} from "./transportSecurity.ts";

const request = (headers: Record<string, string>, remoteAddress?: string) => ({
  headers: Headers.fromInput(headers),
  remoteAddress: remoteAddress === undefined ? Option.none() : Option.some(remoteAddress),
  source: {},
});

/** A request the RelayConnector built: what a device sent is only headers and a path. */
const relayRequest = (headers: Record<string, string>, remoteAddress?: string) =>
  markRelayRequest(request(headers, remoteAddress));

describe("classifyRequestTransport", () => {
  it("loopback peers without forwarding headers are loopback", () => {
    expect(classifyRequestTransport(request({}, "127.0.0.1"))).toBe("loopback");
    expect(classifyRequestTransport(request({}, "::1"))).toBe("loopback");
    // SSH port forwards present as loopback traffic and count as loopback.
    expect(classifyRequestTransport(request({}, "::ffff:127.0.0.1"))).toBe("loopback");
  });

  it("Tailscale peers are tailnet, whether IPv4 CGNAT or the ULA prefix", () => {
    expect(classifyRequestTransport(request({}, "100.72.10.4"))).toBe("tailscale");
    expect(classifyRequestTransport(request({}, "fd7a:115c:a1e0::12"))).toBe("tailscale");
    // Shared-address-space addresses alone could be any CGNAT VPN; the ULA
    // prefix and .ts.net names are what identify Tailscale. Both pass the
    // private-transport gate, so a misclassification never locks anyone out.
    expect(isPrivateTransport(classifyRequestTransport(request({}, "100.100.2.3")))).toBe(true);
  });

  it("Cloudflare tunnel headers mark a tunnel even from a loopback peer", () => {
    expect(
      classifyRequestTransport(request({ "cf-connecting-ip": "203.0.113.9" }, "127.0.0.1")),
    ).toBe("tunnel");
    expect(classifyRequestTransport(request({ "cf-ray": "8f1b" }, "127.0.0.1"))).toBe("tunnel");
  });

  it("a loopback proxy is judged by the client it forwards for", () => {
    expect(
      classifyRequestTransport(request({ "x-forwarded-for": "100.72.10.4" }, "127.0.0.1")),
    ).toBe("tailscale");
    expect(
      classifyRequestTransport(request({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1")),
    ).toBe("lan-or-proxy");
  });

  it("everything else is LAN or proxy", () => {
    expect(classifyRequestTransport(request({}, "192.168.1.20"))).toBe("lan-or-proxy");
    expect(classifyRequestTransport(request({}, "203.0.113.9"))).toBe("lan-or-proxy");
    expect(classifyRequestTransport(request({}))).toBe("lan-or-proxy");
  });

  it("private transports are loopback and Tailscale only", () => {
    expect(isPrivateTransport("loopback")).toBe(true);
    expect(isPrivateTransport("tailscale")).toBe(true);
    expect(isPrivateTransport("tunnel")).toBe(false);
    expect(isPrivateTransport("lan-or-proxy")).toBe(false);
  });
});

describe("k3relay transport", () => {
  it("is decided by the route the connector marked", () => {
    expect(classifyRequestTransport(relayRequest({}))).toBe("k3relay");
    expect(classifyRequestTransport(relayRequest({}, "127.0.0.1"))).toBe("k3relay");
    expect(isRelayRequest(relayRequest({}))).toBe(true);
  });

  it("is never claimed by headers, a peer address or an unmarked source", () => {
    const spoofs: ReadonlyArray<Record<string, string>> = [
      { "x-k3relay": "1" },
      { "x-transport": "k3relay" },
      { "x-forwarded-for": "k3relay" },
      { host: "k3host.invalid", "x-forwarded-proto": "https" },
    ];
    for (const headers of spoofs) {
      expect(classifyRequestTransport(request(headers, "192.168.1.20"))).not.toBe("k3relay");
      expect(isRelayRequest(request(headers))).toBe(false);
    }
    // A request that has no source at all cannot carry the mark either.
    const sourceless = {
      headers: Headers.fromInput({}),
      remoteAddress: Option.none<string>(),
      source: undefined,
    };
    expect(isRelayRequest(sourceless)).toBe(false);
    expect(classifyRequestTransport(sourceless)).toBe("lan-or-proxy");
    // A mark is on one request, not on every request that looks like it.
    relayRequest({});
    expect(classifyRequestTransport(request({}, "127.0.0.1"))).toBe("loopback");
  });

  it("ignores the forwarding and tunnel headers a device sends", () => {
    for (const headers of [
      { "x-forwarded-for": "127.0.0.1" },
      { "x-forwarded-for": "100.72.10.4" },
      { "x-forwarded-proto": "https" },
      { "cf-ray": "8f1b" },
      { "cf-connecting-ip": "203.0.113.9" },
    ]) {
      expect(classifyRequestTransport(relayRequest(headers, "127.0.0.1"))).toBe("k3relay");
      expect(classifyRequestTransport(relayRequest(headers, "100.72.10.4"))).toBe("k3relay");
      expect(classifyRequestTransport(relayRequest(headers))).toBe("k3relay");
    }
  });

  it("keeps its mark when the router or middleware modifies the request", () => {
    const original = relayRequest({});
    const modified = {
      ...original,
      headers: Headers.fromInput({ "x-forwarded-for": "127.0.0.1" }),
    };
    expect(classifyRequestTransport(modified)).toBe("k3relay");
  });

  it("only the connector can mark a request, and needs an object source to do it", () => {
    expect(() => markRelayRequest({ source: undefined })).toThrow(TypeError);
  });

  it("is not private, so a private-e2ee-only host refuses it", () => {
    expect(isPrivateTransport("k3relay")).toBe(false);
    expect(transportAllowedByPolicy("k3relay", "private-e2ee-only")).toBe(false);
    expect(transportAllowedByPolicy("k3relay", "any")).toBe(true);
  });

  it("counts as end-to-end encrypted for e2eeMode=require, as loopback does", () => {
    expect(transportSatisfiesE2eeRequirement("k3relay")).toBe(true);
    expect(transportSatisfiesE2eeRequirement("loopback")).toBe(true);
    expect(transportSatisfiesE2eeRequirement("tailscale")).toBe(false);
    expect(transportSatisfiesE2eeRequirement("tunnel")).toBe(false);
    expect(transportSatisfiesE2eeRequirement("lan-or-proxy")).toBe(false);
  });
});

describe("existing transports are unchanged", () => {
  it("classifies loopback, tailscale, tunnel and LAN as before for unmarked requests", () => {
    expect(classifyRequestTransport(request({}, "127.0.0.1"))).toBe("loopback");
    expect(classifyRequestTransport(request({}, "100.72.10.4"))).toBe("tailscale");
    expect(classifyRequestTransport(request({ "cf-ray": "8f1b" }, "127.0.0.1"))).toBe("tunnel");
    expect(classifyRequestTransport(request({}, "192.168.1.20"))).toBe("lan-or-proxy");
    expect(
      classifyRequestTransport(request({ "x-forwarded-for": "100.72.10.4" }, "127.0.0.1")),
    ).toBe("tailscale");
  });

  it("answers private-e2ee-only for loopback and tailscale only", () => {
    expect(transportAllowedByPolicy("loopback", "private-e2ee-only")).toBe(true);
    expect(transportAllowedByPolicy("tailscale", "private-e2ee-only")).toBe(true);
    expect(transportAllowedByPolicy("tunnel", "private-e2ee-only")).toBe(false);
    expect(transportAllowedByPolicy("lan-or-proxy", "private-e2ee-only")).toBe(false);
  });
});
