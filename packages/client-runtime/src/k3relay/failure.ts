import type { E2eeRejectionReason } from "@t3tools/shared/socketE2ee";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { translatableDetail } from "../errors/translatable.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type ConnectionHop,
  ConnectionTransientError,
  type K3RelayFailureReason,
} from "../connection/model.ts";

/** The relay's own close codes (`infra/k3-relay` README, "WebSocket"). */
export const K3_RELAY_CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  revoked: 4403,
  hostOffline: 4404,
  timeout: 4408,
  replaced: 4409,
  grantExpired: 4410,
  blocked: 4423,
  limit: 4429,
} as const;

/** A relay close code as the reason to show, or null for an ordinary close. */
export function k3relayCloseReason(code: number, reason = ""): K3RelayFailureReason | null {
  switch (code) {
    case K3_RELAY_CLOSE.badRequest:
    case K3_RELAY_CLOSE.unauthorized:
      return "unauthorized";
    case K3_RELAY_CLOSE.revoked:
      return "revoked";
    case K3_RELAY_CLOSE.hostOffline:
    case K3_RELAY_CLOSE.timeout:
      return "host-offline";
    case K3_RELAY_CLOSE.grantExpired:
      return "grant-expired";
    case K3_RELAY_CLOSE.blocked:
      return "blocked";
    case K3_RELAY_CLOSE.limit:
      return reason === "degraded" ? "degraded" : "limit";
    default:
      return null;
  }
}

export const k3relayRejectionReason = (reason: E2eeRejectionReason): K3RelayFailureReason => reason;

/** Failures a retry can fix on its own; the rest wait for the user. */
const TRANSIENT: ReadonlySet<K3RelayFailureReason> = new Set([
  "host-offline",
  "limit",
  "degraded",
  "relay-unreachable",
]);

const HOP: Record<K3RelayFailureReason, ConnectionHop> = {
  revoked: "server",
  "unknown-device": "server",
  "key-mismatch": "server",
  "grant-expired": "server",
  "host-policy": "server",
  limit: "relay",
  degraded: "relay",
  "host-offline": "relay",
  blocked: "relay",
  unauthorized: "relay",
  "relay-unreachable": "relay",
  "device-key-missing": "device",
};

/** The sentence a screen shows for `reason` (spec §18.7: name the cause). */
export function k3relayFailureText(
  reason: K3RelayFailureReason,
  host: string,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(k3relayFailureMessage(reason, host));
}

function k3relayFailureMessage(reason: K3RelayFailureReason, host: string) {
  switch (reason) {
    case "revoked":
      return msg("{host} revoked this device. Pair it again to reconnect.", { host });
    case "unknown-device":
      return msg("{host} does not know this device. Pair it again to reconnect.", { host });
    case "key-mismatch":
      return msg(
        "{host} answered with a different key than the one saved at pairing. This device did not connect.",
        { host },
      );
    case "grant-expired":
      return msg("This device's relay pass for {host} expired. Pair it again to reconnect.", {
        host,
      });
    case "host-policy":
      return msg("{host} does not allow relay connections right now.", { host });
    case "limit":
      return msg("{host} has too many relay connections open. Close one and retry.", { host });
    case "degraded":
      return msg(
        "The relay is throttling new connections because its monthly traffic is high. LAN and VPN connections are not affected.",
      );
    case "host-offline":
      return msg("{host} is offline or not connected to the relay.", { host });
    case "blocked":
      return msg("The relay operator blocked {host}.", { host });
    case "unauthorized":
      return msg("The relay did not accept this device for {host}.", { host });
    case "relay-unreachable":
      return msg("This device can't reach the relay.");
    case "device-key-missing":
      return msg("This device's key for {host} is missing. Pair it again to reconnect.", {
        host,
      });
  }
}

export function k3relayConnectionError(
  reason: K3RelayFailureReason,
  host: string,
): ConnectionAttemptError {
  const fields = {
    ...translatableDetail(k3relayFailureMessage(reason, host)),
    hop: HOP[reason],
    via: "relay" as const,
    k3relayReason: reason,
  };
  if (TRANSIENT.has(reason)) {
    return new ConnectionTransientError({
      reason: reason === "relay-unreachable" ? "network" : "relay-unavailable",
      ...fields,
    });
  }
  return new ConnectionBlockedError({
    reason:
      reason === "unauthorized" || reason === "device-key-missing"
        ? "authentication"
        : reason === "key-mismatch"
          ? "configuration"
          : "permission",
    ...fields,
  });
}

/** Whether pairing again is the way out (the screen offers it next to the reason). */
export const k3relayNeedsRepair = (reason: K3RelayFailureReason): boolean =>
  reason === "revoked" ||
  reason === "unknown-device" ||
  reason === "grant-expired" ||
  reason === "device-key-missing" ||
  reason === "unauthorized";

const K3_RELAY_NAME = "K3 Relay";

/** What to try next for `reason`, in the order to try it (diagnostics, spec §18.1). */
export function k3relayFailureSteps(
  reason: K3RelayFailureReason,
  host: string,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<string> {
  const repair = resolve(
    msg("On {host}, open Settings > Relay, create a pairing link, and pair this device again.", {
      host,
    }),
  );
  switch (reason) {
    case "revoked":
    case "unknown-device":
    case "grant-expired":
    case "device-key-missing":
    case "unauthorized":
      return [repair];
    case "key-mismatch":
      return [
        resolve(
          msg(
            "If {host} was reinstalled or its key was reset, remove it here and pair again. Otherwise, do not connect: someone may be intercepting the relay.",
            { host },
          ),
        ),
      ];
    case "host-policy":
      return [
        resolve(msg("On {host}, check that the relay is turned on in Settings > Relay.", { host })),
      ];
    case "host-offline":
      return [
        resolve(msg("Make sure {host} is awake and K3 Code is running on it.", { host })),
        resolve(msg("On {host}, check that the relay is turned on in Settings > Relay.", { host })),
      ];
    case "limit":
    case "degraded":
      return [resolve(msg("Wait a few minutes. K3 Code retries on its own."))];
    case "blocked":
      return [resolve(msg("Contact the relay operator, or set up your own relay."))];
    case "relay-unreachable":
      return [
        resolve(msg("Check this device's internet connection.")),
        resolve(msg("A VPN, firewall, or ad blocker on this device can block the relay.")),
      ];
  }
}

export interface K3RelayDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: "ok" | "failed" | "unchecked";
}

/** The hops of a relay connection with the failed one marked: device, relay, then the host. */
export function k3relayDiagnosisHops(
  reason: K3RelayFailureReason,
  host: string,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<K3RelayDiagnosisHop> {
  const order: ReadonlyArray<ConnectionHop> = ["device", "relay", "server"];
  const failed = order.indexOf(HOP[reason]);
  return order.map((hop, index) => ({
    hop,
    label:
      hop === "device"
        ? resolve(msg("This device"))
        : hop === "relay"
          ? K3_RELAY_NAME
          : resolve(msg("K3 Code on {host}", { host })),
    result: index === failed ? "failed" : index < failed ? "ok" : "unchecked",
  }));
}
