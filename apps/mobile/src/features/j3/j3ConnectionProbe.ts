export type J3ConnectionKind = "tailscale" | "relay" | "local" | "remote" | "invalid";

export type J3ConnectionProbeErrorCode =
  | "invalid_address"
  | "timeout"
  | "unreachable"
  | "http_error"
  | "unexpected_response";

export interface J3ConnectionClassification {
  readonly kind: J3ConnectionKind;
  readonly normalizedUrl: string | null;
  readonly host: string | null;
}

export interface J3ConnectionProbeResult {
  readonly ok: boolean;
  readonly kind: J3ConnectionKind;
  readonly normalizedUrl: string;
  readonly relayDetected: boolean;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly errorCode: J3ConnectionProbeErrorCode | null;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const LOCALHOST_PREFIX_RE = /^localhost(?::|\/|$)/i;

function parseIpv4Octets(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    nums.push(value);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isIpLiteralHost(hostInput: string): boolean {
  try {
    const hostname = new URL(`http://${hostInput}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;
    return parseIpv4Octets(hostname) !== null;
  } catch {
    return false;
  }
}

function isTailscaleHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower.endsWith(".ts.net")) return true;
  const octets = parseIpv4Octets(lower);
  if (!octets) return false;
  // Tailscale CGNAT range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower.endsWith(".local")) {
    return true;
  }
  const octets = parseIpv4Octets(lower);
  if (!octets) return false;
  if (octets[0] === 127 || octets[0] === 10) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
}

export function classifyJ3ConnectionHost(hostInput: string): J3ConnectionClassification {
  const trimmed = hostInput.trim();
  if (!trimmed) {
    return { kind: "invalid", normalizedUrl: null, host: null };
  }

  let parsed: URL;
  try {
    const candidate = trimmed.includes("://")
      ? trimmed
      : `${isIpLiteralHost(trimmed) || LOCALHOST_PREFIX_RE.test(trimmed) ? "http" : "https"}://${trimmed}`;
    parsed = new URL(candidate);
  } catch {
    return { kind: "invalid", normalizedUrl: null, host: null };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "invalid", normalizedUrl: null, host: null };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { kind: "invalid", normalizedUrl: null, host: null };
  }

  const normalizedUrl = parsed.origin;
  const isRelayHint =
    parsed.port === "8787" ||
    parsed.pathname.toLowerCase().includes("/relay") ||
    hostname.toLowerCase().includes("relay");

  if (isRelayHint) {
    return { kind: "relay", normalizedUrl, host: parsed.host };
  }
  if (isTailscaleHost(hostname)) {
    return { kind: "tailscale", normalizedUrl, host: parsed.host };
  }
  if (isLocalHost(hostname)) {
    return { kind: "local", normalizedUrl, host: parsed.host };
  }
  return { kind: "remote", normalizedUrl, host: parsed.host };
}

async function fetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("Probe timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function tryParseJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await response.json();
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function classifyFetchError(error: unknown): J3ConnectionProbeErrorCode {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "unreachable";
}

export async function probeJ3Connection(
  hostInput: string,
  options?: {
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<J3ConnectionProbeResult> {
  const classification = classifyJ3ConnectionHost(hostInput);
  if (classification.kind === "invalid" || !classification.normalizedUrl) {
    return {
      ok: false,
      kind: "invalid",
      normalizedUrl: hostInput.trim(),
      relayDetected: false,
      statusCode: null,
      latencyMs: 0,
      errorCode: "invalid_address",
    };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const externalSignal = options?.signal;
  const baseUrl = classification.normalizedUrl;
  const startedAt = Date.now();

  // First check /healthz (supported by j3-relay-proxy and JSON health endpoints).
  // Standard T3/J3 servers serve SPA index.html (200 text/html) for unknown paths,
  // so only accept /healthz when it returns a JSON health payload.
  try {
    const healthResponse = await fetchWithTimeout(
      `${baseUrl}/healthz`,
      fetchImpl,
      timeoutMs,
      externalSignal,
    );
    const latencyMs = Math.max(1, Date.now() - startedAt);
    if (healthResponse.ok) {
      const payload = await tryParseJsonObject(healthResponse);
      const isRelayPayload = payload?.service === "j3-relay-proxy";
      const isHealthPayload = isRelayPayload || payload?.ok === true;
      if (isHealthPayload) {
        const relayDetected = isRelayPayload || classification.kind === "relay";
        return {
          ok: true,
          kind: relayDetected ? "relay" : classification.kind,
          normalizedUrl: baseUrl,
          relayDetected,
          statusCode: healthResponse.status,
          latencyMs,
          errorCode: null,
        };
      }
      // Non-JSON /healthz (e.g. SPA HTML fallback) falls through to /api/auth/session.
    } else if (healthResponse.status >= 500) {
      return {
        ok: false,
        kind: classification.kind,
        normalizedUrl: baseUrl,
        relayDetected: classification.kind === "relay",
        statusCode: healthResponse.status,
        latencyMs,
        errorCode: "http_error",
      };
    }
  } catch (error) {
    const latencyMs = Math.max(1, Date.now() - startedAt);
    return {
      ok: false,
      kind: classification.kind,
      normalizedUrl: baseUrl,
      relayDetected: false,
      statusCode: null,
      latencyMs,
      errorCode: classifyFetchError(error),
    };
  }

  // Fallback probe for standard J3/T3 servers via /api/auth/session.
  try {
    const sessionResponse = await fetchWithTimeout(
      `${baseUrl}/api/auth/session`,
      fetchImpl,
      timeoutMs,
      externalSignal,
    );
    const latencyMs = Math.max(1, Date.now() - startedAt);
    if (sessionResponse.status === 401 || sessionResponse.status === 403) {
      return {
        ok: true,
        kind: classification.kind,
        normalizedUrl: baseUrl,
        relayDetected: classification.kind === "relay",
        statusCode: sessionResponse.status,
        latencyMs,
        errorCode: null,
      };
    }
    if (sessionResponse.ok) {
      const payload = await tryParseJsonObject(sessionResponse);
      if (payload !== null) {
        return {
          ok: true,
          kind: classification.kind,
          normalizedUrl: baseUrl,
          relayDetected: classification.kind === "relay",
          statusCode: sessionResponse.status,
          latencyMs,
          errorCode: null,
        };
      }
      return {
        ok: false,
        kind: classification.kind,
        normalizedUrl: baseUrl,
        relayDetected: false,
        statusCode: sessionResponse.status,
        latencyMs,
        errorCode: "unexpected_response",
      };
    }
    return {
      ok: false,
      kind: classification.kind,
      normalizedUrl: baseUrl,
      relayDetected: classification.kind === "relay",
      statusCode: sessionResponse.status,
      latencyMs,
      errorCode: "http_error",
    };
  } catch (error) {
    const latencyMs = Math.max(1, Date.now() - startedAt);
    return {
      ok: false,
      kind: classification.kind,
      normalizedUrl: baseUrl,
      relayDetected: false,
      statusCode: null,
      latencyMs,
      errorCode: classifyFetchError(error),
    };
  }
}
