import { describe, expect, it, vi } from "vite-plus/test";

import { classifyJ3ConnectionHost, probeJ3Connection } from "./j3ConnectionProbe";

describe("classifyJ3ConnectionHost", () => {
  it("detects Tailscale CGNAT IPs and MagicDNS hosts", () => {
    expect(classifyJ3ConnectionHost("100.82.53.91:3773")).toEqual({
      kind: "tailscale",
      normalizedUrl: "http://100.82.53.91:3773",
      host: "100.82.53.91:3773",
    });
    expect(classifyJ3ConnectionHost("devbox.tail1234.ts.net")).toEqual({
      kind: "tailscale",
      normalizedUrl: "https://devbox.tail1234.ts.net",
      host: "devbox.tail1234.ts.net",
    });
  });

  it("detects J3 Relay Proxy ports and local LAN addresses", () => {
    expect(classifyJ3ConnectionHost("http://100.82.53.91:8787")).toEqual({
      kind: "relay",
      normalizedUrl: "http://100.82.53.91:8787",
      host: "100.82.53.91:8787",
    });
    expect(classifyJ3ConnectionHost("192.168.1.42:3773")).toEqual({
      kind: "local",
      normalizedUrl: "http://192.168.1.42:3773",
      host: "192.168.1.42:3773",
    });
    expect(classifyJ3ConnectionHost("localhost:3773")).toEqual({
      kind: "local",
      normalizedUrl: "http://localhost:3773",
      host: "localhost:3773",
    });
  });

  it("does not treat localhost-prefixed domains as local http hosts", () => {
    expect(classifyJ3ConnectionHost("localhost.example.com")).toEqual({
      kind: "remote",
      normalizedUrl: "https://localhost.example.com",
      host: "localhost.example.com",
    });
  });

  it("rejects empty and non-http(s) schemes", () => {
    expect(classifyJ3ConnectionHost("")).toEqual({
      kind: "invalid",
      normalizedUrl: null,
      host: null,
    });
    expect(classifyJ3ConnectionHost("javascript:alert(1)").kind).toBe("invalid");
    expect(classifyJ3ConnectionHost("file:///etc/passwd").kind).toBe("invalid");
  });
});

describe("probeJ3Connection", () => {
  it("detects j3-relay-proxy from /healthz JSON payload", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: true, service: "j3-relay-proxy", upstream: "127.0.0.1:3773" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await probeJ3Connection("http://100.82.53.91:3773", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("relay");
    expect(result.relayDetected).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to /api/auth/session when /healthz returns SPA HTML", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/healthz")) {
        return new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await probeJ3Connection("192.168.1.10:3773", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("local");
    expect(result.relayDetected).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to /api/auth/session when /healthz returns 404 and accepts 401", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/healthz")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("Unauthorized", { status: 401 });
    });

    const result = await probeJ3Connection("192.168.1.10:3773", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("local");
    expect(result.relayDetected).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unrelated websites that return HTML for both /healthz and /api/auth/session", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("<html><body>Welcome</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const result = await probeJ3Connection("https://example.com", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unexpected_response");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels in-flight probes when the external AbortSignal aborts", async () => {
    const externalController = new AbortController();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = probeJ3Connection("192.168.1.10:3773", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      signal: externalController.signal,
    });
    externalController.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("timeout");
  });

  it("returns invalid error without calling fetch for unsupported schemes", async () => {
    const fetchMock = vi.fn();
    const result = await probeJ3Connection("ftp://example.com", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("invalid");
    expect(result.errorCode).toBe("invalid_address");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
