import {
  type RelayGrant,
  accountClientSigningInput,
  decodeBase64url,
  encodeBase64url,
  relaySigningInput,
} from "@t3tools/shared/relay";
import { type E2eeDeviceSigner, deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { K3RelayFailureReason } from "../connection/model.ts";
import { k3relayCloseReason } from "./failure.ts";

/**
 * The relay's entrance (spec §4.3): before any E2EE byte, the relay sends a nonce, the device
 * answers with its key, its grant and a signature, and the relay says `accepted`. Pairing
 * connections skip the signature. Everything after `accepted` belongs to the E2EE channel.
 */

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const CLIENT_AUTH_LABEL = "k3relay-v1/client";
const ADMISSION_TIMEOUT = "15 seconds";

export class K3RelayAdmissionError extends Schema.TaggedError<K3RelayAdmissionError>()(
  "K3RelayAdmissionError",
  { reason: K3RelayFailureReason, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type K3RelayAdmission =
  | { readonly kind: "pairing" }
  | {
      readonly kind: "client";
      readonly hostId: string;
      readonly signer: E2eeDeviceSigner;
      readonly grant: RelayGrant;
    }
  /** Through an account (spec §20): a relay ticket instead of a grant; the host still decides. */
  | {
      readonly kind: "account";
      readonly hostId: string;
      readonly signer: E2eeDeviceSigner;
      readonly ticket: string;
    };

const readFailure = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });

const admissionFailure = (reason: K3RelayFailureReason, detail: string) =>
  readFailure(new K3RelayAdmissionError({ reason, detail }));

/** A relay close during admission, as the reason the relay gave. */
const mapAdmissionError = (error: Socket.SocketError): Socket.SocketError => {
  if (error.reason._tag === "SocketCloseError") {
    const reason = k3relayCloseReason(error.reason.code, error.reason.closeReason ?? "");
    if (reason !== null)
      return admissionFailure(reason, `The relay closed with ${error.reason.code}.`);
  }
  if (error.reason._tag === "SocketOpenError") {
    return admissionFailure("relay-unreachable", "The relay did not answer.");
  }
  return error;
};

const decodeText = (frame: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Wraps the raw relay socket; its reader does the admission once, then passes frames through. */
export const admitK3RelaySocket = (
  raw: Socket.Socket,
  admission: K3RelayAdmission,
): Socket.Socket =>
  Socket.make({
    writer: raw.writer,
    reader: Effect.gen(function* () {
      const reader = yield* raw.reader.pipe(Effect.mapError(mapAdmissionError));
      const writer = yield* raw.writer;
      const pending: Array<Uint8Array | string> = [];
      const next = Effect.gen(function* () {
        while (pending.length === 0) {
          pending.push(...(yield* reader.pull.pipe(Effect.mapError(mapAdmissionError))));
        }
        return pending.shift()!;
      });
      const expect = Effect.fnUntraced(function* (type: string) {
        const message = decodeText(yield* next);
        if (!isRecord(message) || message.type !== type) {
          return yield* admissionFailure(
            "unauthorized",
            `The relay sent something other than ${type}.`,
          );
        }
        return message;
      });

      yield* Effect.gen(function* () {
        if (admission.kind === "client") {
          const challenge = yield* expect("nonce");
          const nonce = decodeBase64url(challenge.nonce, 32);
          if (nonce === null) {
            return yield* admissionFailure("unauthorized", "The relay sent a malformed nonce.");
          }
          const { signer, hostId, grant } = admission;
          const deviceId = deviceIdFromPublicKey(signer.alg, signer.publicKey);
          const sig = yield* signer
            .sign(relaySigningInput(CLIENT_AUTH_LABEL, hostId, deviceId, nonce))
            .pipe(
              Effect.mapError(() =>
                admissionFailure("device-key-missing", "The device key could not sign."),
              ),
            );
          yield* writer.write(
            encodeJson({
              type: "auth",
              alg: signer.alg,
              dk: encodeBase64url(signer.publicKey),
              grant,
              sig: encodeBase64url(sig),
            }),
          );
        }
        if (admission.kind === "account") {
          const challenge = yield* expect("nonce");
          const nonce = decodeBase64url(challenge.nonce, 32);
          if (nonce === null) {
            return yield* admissionFailure("unauthorized", "The relay sent a malformed nonce.");
          }
          const { signer, hostId, ticket } = admission;
          const deviceId = deviceIdFromPublicKey(signer.alg, signer.publicKey);
          const sig = yield* signer
            .sign(accountClientSigningInput(hostId, deviceId, nonce))
            .pipe(
              Effect.mapError(() =>
                admissionFailure("device-key-missing", "The device key could not sign."),
              ),
            );
          yield* writer.write(
            encodeJson({
              type: "auth",
              alg: signer.alg,
              dk: encodeBase64url(signer.publicKey),
              token: ticket,
              sig: encodeBase64url(sig),
            }),
          );
        }
        yield* expect("accepted");
      }).pipe(
        Effect.timeoutOrElse({
          duration: ADMISSION_TIMEOUT,
          orElse: () =>
            Effect.fail(
              admissionFailure("host-offline", "The relay did not admit this device in time."),
            ),
        }),
      );

      return {
        upgrade: reader.upgrade,
        pull: Effect.suspend(() => {
          const [first, ...rest] = pending.splice(0);
          return first === undefined ? reader.pull : Effect.succeed([first, ...rest] as const);
        }),
      } satisfies Socket.Reader;
    }),
  });

const isFailureReason = Schema.is(K3RelayFailureReason);

/** Finds the relay's or the host's reason inside a failure from the tunnel's layers. */
export function findK3RelayFailureReason(error: unknown, depth = 0): K3RelayFailureReason | null {
  if (depth > 8 || typeof error !== "object" || error === null) return null;
  const tagged = error as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly cause?: unknown;
    readonly code?: unknown;
    readonly closeReason?: unknown;
  };
  switch (tagged._tag) {
    case "K3RelayAdmissionError":
    case "E2eeRejectedError":
      return isFailureReason(tagged.reason) ? tagged.reason : null;
    case "E2eeIdentityMismatchError":
      return "key-mismatch";
    case "SocketCloseError":
      return typeof tagged.code === "number"
        ? k3relayCloseReason(
            tagged.code,
            typeof tagged.closeReason === "string" ? tagged.closeReason : "",
          )
        : null;
  }
  return (
    findK3RelayFailureReason(tagged.reason, depth + 1) ??
    findK3RelayFailureReason(tagged.cause, depth + 1)
  );
}
