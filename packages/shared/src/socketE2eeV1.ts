import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Socket from "effect/socket/Socket";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type E2eeChannel,
  type E2eeFrameSource,
  type E2eeHandshakeResult,
  makeE2eeSocket,
} from "./socketE2eeEngine.ts";
import {
  type AeadService,
  CLIENT_HELLO_TYPE,
  DIRECTION_C2S,
  DIRECTION_S2C,
  type E2eeFailure,
  E2eeIdentityMismatchError,
  E2eeProtocolError,
  type E2eeSession,
  isProtocolError,
  KEY_LENGTH,
  NONCE_LENGTH,
  SERVER_HELLO_TYPE,
  SIGNATURE_LENGTH,
  concatBytes,
  openRecord,
  sealRecord,
  timingSafeEqual,
} from "./socketE2eeRecord.ts";

/**
 * Protocol v1: an Ed25519 host identity pinned by the client, an ephemeral
 * X25519 handshake, HKDF-SHA256, and an empty key-confirmation record. Text only.
 */

export const PROTOCOL_VERSION_1 = 1;
const TRANSCRIPT_PREFIX = "k3code-e2ee-v1";
const C2S_INFO = "k3code-e2ee-v1-c2s";
const S2C_INFO = "k3code-e2ee-v1-s2c";
const RECORD_VERSION = 0x01;

export interface E2eeIdentityKeypair {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
}

export const identityPublicKeyFromSeed = (seed: Uint8Array): Uint8Array => {
  if (seed.length !== KEY_LENGTH) {
    throw new E2eeProtocolError({ detail: "The Ed25519 identity seed must be 32 bytes." });
  }
  return ed25519.getPublicKey(seed);
};

export const generateIdentityKeypair = Effect.fn("socketE2ee.generateIdentityKeypair")(
  function* () {
    const random = yield* SecureRandom.SecureRandom;
    const seed = yield* random.randomBytes(KEY_LENGTH);
    return {
      seed: Uint8Array.from(seed),
      publicKey: identityPublicKeyFromSeed(Uint8Array.from(seed)),
    } satisfies E2eeIdentityKeypair;
  },
);

/** `XXXX-XXXX-XXXX-XXXX` over the first 8 bytes of SHA-256 of the public key. */
export const identityFingerprint = (publicKey: Uint8Array): string => {
  const digest = sha256(publicKey).slice(0, 8);
  return (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .match(/.{4}/g) ?? []
  )
    .join("-")
    .toUpperCase();
};

export const encodeIdentityKey = (publicKey: Uint8Array): string => Base64Url.encode(publicKey);

export const decodeIdentityKey = (value: string): Uint8Array | undefined => {
  try {
    const bytes = Result.getOrThrow(Base64Url.decode(value));
    return bytes.length === KEY_LENGTH ? Uint8Array.from(bytes) : undefined;
  } catch {
    return undefined;
  }
};

/** Length-prefix an environment id so the transcript framing is unambiguous. */
const lengthPrefixed = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 0xffff) {
    throw new E2eeProtocolError({ detail: "Environment id is too long for the E2EE transcript." });
  }
  return concatBytes(new Uint8Array([encoded.length >> 8, encoded.length & 0xff]), encoded);
};

const deriveRecordKeys = Effect.fn("socketE2ee.deriveRecordKeys")(function* (
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
) {
  const c2sBytes = hkdf(
    sha256,
    sharedSecret,
    transcript,
    new TextEncoder().encode(C2S_INFO),
    KEY_LENGTH,
  );
  const s2cBytes = hkdf(
    sha256,
    sharedSecret,
    transcript,
    new TextEncoder().encode(S2C_INFO),
    KEY_LENGTH,
  );
  const c2s = yield* Aead.key(Aead.xchacha20Poly1305, c2sBytes);
  const s2c = yield* Aead.key(Aead.xchacha20Poly1305, s2cBytes);
  return { c2s, s2c } as const;
});

const transcriptHash = (parts: {
  readonly environmentId: string;
  readonly clientEphemeralPub: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly serverEphemeralPub: Uint8Array;
  readonly serverNonce: Uint8Array;
  readonly serverIdentityPub: Uint8Array;
}): Uint8Array =>
  sha256(
    concatBytes(
      new TextEncoder().encode(TRANSCRIPT_PREFIX),
      lengthPrefixed(parts.environmentId),
      parts.clientEphemeralPub,
      parts.clientNonce,
      parts.serverEphemeralPub,
      parts.serverNonce,
      parts.serverIdentityPub,
    ),
  );

const encodeClientHello = (ephemeralPub: Uint8Array, nonce: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([CLIENT_HELLO_TYPE, PROTOCOL_VERSION_1]), ephemeralPub, nonce);

