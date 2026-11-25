// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 signing or sync SHA-256.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { encodeBase64url, relayHostId, relaySigningInput } from "@t3tools/shared/relay";
import { identityPublicKeyFromSeed } from "@t3tools/shared/socketE2ee";

/**
 * Registering this host with a K3 relay (`POST /v1/hosts`, spec §4 and §9): a stateless
 * proof-of-work challenge bound to `Hk`, then a signature by `Hk`. The registration is kept in
 * the state directory so the host only registers once per relay and key.
 */

const LABEL_POW = "k3relay-v1/pow";
const LABEL_REGISTER = "k3relay-v1/register";
const MAX_DIFFICULTY = 32;
const POW_BATCH = 4096;
/** PKCS#8 prefix for a raw Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class RelayRegistrationError extends Schema.TaggedError<RelayRegistrationError>()(
  "RelayRegistrationError",
  {
    stage: Schema.Literals(["challenge", "work", "register", "persist"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `K3 relay registration failed at ${this.stage}.`
      : `K3 relay registration failed at ${this.stage} (HTTP ${this.status}).`;
  }
}

/** Signs with the host's Ed25519 seed (`Hk`). */
export const signWithHostSeed = (seed: Uint8Array, message: Uint8Array): Uint8Array => {
  const key = NodeCrypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(NodeCrypto.sign(null, message, key));
};

export interface RelayEndpoints {
  /** `wss://relay.example` or, for loopback development only, `ws://127.0.0.1:8080`. */
  readonly ws: string;
  /** The same origin over HTTP(S), for registration and pairing offers. */
  readonly http: string;
}

const isLoopbackHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** Accepts a bare origin only: `wss:` anywhere, plain `ws:` only on loopback. */
export const relayEndpoints = (value: string): RelayEndpoints | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const loopbackPlain =
    (url.protocol === "ws:" || url.protocol === "http:") && isLoopbackHostname(url.hostname);
  if (!secure && !loopbackPlain) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return {
    ws: `${secure ? "wss" : "ws"}://${url.host}`,
    http: `${secure ? "https" : "http"}://${url.host}`,
  };
};

const leadingZeroBits = (digest: Uint8Array): number => {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

const PowChallenge = Schema.Struct({
  ts: Schema.Number,
  difficulty: Schema.Int,
  salt: Schema.String,
  mac: Schema.String,
});
const decodeChallengeReply = Schema.decodeUnknownOption(Schema.Struct({ challenge: PowChallenge }));
const decodeRegistered = Schema.decodeUnknownOption(Schema.Struct({ hostId: Schema.String }));

/** Finds a solution with `difficulty` leading zero bits, yielding between batches. */
const solveChallenge = Effect.fn("RelayRegistration.solveChallenge")(function* (
  hostIdentityKey: Uint8Array,
  mac: string,
  difficulty: number,
) {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) {
    return yield* new RelayRegistrationError({ stage: "work" });
  }
  const solution = Buffer.alloc(8);
  const limit = 2 ** Math.min(difficulty + 6, 40);
  for (let counter = 0; counter < limit; counter += POW_BATCH) {
    for (let index = counter; index < counter + POW_BATCH; index += 1) {
      solution.writeBigUInt64BE(BigInt(index), 0);
      const digest = NodeCrypto.createHash("sha256")
        .update(relaySigningInput(LABEL_POW, hostIdentityKey, mac, solution))
        .digest();
      if (leadingZeroBits(digest) >= difficulty) return encodeBase64url(solution);
    }
    yield* Effect.yieldNow;
  }
  return yield* new RelayRegistrationError({ stage: "work" });
});

/** Registers `Hk` with the relay; a host the relay already knows is answered with 200. */
export const registerHost = Effect.fn("RelayRegistration.registerHost")(function* (
  endpoints: RelayEndpoints,
  hostIdentitySeed: Uint8Array,
) {
  const http = yield* HttpClient.HttpClient;
  const hostIdentityKey = identityPublicKeyFromSeed(hostIdentitySeed);
  const hk = encodeBase64url(hostIdentityKey);
  const url = `${endpoints.http}/v1/hosts`;
  const post = (body: unknown) =>
    http.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
      Effect.flatMap((response) =>
        Effect.map(
          Effect.orElseSucceed(response.json, () => null),
          (json) => ({ status: response.status, json }),
        ),
      ),
    );
  const first = yield* post({ hk }).pipe(
    Effect.mapError((cause) => new RelayRegistrationError({ stage: "challenge", cause })),
  );
  const reply = first.status === 428 ? decodeChallengeReply(first.json) : undefined;
  if (reply === undefined || reply._tag === "None") {
    return yield* new RelayRegistrationError({ stage: "challenge", status: first.status });
  }
  const challenge = reply.value.challenge;
  const nonce = yield* solveChallenge(hostIdentityKey, challenge.mac, challenge.difficulty);
  const sig = signWithHostSeed(
    hostIdentitySeed,
    relaySigningInput(LABEL_REGISTER, hostIdentityKey, challenge.mac, nonce),
  );
  const second = yield* post({ hk, challenge, nonce, sig: encodeBase64url(sig) }).pipe(
    Effect.mapError((cause) => new RelayRegistrationError({ stage: "register", cause })),
  );
  const registered = decodeRegistered(second.json);
  if (
    (second.status !== 200 && second.status !== 201) ||
    registered._tag === "None" ||
    registered.value.hostId !== relayHostId(hostIdentityKey)
  ) {
    return yield* new RelayRegistrationError({ stage: "register", status: second.status });
  }
  return registered.value.hostId;
});

const RegistrationFile = Schema.Struct({
  version: Schema.Literal(1),
  relayUrl: Schema.String,
  hostId: Schema.String,
  registeredAt: Schema.Number,
});
const decodeRegistrationFile = Schema.decodeUnknownOption(Schema.fromJsonString(RegistrationFile));
const encodeRegistrationFile = Schema.encodeSync(Schema.fromJsonString(RegistrationFile));

const registrationPath = (directory: string, path: Path.Path) => path.join(directory, "host.json");

/** Whether this relay already registered this host key. A corrupt file reads as "no". */
export const isRegistered = Effect.fn("RelayRegistration.isRegistered")(function* (
  directory: string,
  endpoints: RelayEndpoints,
  hostId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(registrationPath(directory, path))
    .pipe(Effect.orElseSucceed(() => ""));
  const file = decodeRegistrationFile(text);
  return (
    file._tag === "Some" && file.value.relayUrl === endpoints.http && file.value.hostId === hostId
  );
});

export const recordRegistration = Effect.fn("RelayRegistration.recordRegistration")(
  function* (directory: string, endpoints: RelayEndpoints, hostId: string, now: number) {
    const path = yield* Path.Path;
    yield* writeFileStringAtomically({
      filePath: registrationPath(directory, path),
      contents: `${encodeRegistrationFile({
        version: 1,
        relayUrl: endpoints.http,
        hostId,
        registeredAt: now,
      })}\n`,
    });
  },
  Effect.mapError((cause) => new RelayRegistrationError({ stage: "persist", cause })),
);

export const forgetRegistration = Effect.fn("RelayRegistration.forgetRegistration")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(registrationPath(directory, path)).pipe(Effect.ignore);
});
