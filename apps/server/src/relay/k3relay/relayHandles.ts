import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { encodeBase64url } from "@t3tools/shared/relay";

import { relayDeviceIdOf } from "../../auth/transportSecurity.ts";

/**
 * What a relayed device gets instead of a signed URL (spec §12): an unguessable name for claims
 * kept in memory, redeemed only by a request the connector built for the same E2E device. Module
 * state, since the RPC socket that issues and the HTTP route that redeems run in different layers.
 */

export type RelayHandleKind = "asset" | "upload";

interface Entry {
  readonly deviceId: string;
  readonly kind: RelayHandleKind;
  readonly claims: unknown;
  readonly expiresAt: number;
}

/** Oldest out first. A device asking for more than this at once loses its oldest handles. */
const MAX_HANDLES = 4096;

const entries = new Map<string, Entry>();

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{32}$/u;

const newHandle = () => encodeBase64url(crypto.getRandomValues(new Uint8Array(24)));

const sweep = (now: number) => {
  for (const [handle, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(handle);
  }
  while (entries.size >= MAX_HANDLES) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
  }
};

/** Keeps `claims` for the device until `expiresAt`, and names them with a fresh handle. */
export const issueRelayHandle = (input: {
  readonly deviceId: string;
  readonly kind: RelayHandleKind;
  readonly claims: unknown;
  readonly expiresAt: number;
}) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    sweep(now);
    const handle = newHandle();
    entries.set(handle, {
      deviceId: input.deviceId,
      kind: input.kind,
      claims: input.claims,
      expiresAt: input.expiresAt,
    });
    return handle;
  });

/**
 * The claims behind a handle, for a request the connector built for the device it was issued to.
 * Any other request, device, kind or an expired handle gets nothing, the same way.
 */
export const redeemRelayHandle = (
  request: { readonly source?: object | undefined },
  kind: RelayHandleKind,
  handle: string,
) =>
  Effect.map(Clock.currentTimeMillis, (now): unknown => {
    if (!HANDLE_PATTERN.test(handle)) return undefined;
    const deviceId = relayDeviceIdOf(request);
    const entry = entries.get(handle);
    if (deviceId === undefined || entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      entries.delete(handle);
      return undefined;
    }
    return entry.deviceId === deviceId && entry.kind === kind ? entry.claims : undefined;
  });

/** Drops every handle of a device, as revoking it does. */
export const forgetRelayHandlesOf = (deviceId: string) =>
  Effect.sync(() => {
    for (const [handle, entry] of entries) {
      if (entry.deviceId === deviceId) entries.delete(handle);
    }
  });