const decodeClientHello = (
  frame: Uint8Array,
): { readonly ephemeralPub: Uint8Array; readonly nonce: Uint8Array } | undefined => {
  if (
    frame.length !== 2 + KEY_LENGTH + NONCE_LENGTH ||
    frame[0] !== CLIENT_HELLO_TYPE ||
    frame[1] !== PROTOCOL_VERSION_1
  ) {
    return undefined;
  }
  return {
    ephemeralPub: frame.slice(2, 2 + KEY_LENGTH),
    nonce: frame.slice(2 + KEY_LENGTH),
  };
};

const encodeServerHello = (hello: {
  readonly ephemeralPub: Uint8Array;
  readonly nonce: Uint8Array;
  readonly identityPub: Uint8Array;
  readonly signature: Uint8Array;
  readonly environmentId: string;
}): Uint8Array =>
  concatBytes(
    new Uint8Array([SERVER_HELLO_TYPE, PROTOCOL_VERSION_1]),
    hello.ephemeralPub,
    hello.nonce,
    hello.identityPub,
    hello.signature,
    lengthPrefixed(hello.environmentId),
  );

const decodeServerHello = (
  frame: Uint8Array,
):
  | {
      readonly ephemeralPub: Uint8Array;
      readonly nonce: Uint8Array;
      readonly identityPub: Uint8Array;
      readonly signature: Uint8Array;
      readonly environmentId: string;
    }
  | undefined => {
  const fixedLength = 2 + KEY_LENGTH * 3 + SIGNATURE_LENGTH;
  if (
    frame.length < fixedLength + 2 ||
    frame[0] !== SERVER_HELLO_TYPE ||
    frame[1] !== PROTOCOL_VERSION_1
  ) {
    return undefined;
  }
  const environmentIdLength = ((frame[fixedLength] ?? 0) << 8) | (frame[fixedLength + 1] ?? 0);
  if (frame.length !== fixedLength + 2 + environmentIdLength) {
    return undefined;
  }
  let offset = 2;
  const ephemeralPub = frame.slice(offset, (offset += KEY_LENGTH));
  const nonce = frame.slice(offset, (offset += NONCE_LENGTH));
  const identityPub = frame.slice(offset, (offset += KEY_LENGTH));
  const signature = frame.slice(offset, (offset += SIGNATURE_LENGTH));
  const environmentId = new TextDecoder().decode(frame.slice(offset + 2));
  return { ephemeralPub, nonce, identityPub, signature, environmentId };
};

const makeV1Channel = (
  session: E2eeSession,
  aead: AeadService,
  role: "client" | "server",
): E2eeChannel => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sendDirection = role === "client" ? DIRECTION_C2S : DIRECTION_S2C;
  const recvDirection = role === "client" ? DIRECTION_S2C : DIRECTION_C2S;
  return {
    send: (writer, chunk) =>
      Effect.flatMap(
        sealRecord(
          session,
          aead,
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          sendDirection,
          RECORD_VERSION,
        ),
        (record) => writer.write(record),
      ),
    receive: (chunk) =>
      Effect.map(openRecord(session, aead, chunk, recvDirection, RECORD_VERSION), (plaintext) => [
        decoder.decode(plaintext),
      ]),
  };
};

/** v1 receive failures surface as protocol errors, never as raw AEAD errors. */
const mapV1ReceiveError = (error: E2eeFailure): E2eeFailure =>
  isProtocolError(error)
    ? error
    : new E2eeProtocolError({ detail: "E2EE record decryption failed." });

const clientHandshakeV1 = Effect.fn("socketE2ee.clientHandshake")(function* (
  source: E2eeFrameSource,
  writer: Socket.Writer,
  aead: AeadService,
  options: { readonly environmentId: string; readonly expectedServerIdentityKey: Uint8Array },
) {
  const random = yield* SecureRandom.SecureRandom;
  const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const clientNonce = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  yield* writer.write(encodeClientHello(ephemeralPub, clientNonce));
  const hello = decodeServerHello(yield* source.next);
  if (hello === undefined) {
    return yield* new E2eeProtocolError({
      detail: "The server sent an invalid E2EE handshake.",
    });
  }
  const transcript = transcriptHash({
    environmentId: options.environmentId,
    clientEphemeralPub: ephemeralPub,
    clientNonce,
    serverEphemeralPub: hello.ephemeralPub,
    serverNonce: hello.nonce,
    serverIdentityPub: hello.identityPub,
  });
  if (!ed25519.verify(hello.signature, transcript, hello.identityPub)) {
    return yield* new E2eeProtocolError({
      detail: "The server's E2EE handshake signature is invalid.",
    });
  }
  if (!timingSafeEqual(hello.identityPub, options.expectedServerIdentityKey)) {
    return yield* new E2eeIdentityMismatchError({
      pinnedFingerprint: identityFingerprint(options.expectedServerIdentityKey),
      receivedFingerprint: identityFingerprint(hello.identityPub),
    });
  }
  const sharedSecret = x25519.getSharedSecret(ephemeralPriv, hello.ephemeralPub);
  const keys = yield* deriveRecordKeys(sharedSecret, transcript);
  const session: E2eeSession = {
    sendKey: keys.c2s,
    recvKey: keys.s2c,
    sendCounter: 0,
    recvCounter: 0,
  };
  // Key confirmation: an empty record under the c2s key before any RPC.
  yield* writer.write(
    yield* sealRecord(session, aead, new Uint8Array(0), DIRECTION_C2S, RECORD_VERSION),
  );
  return {
    channel: makeV1Channel(session, aead, "client"),
    info: anonymousV1Info(transcript),
  } satisfies E2eeHandshakeResult;
});

