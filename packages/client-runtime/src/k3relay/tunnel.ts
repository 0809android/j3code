import {
  type MuxClient,
  type MuxConnectionClosedError,
  makeMuxClient,
  makeMuxFetch,
  makeMuxWebSocket,
} from "@t3tools/shared/mux";
import { type RelayGrant, relayHostId, verifyGrantSignature } from "@t3tools/shared/relay";
import {
  type E2eeDeviceSigner,
  type E2eeSessionInfo,
  type E2eeSocket,
  deviceIdFromPublicKey,
  requireAuthenticatedDevice,
  wrapClientSocketWithE2eeV2,
} from "@t3tools/shared/socketE2ee";
import type * as Aead from "effect/crypto/Aead";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import { K3_RELAY_PROVISIONAL_ORIGIN, k3RelayE2eeEnvironmentId } from "@t3tools/contracts";

import type { ConnectionTransport, K3RelayFailureReason } from "../connection/model.ts";
import {
  type K3RelayAdmission,
  admitK3RelaySocket,
  findK3RelayFailureReason,
} from "./admission.ts";
import { K3RelayAdmissionError } from "./admission.ts";

const RELAY_OPEN_TIMEOUT = "15 seconds";

/** What reaching one host needs; every field comes from the pairing record. */
export interface K3RelayTunnelInput {
  readonly relayUrl: string;
  readonly hostId: string;
  /** The pinned `Hk`. The handshake fails unless the host proves this exact key. */
  readonly hostIdentityKey: Uint8Array;
  readonly signer: E2eeDeviceSigner;
  readonly grant: RelayGrant;
}

/** A live multiplexed E2EE channel to one host, with `fetch` and `WebSocket` over it. */
export interface K3RelayTunnel {
  readonly mux: MuxClient;
  readonly transport: ConnectionTransport;
  readonly session: E2eeSessionInfo;
  /** Completes when the channel is gone; the reason names the relay's or host's verdict. */
  readonly closed: Effect.Effect<MuxConnectionClosedError>;
}

export const k3relaySocketUrl = (relayUrl: string, hostId: string, pairing: boolean): string => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/client/${hostId}`;
  url.search = pairing ? "?pairing=1" : "";
  url.hash = "";
  return url.toString();
};

const fail = (reason: K3RelayFailureReason, detail: string) =>
  Effect.fail(new K3RelayAdmissionError({ reason, detail }));

/** Checks everything a connection would expose before opening one: a mismatch never dials. */
export const checkK3RelayTunnelInput = Effect.fn("K3Relay.checkTunnelInput")(function* (
  input: K3RelayTunnelInput,
) {
  if (relayHostId(input.hostIdentityKey) !== input.hostId) {
    return yield* fail("key-mismatch", "The saved host key does not match the host id.");
  }
  const deviceId = deviceIdFromPublicKey(input.signer.alg, input.signer.publicKey);
  const { grant } = input;
  if (
    grant.hostId !== input.hostId ||
    grant.deviceId !== deviceId ||
    grant.alg !== input.signer.alg ||
    !verifyGrantSignature(grant, input.hostIdentityKey)
  ) {
    return yield* fail("unauthorized", "The saved relay pass does not belong to this device.");
  }
  if (grant.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return yield* fail("grant-expired", "The saved relay pass expired.");
  }
});

/** The E2EE socket over the relay, after admission. Nothing runs until its reader is acquired. */
export const makeK3RelayE2eeSocket = Effect.fn("K3Relay.makeE2eeSocket")(function* (
  input: Pick<K3RelayTunnelInput, "relayUrl" | "hostId" | "hostIdentityKey"> & {
    readonly admission: K3RelayAdmission;
    readonly device?: E2eeDeviceSigner | undefined;
    readonly grant?: RelayGrant | undefined;
  },
) {
  const raw = yield* Socket.makeWebSocket(
    k3relaySocketUrl(input.relayUrl, input.hostId, input.admission.kind === "pairing"),
    { openTimeout: RELAY_OPEN_TIMEOUT },
  );
  const socket: E2eeSocket = yield* wrapClientSocketWithE2eeV2(
    admitK3RelaySocket(raw, input.admission),
    {
      environmentId: k3RelayE2eeEnvironmentId(input.hostId),
      expectedServerIdentityKey: input.hostIdentityKey,
      device: input.device,
      grant: input.grant,
    },
  );
  return socket;
});

/** The reason to show for a tunnel that failed or closed. */
export const k3relayTunnelFailureReason = (error: unknown): K3RelayFailureReason =>
  findK3RelayFailureReason(error) ?? "relay-unreachable";

export const openK3RelayTunnel: (
  input: K3RelayTunnelInput,
) => Effect.Effect<
  K3RelayTunnel,
  K3RelayAdmissionError,
  Scope.Scope | Socket.WebSocketConstructor | Aead.Aead | SecureRandom.SecureRandom
> = Effect.fn("K3Relay.openTunnel")(function* (input: K3RelayTunnelInput) {
  yield* checkK3RelayTunnelInput(input);
  const e2ee = yield* makeK3RelayE2eeSocket({
    ...input,
    admission: { kind: "client", hostId: input.hostId, signer: input.signer, grant: input.grant },
    device: input.signer,
    grant: input.grant,
  });
  // The client never serves an anonymous or v1 session, even if a bug let one through.
  const guarded = requireAuthenticatedDevice(e2ee);
  const mux = yield* makeMuxClient({ socket: guarded }).pipe(
    Effect.mapError(
      (error) =>
        new K3RelayAdmissionError({
          reason: k3relayTunnelFailureReason(error),
          detail: error.message,
        }),
    ),
  );
  const session = yield* e2ee.sessionInfo.pipe(
    Effect.mapError(
      (error) =>
        new K3RelayAdmissionError({
          reason: k3relayTunnelFailureReason(error),
          detail: error.message,
        }),
    ),
  );
  const fetch = makeMuxFetch(mux, { baseUrl: K3_RELAY_PROVISIONAL_ORIGIN });
  const MuxWebSocket = makeMuxWebSocket(mux, { baseUrl: K3_RELAY_PROVISIONAL_ORIGIN });
  const transport: ConnectionTransport = {
    fetch,
    webSocketConstructor: (url, protocols) =>
      new MuxWebSocket(url, protocols === undefined ? [] : protocols),
  };
  return { mux, transport, session, closed: mux.closed } satisfies K3RelayTunnel;
});
