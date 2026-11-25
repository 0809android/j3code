import * as Result from "effect/Result";

import { MuxProtocolError } from "./errors.ts";
import { MUX_MAX_PAYLOAD_BYTES } from "./frame.ts";

/** What an OPEN frame carries, and the head a responder sends back (also an OPEN, on the same stream). */

/** Ordered `[name, value]` pairs, duplicates kept. */
export type MuxHeaders = ReadonlyArray<readonly [name: string, value: string]>;

export interface MuxHttpOpen {
  readonly kind: "http";
  readonly method: string;
  /** Origin-form: path and query. */
  readonly path: string;
  readonly headers: MuxHeaders;
}

export interface MuxWebSocketOpen {
  readonly kind: "ws";
  readonly path: string;
  readonly headers: MuxHeaders;
  readonly protocols: ReadonlyArray<string>;
}

export type MuxOpen = MuxHttpOpen | MuxWebSocketOpen;

/** HTTP status line and headers, or `101` and the chosen subprotocol for a WebSocket. */
export interface MuxResponseHead {
  readonly status: number;
  readonly statusText?: string | undefined;
  readonly headers: MuxHeaders;
  readonly protocol?: string | undefined;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BAD_VALUE = /[\u0000\r\n]/;
const BAD_PATH = /[\u0000- \u007f]/;

const FORWARDED_HEADERS = new Set(["forwarded", "x-real-ip"]);

/**
 * Drops the headers that describe the connection the peer came in on. The device is not a
 * trusted proxy: the host fills these in itself or not at all. Run on every OPEN before a handler
 * sees it.
 */
export const sanitizeForwardedHeaders = (headers: MuxHeaders): MuxHeaders =>
  headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !(
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("cf-") ||
      FORWARDED_HEADERS.has(lower)
    );
  });

export const encodeMetadata = (value: unknown): Uint8Array | undefined => {
  const bytes = textEncoder.encode(JSON.stringify(value));
  return bytes.length <= MUX_MAX_PAYLOAD_BYTES ? bytes : undefined;
};

const invalid = (detail: string) => Result.fail(new MuxProtocolError({ detail }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseHeaders = (value: unknown): Result.Result<MuxHeaders, MuxProtocolError> => {
  if (!Array.isArray(value)) return invalid("Mux headers must be an array.");
  const headers: Array<readonly [string, string]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return invalid("Malformed mux header entry.");
    const [name, headerValue] = entry as ReadonlyArray<unknown>;
    if (typeof name !== "string" || !TOKEN.test(name)) return invalid("Invalid mux header name.");
    if (typeof headerValue !== "string" || BAD_VALUE.test(headerValue)) {
      return invalid("Invalid mux header value.");
    }
    headers.push([name, headerValue]);
  }
  return Result.succeed(headers);
};

const parseJson = (
  payload: Uint8Array,
): Result.Result<Record<string, unknown>, MuxProtocolError> => {
  try {
    const value: unknown = JSON.parse(textDecoder.decode(payload));
    return isRecord(value) ? Result.succeed(value) : invalid("Mux metadata must be an object.");
  } catch {
    return invalid("Mux metadata is not valid JSON.");
  }
};

export const decodeOpen = (payload: Uint8Array): Result.Result<MuxOpen, MuxProtocolError> => {
  const meta = parseJson(payload);
  if (Result.isFailure(meta)) return Result.fail(meta.failure);
  const { kind, path, headers: rawHeaders } = meta.success;
  if (typeof path !== "string" || !path.startsWith("/") || BAD_PATH.test(path)) {
    return invalid("Invalid mux OPEN path.");
  }
  const headers = parseHeaders(rawHeaders);
  if (Result.isFailure(headers)) return Result.fail(headers.failure);
  if (kind === "http") {
    const { method } = meta.success;
    if (typeof method !== "string" || !TOKEN.test(method))
      return invalid("Invalid mux OPEN method.");
    return Result.succeed({ kind, method, path, headers: headers.success });
  }
  if (kind === "ws") {
    const { protocols } = meta.success;
    if (
      !Array.isArray(protocols) ||
      !protocols.every((entry) => typeof entry === "string" && TOKEN.test(entry))
    ) {
      return invalid("Invalid mux OPEN subprotocols.");
    }
    return Result.succeed({
      kind,
      path,
      headers: headers.success,
      protocols: protocols as ReadonlyArray<string>,
    });
  }
  return invalid("Unknown mux OPEN kind.");
};

export const decodeResponseHead = (
  payload: Uint8Array,
): Result.Result<MuxResponseHead, MuxProtocolError> => {
  const meta = parseJson(payload);
  if (Result.isFailure(meta)) return Result.fail(meta.failure);
  const { status, statusText, protocol } = meta.success;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    return invalid("Invalid mux response status.");
  }
  if (statusText !== undefined && (typeof statusText !== "string" || BAD_VALUE.test(statusText))) {
    return invalid("Invalid mux response status text.");
  }
  if (protocol !== undefined && (typeof protocol !== "string" || !TOKEN.test(protocol))) {
    return invalid("Invalid mux response subprotocol.");
  }
  const headers = parseHeaders(meta.success.headers);
  if (Result.isFailure(headers)) return Result.fail(headers.failure);
  return Result.succeed({
    status,
    ...(statusText === undefined ? {} : { statusText }),
    headers: headers.success,
    ...(protocol === undefined ? {} : { protocol }),
  });
};
