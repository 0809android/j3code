import { type RelayGrant, encodeBase64url, relaySigningInput } from "@t3tools/shared/relay";
import { type E2eeDeviceSigner, deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const STATUS_LABEL = "k3relay-v1/status";
const STATUS_TIMEOUT_MS = 8_000;

/**
 * What `POST /v1/client/<hostId>/status` says (spec §18.3). An unknown host and a bad signature
 * answer the same `unauthorized`, so only a device the host approved learns anything more.
 */
export type K3RelayHostPresence =
  | {
      readonly kind: "reachable";
      readonly online: boolean;
      readonly state: "ok" | "squeezed" | "blocked";
      readonly month: { readonly bytes: number; readonly limit: number } | null;
    }
  | { readonly kind: "revoked" }
  | { readonly kind: "grant-expired" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "unreachable" };

const StatusBody = Schema.Struct({
  online: Schema.Boolean,
  state: Schema.optionalKey(Schema.Literals(["ok", "squeezed", "blocked"])),
  month: Schema.optionalKey(Schema.Struct({ bytes: Schema.Number, limit: Schema.Number })),
});
const decodeStatusBody = Schema.decodeUnknownOption(StatusBody);
const encodeStatusRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function k3relayEndpointUrl(relayUrl: string, path: string): string {
  const base = new URL(relayUrl);
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}${path}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export const fetchK3RelayHostPresence = Effect.fn("K3Relay.fetchHostPresence")(function* (input: {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly signer: E2eeDeviceSigner;
  readonly grant: RelayGrant;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const random = yield* SecureRandom.SecureRandom;
  const ts = yield* Clock.currentTimeMillis;
  const nonce = encodeBase64url(Uint8Array.from(yield* random.randomBytes(16)));
  const { signer, hostId } = input;
  const deviceId = deviceIdFromPublicKey(signer.alg, signer.publicKey);
  const sig = yield* signer.sign(
    relaySigningInput(STATUS_LABEL, hostId, deviceId, String(ts), nonce),
  );
  const doFetch = input.fetch ?? globalThis.fetch;
  const body = encodeStatusRequest({
    alg: signer.alg,
    dk: encodeBase64url(signer.publicKey),
    grant: input.grant,
    ts,
    nonce,
    sig: encodeBase64url(sig),
  });
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      doFetch(k3relayEndpointUrl(input.relayUrl, `/v1/client/${hostId}/status`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]),
        redirect: "error",
        cache: "no-store",
      }),
    catch: () => "unreachable" as const,
  }).pipe(Effect.option);
  if (response._tag === "None") return { kind: "unreachable" } satisfies K3RelayHostPresence;
  const answer: unknown = yield* Effect.tryPromise({
    try: () => response.value.json(),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  const status = response.value.status;
  if (status === 200) {
    const parsed = decodeStatusBody(answer);
    if (parsed._tag === "None") return { kind: "unreachable" } satisfies K3RelayHostPresence;
    return {
      kind: "reachable",
      online: parsed.value.online,
      state: parsed.value.state ?? "ok",
      month: parsed.value.month ?? null,
    } satisfies K3RelayHostPresence;
  }
  const error =
    typeof answer === "object" && answer !== null
      ? (answer as { readonly error?: unknown }).error
      : null;
  if (status === 403 && error === "revoked")
    return { kind: "revoked" } satisfies K3RelayHostPresence;
  if (status === 403 && error === "grant-expired") {
    return { kind: "grant-expired" } satisfies K3RelayHostPresence;
  }
  if (status === 429) return { kind: "rate-limited" } satisfies K3RelayHostPresence;
  if (status === 401) return { kind: "unauthorized" } satisfies K3RelayHostPresence;
  return { kind: "unreachable" } satisfies K3RelayHostPresence;
});