/** v1 never authenticates a device. */
const anonymousV1Info = (transcript: Uint8Array) =>
  ({
    version: 1,
    transcriptHash: transcript,
    deviceAuthenticated: false,
    device: undefined,
    grant: undefined,
  }) as const;

/** The server half of v1, given the client hello the caller already pulled. */
export const serverHandshakeV1 = Effect.fn("socketE2ee.serverHandshake")(function* (
  helloFrame: Uint8Array,
  source: E2eeFrameSource,
  writer: Socket.Writer,
  aead: AeadService,
  options: { readonly environmentId: string; readonly identitySeed: Uint8Array },
) {
  const seed = options.identitySeed;
  const identityPub = identityPublicKeyFromSeed(seed);
  const hello = decodeClientHello(helloFrame);
  if (hello === undefined) {
    return yield* new E2eeProtocolError({
      detail: "The client sent an invalid E2EE handshake.",
    });
  }
  const random = yield* SecureRandom.SecureRandom;
  const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const serverNonce = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  const transcript = transcriptHash({
    environmentId: options.environmentId,
    clientEphemeralPub: hello.ephemeralPub,
    clientNonce: hello.nonce,
    serverEphemeralPub: ephemeralPub,
    serverNonce,
    serverIdentityPub: identityPub,
  });
  yield* writer.write(
    encodeServerHello({
      ephemeralPub,
      nonce: serverNonce,
      identityPub,
      signature: ed25519.sign(transcript, seed),
      environmentId: options.environmentId,
    }),
  );
  const sharedSecret = x25519.getSharedSecret(ephemeralPriv, hello.ephemeralPub);
  const keys = yield* deriveRecordKeys(sharedSecret, transcript);
  const session: E2eeSession = {
    sendKey: keys.s2c,
    recvKey: keys.c2s,
    sendCounter: 0,
    recvCounter: 0,
  };
  // The client's empty confirm record proves it derived the same keys.
  const confirm = yield* openRecord(
    session,
    aead,
    yield* source.next,
    DIRECTION_C2S,
    RECORD_VERSION,
  );
  if (confirm.length !== 0) {
    return yield* new E2eeProtocolError({
      detail: "The E2EE key confirmation record was not empty.",
    });
  }
  return {
    channel: makeV1Channel(session, aead, "server"),
    info: anonymousV1Info(transcript),
  } satisfies E2eeHandshakeResult;
});

/**
 * Client side: verify the pinned server identity, then encrypt every frame.
 * The handshake re-runs per connection, so each reconnect derives fresh
 * ephemeral keys.
 */
export const wrapClientSocketWithE2ee = Effect.fn("socketE2ee.wrapClientSocket")(function* (
  socket: Socket.Socket,
  options: {
    readonly environmentId: string;
    readonly expectedServerIdentityKey: Uint8Array;
  },
) {
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const wrapped = yield* makeE2eeSocket(
    socket,
    (source, writer) =>
      clientHandshakeV1(source, writer, aead, options).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
      ),
    { mapReceiveError: mapV1ReceiveError },
  );
  return wrapped as Socket.Socket;
});

/** Server side: sign the handshake with the environment's identity key. */
export const wrapServerSocketWithE2ee = Effect.fn("socketE2ee.wrapServerSocket")(function* (
  socket: Socket.Socket,
  options: {
    readonly environmentId: string;
    readonly identitySeed: Uint8Array;
  },
) {
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const wrapped = yield* makeE2eeSocket(
    socket,
    (source, writer) =>
      Effect.flatMap(source.next, (hello) =>
        serverHandshakeV1(hello, source, writer, aead, options),
      ).pipe(Effect.provideService(SecureRandom.SecureRandom, random)),
    { mapReceiveError: mapV1ReceiveError },
  );
  return wrapped as Socket.Socket;
});
