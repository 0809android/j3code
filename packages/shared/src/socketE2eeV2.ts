import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type E2eeDeviceIdentity,
  type E2eeDeviceSigner,
  deviceIdentity,
  hostIdFromIdentityKey,
  isCanonicalDevicePublicKey,
  isDeviceAlgorithm,
  labeledMessage,
  verifyDeviceSignature,
} from "./socketE2eeDevice.ts";
import {
  type E2eeChannel,
  type E2eeFrameSource,
  type E2eeHandshakeResult,
  type E2eeSessionInfo,
  type E2eeSocket,
  makeE2eeSocket,
} from "./socketE2eeEngine.ts";
import {
  type AeadService,
  CLIENT_HELLO_TYPE,
  DIRECTION_C2S,
  DIRECTION_S2C,
  E2eeIdentityMismatchError,
  E2eeProtocolError,
  type E2eeFailure,
  E2eeRejectedError,
  E2eeRejectionReason,
  type E2eeSession,
  KEY_LENGTH,
  NONCE_LENGTH,
  RECORD_HEADER_LENGTH,
  SERVER_HELLO_TYPE,
  SIGNATURE_LENGTH,
  TAG_LENGTH,
  concatBytes,
  isProtocolError,
  isRejectedError,
  lengthPrefixedBytes,
  openRecord,
  sealRecord,
  timingSafeEqual,
} from "./socketE2eeRecord.ts";
import {
  PROTOCOL_VERSION_1,
  identityFingerprint,
  identityPublicKeyFromSeed,
  serverHandshakeV1,
} from "./socketE2eeV1.ts";

/**
 * Protocol v2: v1's handshake under its own labels, plus device authentication
 * inside the encrypted confirm record, traffic keys bound to the device key,
 * an authenticated rejection record, binary frames, fragmentation and padding.
 */

const PROTOCOL_VERSION_2 = 2;
const RECORD_VERSION = 0x02;
const LABEL_TRANSCRIPT = "k3code-e2ee-v2/transcript";
const LABEL_SERVER_HELLO = "k3code-e2ee-v2/server-hello";
const LABEL_CLIENT_AUTH = "k3code-e2ee-v2/client-auth";
const LABEL_CLIENT_CONFIRM = "k3code-e2ee-v2/client-confirm";

export const E2EE_FRAGMENT_BYTES = 16 * 1024;
const PADDING_BLOCK = 256;
const INNER_HEADER_LENGTH = 3;
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

const KIND_TEXT = 0x01;
const KIND_BINARY = 0x02;
const KIND_MORE = 0x80;
const KIND_CLIENT_AUTH = 0x10;
const KIND_ACCEPT = 0x11;
const KIND_CLOSE = 0x12;

const isRejectionReason = Schema.is(E2eeRejectionReason);

export interface E2eeV2ClientOptions {
  readonly environmentId: string;
  readonly expectedServerIdentityKey: Uint8Array;
  /** Omit only on direct connections that predate device keys, and for pairing. */
  readonly device?: E2eeDeviceSigner | undefined;
  readonly maxFrameBytes?: number | undefined;
}

export interface E2eeV2ServerOptions {
  readonly environmentId: string;
  readonly identitySeed: Uint8Array;
  /** Checks the device against the host's ledger; the device key is the only identity. */
  readonly verifyDevice: (device: E2eeDeviceIdentity) => Effect.Effect<void, E2eeRejectedError>;
  /**
   * Defaults to true. Relay connections must keep it on, except the pairing connection, whose
   * anonymous sessions the caller must route to pairing only (see `requireAuthenticatedDevice`).
   */
  readonly requireDeviceAuth?: boolean | undefined;
  /** Defaults to false. Never honoured while device authentication is required. */
  readonly acceptV1?: boolean | undefined;
  readonly maxFrameBytes?: number | undefined;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const protocolError = (detail: string) => new E2eeProtocolError({ detail });

const transcriptHash = (parts: {
  readonly environmentId: string;
  readonly clientEphemeralPub: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly serverEphemeralPub: Uint8Array;
  readonly serverNonce: Uint8Array;
  readonly serverIdentityPub: Uint8Array;
}): Uint8Array =>
  sha256(
    labeledMessage(
      LABEL_TRANSCRIPT,
      utf8(parts.environmentId),
      parts.clientEphemeralPub,
      parts.clientNonce,
      parts.serverEphemeralPub,
      parts.serverNonce,
      parts.serverIdentityPub,
    ),
  );

/** A low-order peer key yields no shared secret; refuse it rather than die. */
const sharedSecretWith = (privateKey: Uint8Array, peerPublicKey: Uint8Array) =>
  Effect.try({
    try: () => x25519.getSharedSecret(privateKey, peerPublicKey),
    catch: () => protocolError("The peer's ephemeral key is invalid."),
  });

const aeadKey = (sharedSecret: Uint8Array, transcript: Uint8Array, info: Uint8Array) =>
  Aead.key(Aead.xchacha20Poly1305, hkdf(sha256, sharedSecret, transcript, info, KEY_LENGTH));

/** Anonymous direct clients bind to an empty algorithm and key. */
const deriveTrafficKeys = Effect.fnUntraced(function* (
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  alg: string,
  devicePublicKey: Uint8Array,
) {
  const info = (direction: string) =>
    labeledMessage(`k3code-e2ee-v2/${direction}`, utf8(alg), devicePublicKey);
  return {
    c2s: yield* aeadKey(sharedSecret, transcript, info("c2s")),
    s2c: yield* aeadKey(sharedSecret, transcript, info("s2c")),
  } as const;
});

const clientAuthMessage = (transcript: Uint8Array, identityPub: Uint8Array): Uint8Array =>
  labeledMessage(
    LABEL_CLIENT_AUTH,
    transcript,
    identityPub,
    utf8(hostIdFromIdentityKey(identityPub)),
  );

const encodeClientHello = (ephemeralPub: Uint8Array, nonce: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([CLIENT_HELLO_TYPE, PROTOCOL_VERSION_2]), ephemeralPub, nonce);

const decodeClientHello = (frame: Uint8Array) =>
  frame.length === 2 + KEY_LENGTH + NONCE_LENGTH
    ? { ephemeralPub: frame.slice(2, 2 + KEY_LENGTH), nonce: frame.slice(2 + KEY_LENGTH) }
    : undefined;

const SERVER_HELLO_FIXED_LENGTH = 2 + KEY_LENGTH * 3 + SIGNATURE_LENGTH;

const encodeServerHello = (hello: {
  readonly ephemeralPub: Uint8Array;
  readonly nonce: Uint8Array;
  readonly identityPub: Uint8Array;
  readonly signature: Uint8Array;
  readonly environmentId: string;
}): Uint8Array =>
  concatBytes(
    new Uint8Array([SERVER_HELLO_TYPE, PROTOCOL_VERSION_2]),
    hello.ephemeralPub,
    hello.nonce,
    hello.identityPub,
    hello.signature,
    lengthPrefixedBytes(utf8(hello.environmentId)),
  );

const decodeServerHello = (frame: Uint8Array) => {
  const fixed = SERVER_HELLO_FIXED_LENGTH;
  if (
    frame.length < fixed + 2 ||
    frame[0] !== SERVER_HELLO_TYPE ||
    frame[1] !== PROTOCOL_VERSION_2 ||
    frame.length !== fixed + 2 + (((frame[fixed] ?? 0) << 8) | (frame[fixed + 1] ?? 0))
  ) {
    return undefined;
  }
  let offset = 2;
  return {
    ephemeralPub: frame.slice(offset, (offset += KEY_LENGTH)),
    nonce: frame.slice(offset, (offset += NONCE_LENGTH)),
    identityPub: frame.slice(offset, (offset += KEY_LENGTH)),
    signature: frame.slice(offset, (offset += SIGNATURE_LENGTH)),
  };
};

/** Pads so the whole wire record is a multiple of the padding block. */
const encodeInner = (kind: number, body: Uint8Array): Uint8Array => {
  const overhead = RECORD_HEADER_LENGTH + INNER_HEADER_LENGTH + TAG_LENGTH;
  const wire = Math.ceil((overhead + body.length) / PADDING_BLOCK) * PADDING_BLOCK;
  const inner = new Uint8Array(wire - RECORD_HEADER_LENGTH - TAG_LENGTH);
  inner[0] = kind;
  inner[1] = body.length >> 8;
  inner[2] = body.length & 0xff;
  inner.set(body, INNER_HEADER_LENGTH);
  return inner;
};

const MAX_RECORD_LENGTH =
  RECORD_HEADER_LENGTH +
  encodeInner(KIND_BINARY, new Uint8Array(E2EE_FRAGMENT_BYTES)).length +
  TAG_LENGTH;

const decodeInner = (inner: Uint8Array) => {
  if (inner.length < INNER_HEADER_LENGTH) return undefined;
  const length = ((inner[1] ?? 0) << 8) | (inner[2] ?? 0);
  const end = INNER_HEADER_LENGTH + length;
  if (end > inner.length || length > E2EE_FRAGMENT_BYTES) return undefined;
  for (let index = end; index < inner.length; index += 1) {
    if (inner[index] !== 0) return undefined;
  }
  return { kind: inner[0] ?? 0, body: inner.slice(INNER_HEADER_LENGTH, end) };
};

const sealInner = (
  session: E2eeSession,
  aead: AeadService,
  direction: number,
  kind: number,
  body: Uint8Array,
) => sealRecord(session, aead, encodeInner(kind, body), direction, RECORD_VERSION);

const openInner = Effect.fnUntraced(function* (
  session: E2eeSession,
  aead: AeadService,
  frame: Uint8Array,
  direction: number,
) {
  if (frame.length % PADDING_BLOCK !== 0 || frame.length > MAX_RECORD_LENGTH) {
    return yield* protocolError("E2EE record has a non-canonical length.");
  }
  const inner = decodeInner(yield* openRecord(session, aead, frame, direction, RECORD_VERSION));
  if (inner === undefined) return yield* protocolError("E2EE record framing is invalid.");
  return inner;
});

const readClose = (body: Uint8Array) => {
  const reason = new TextDecoder().decode(body);
  return isRejectionReason(reason)
    ? new E2eeRejectedError({ reason })
    : protocolError("The host sent an unknown rejection reason.");
};

const makeV2Channel = (
  session: E2eeSession,
  aead: AeadService,
  role: "client" | "server",
  maxFrameBytes: number,
): E2eeChannel => {
  const sendDirection = role === "client" ? DIRECTION_C2S : DIRECTION_S2C;
  const recvDirection = role === "client" ? DIRECTION_S2C : DIRECTION_C2S;
  let closed = false;
  let pending: { kind: number; parts: Array<Uint8Array>; size: number } | undefined;

  const send = Effect.fnUntraced(function* (writer: Socket.Writer, chunk: Uint8Array | string) {
    if (closed) return yield* protocolError("The E2EE session was closed.");
    const bytes = typeof chunk === "string" ? utf8(chunk) : chunk;
    if (bytes.length > maxFrameBytes) {
      return yield* protocolError("The frame exceeds the E2EE frame limit.");
    }
    const kind = typeof chunk === "string" ? KIND_TEXT : KIND_BINARY;
    let offset = 0;
    do {
      const end = Math.min(offset + E2EE_FRAGMENT_BYTES, bytes.length);
      const more = end < bytes.length;
      const record = yield* sealInner(
        session,
        aead,
        sendDirection,
        more ? kind | KIND_MORE : kind,
        bytes.subarray(offset, end),
      );
      yield* writer.write(record);
      offset = end;
    } while (offset < bytes.length);
  });

  const reassemble = Effect.fnUntraced(function* (kind: number, body: Uint8Array) {
    const more = (kind & KIND_MORE) !== 0;
    const type = kind & ~KIND_MORE;
    if (pending !== undefined && pending.kind !== type) {
      return yield* protocolError("E2EE fragments changed frame type.");
    }
    if (more && body.length !== E2EE_FRAGMENT_BYTES) {
      return yield* protocolError("E2EE fragment has a non-canonical size.");
    }
    const size = (pending?.size ?? 0) + body.length;
    if (size > maxFrameBytes) {
      return yield* protocolError("The frame exceeds the E2EE frame limit.");
    }
    if (more) {
      pending ??= { kind: type, parts: [], size: 0 };
      pending.parts.push(body);
      pending.size = size;
      return [];
    }
    const whole = pending === undefined ? body : concatBytes(...pending.parts, body);
    pending = undefined;
    if (type === KIND_BINARY) return [whole];
    return [
      yield* Effect.try({
        try: () => strictUtf8.decode(whole),
        catch: () => protocolError("E2EE text frame is not valid UTF-8."),
      }),
    ];
  });

  const receive = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (closed) return yield* protocolError("The E2EE session was closed.");
    const { kind, body } = yield* openInner(session, aead, chunk, recvDirection);
    const type = kind & ~KIND_MORE;
    if (type === KIND_TEXT || type === KIND_BINARY) return yield* reassemble(kind, body);
    if (kind === KIND_CLOSE && role === "client") {
      closed = true;
      return yield* readClose(body);
    }
    return yield* protocolError("Unexpected E2EE record kind.");
  });

  const sendClose = Effect.fnUntraced(function* (
    writer: Socket.Writer,
    reason: E2eeRejectionReason,
  ) {
    if (closed || role !== "server") return;
    closed = true;
    yield* writer.write(yield* sealInner(session, aead, sendDirection, KIND_CLOSE, utf8(reason)));
  });

  return { send, receive, sendClose };
};

/** Receive failures surface as protocol or rejection errors, never as raw AEAD errors. */
const mapReceiveError = (error: E2eeFailure): E2eeFailure =>
  isProtocolError(error) || isRejectedError(error)
    ? error
    : protocolError("E2EE record decryption failed.");

const decryptionFailed = (error: E2eeFailure): E2eeFailure =>
  isProtocolError(error) ? error : protocolError("E2EE record decryption failed.");

type ClientAuth =
  | { readonly _tag: "anonymous" }
  | {
      readonly _tag: "device";
      readonly alg: string;
      readonly publicKey: Uint8Array;
      readonly signature: Uint8Array;
    };

const encodeClientAuth = (signer: E2eeDeviceSigner, signature: Uint8Array): Uint8Array =>
  concatBytes(
    lengthPrefixedBytes(utf8(signer.alg)),
    lengthPrefixedBytes(signer.publicKey),
    lengthPrefixedBytes(signature),
  );

const decodeClientAuth = (body: Uint8Array): ClientAuth | undefined => {
  if (body.length === 0) return { _tag: "anonymous" };
  const fields: Array<Uint8Array> = [];
  let offset = 0;
  while (fields.length < 3) {
    if (offset + 2 > body.length) return undefined;
    const length = ((body[offset] ?? 0) << 8) | (body[offset + 1] ?? 0);
    offset += 2;
    if (offset + length > body.length) return undefined;
    fields.push(body.slice(offset, (offset += length)));
  }
  if (offset !== body.length) return undefined;
  const [alg, publicKey, signature] = fields as [Uint8Array, Uint8Array, Uint8Array];
  return { _tag: "device", alg: new TextDecoder().decode(alg), publicKey, signature };
};

const clientHandshake = Effect.fn("socketE2ee.clientHandshakeV2")(function* (
  source: E2eeFrameSource,
  writer: Socket.Writer,
  aead: AeadService,
  options: E2eeV2ClientOptions,
) {
  const random = yield* SecureRandom.SecureRandom;
  const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const clientNonce = Uint8Array.from(yield* random.randomBytes(NONCE_LENGTH));
  yield* writer.write(encodeClientHello(ephemeralPub, clientNonce));
  const hello = decodeServerHello(yield* source.next);
  if (hello === undefined) {
    return yield* protocolError("The server sent an invalid E2EE v2 handshake.");
  }
  const transcript = transcriptHash({
    environmentId: options.environmentId,
    clientEphemeralPub: ephemeralPub,
    clientNonce,
    serverEphemeralPub: hello.ephemeralPub,
    serverNonce: hello.nonce,
    serverIdentityPub: hello.identityPub,
  });
  if (
    !ed25519.verify(
      hello.signature,
      labeledMessage(LABEL_SERVER_HELLO, transcript),
      hello.identityPub,
      {
        zip215: false,
      },
    )
  ) {
    return yield* protocolError("The server's E2EE handshake signature is invalid.");
  }
  if (!timingSafeEqual(hello.identityPub, options.expectedServerIdentityKey)) {
    return yield* new E2eeIdentityMismatchError({
      pinnedFingerprint: identityFingerprint(options.expectedServerIdentityKey),
      receivedFingerprint: identityFingerprint(hello.identityPub),
    });
  }
  const sharedSecret = yield* sharedSecretWith(ephemeralPriv, hello.ephemeralPub);
  const device = options.device;
  const authBody =
    device === undefined
      ? new Uint8Array(0)
      : encodeClientAuth(
          device,
          yield* device.sign(clientAuthMessage(transcript, hello.identityPub)),
        );
  const confirmKey = yield* aeadKey(sharedSecret, transcript, labeledMessage(LABEL_CLIENT_CONFIRM));
  const confirmRecord = yield* sealInner(
    { sendKey: confirmKey, recvKey: confirmKey, sendCounter: 0, recvCounter: 0 },
    aead,
    DIRECTION_C2S,
    KIND_CLIENT_AUTH,
    authBody,
  );
  const keys = yield* deriveTrafficKeys(
    sharedSecret,
    transcript,
    device?.alg ?? "",
    device?.publicKey ?? new Uint8Array(0),
  );
  // Counter 0 in each direction belongs to the handshake: the confirm and the verdict.
  const session: E2eeSession = {
    sendKey: keys.c2s,
    recvKey: keys.s2c,
    sendCounter: 1,
    recvCounter: 0,
  };
  yield* writer.write(confirmRecord);
  const confirm = Effect.gen(function* () {
    const verdict = yield* Effect.mapError(
      openInner(session, aead, yield* source.next, DIRECTION_S2C),
      decryptionFailed,
    );
    if (verdict.kind === KIND_CLOSE) return yield* readClose(verdict.body);
    if (verdict.kind !== KIND_ACCEPT || verdict.body.length !== 0) {
      return yield* protocolError("The server sent an invalid E2EE verdict.");
    }
  });
  return {
    channel: makeV2Channel(
      session,
      aead,
      "client",
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    ),
    confirm,
    info: sessionInfoFor(
      transcript,
      device === undefined ? undefined : deviceIdentity(device.alg, device.publicKey),
    ),
  } satisfies E2eeHandshakeResult;
});

const sessionInfoFor = (
  transcript: Uint8Array,
  device: E2eeDeviceIdentity | undefined,
): E2eeSessionInfo =>
  device === undefined
    ? { version: 2, transcriptHash: transcript, deviceAuthenticated: false, device: undefined }
    : { version: 2, transcriptHash: transcript, deviceAuthenticated: true, device };

type Verdict = { readonly accepted: E2eeSessionInfo } | { readonly rejected: E2eeRejectionReason };

/** Decides the verdict for a decrypted confirm record. */
const authenticate = Effect.fnUntraced(function* (
  auth: ClientAuth,
  transcript: Uint8Array,
  identityPub: Uint8Array,
  options: E2eeV2ServerOptions,
) {
  if (auth._tag === "anonymous") {
    return options.requireDeviceAuth === false
      ? ({ accepted: sessionInfoFor(transcript, undefined) } satisfies Verdict)
      : ({ rejected: "host-policy" } satisfies Verdict);
  }
  if (!isDeviceAlgorithm(auth.alg) || !isCanonicalDevicePublicKey(auth.alg, auth.publicKey)) {
    return yield* protocolError("The device key is not canonical.");
  }
  if (
    !verifyDeviceSignature(
      auth.alg,
      auth.publicKey,
      clientAuthMessage(transcript, identityPub),
      auth.signature,
    )
  ) {
    return { rejected: "key-mismatch" } satisfies Verdict;
  }
  const device = deviceIdentity(auth.alg, auth.publicKey);
  const ledger = yield* Effect.result(options.verifyDevice(device));
  if (Result.isFailure(ledger)) return { rejected: ledger.failure.reason } satisfies Verdict;
  return { accepted: sessionInfoFor(transcript, device) } satisfies Verdict;
});

const serverHandshake = Effect.fn("socketE2ee.serverHandshakeV2")(function* (
  source: E2eeFrameSource,
  writer: Socket.Writer,
  aead: AeadService,
  options: E2eeV2ServerOptions,
) {
  const helloFrame = yield* source.next;
  if (helloFrame[0] !== CLIENT_HELLO_TYPE) {
    return yield* protocolError("The client sent an invalid E2EE handshake.");
  }
  if (helloFrame[1] === PROTOCOL_VERSION_1) {
    if (options.acceptV1 !== true || options.requireDeviceAuth !== false) {
      return yield* protocolError("The host requires E2EE v2; the v1 handshake was refused.");
    }
    return yield* serverHandshakeV1(helloFrame, source, writer, aead, options);
  }
  const hello = helloFrame[1] === PROTOCOL_VERSION_2 ? decodeClientHello(helloFrame) : undefined;
  if (hello === undefined) {
    return yield* protocolError("The client sent an invalid E2EE handshake.");
  }
  const seed = options.identitySeed;
  const identityPub = identityPublicKeyFromSeed(seed);
  const random = yield* SecureRandom.SecureRandom;
  const ephemeralPriv = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const serverNonce = Uint8Array.from(yield* random.randomBytes(NONCE_LENGTH));
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
      signature: ed25519.sign(labeledMessage(LABEL_SERVER_HELLO, transcript), seed),
      environmentId: options.environmentId,
    }),
  );
  const sharedSecret = yield* sharedSecretWith(ephemeralPriv, hello.ephemeralPub);
  const confirmKey = yield* aeadKey(sharedSecret, transcript, labeledMessage(LABEL_CLIENT_CONFIRM));
  // Only the holder of the client ephemeral key can produce this record, so a
  // relayed handshake cannot carry another device's authentication.
  const confirm = yield* Effect.mapError(
    openInner(
      { sendKey: confirmKey, recvKey: confirmKey, sendCounter: 0, recvCounter: 0 },
      aead,
      yield* source.next,
      DIRECTION_C2S,
    ),
    decryptionFailed,
  );
  const auth = confirm.kind === KIND_CLIENT_AUTH ? decodeClientAuth(confirm.body) : undefined;
  if (auth === undefined) {
    return yield* protocolError("The E2EE client authentication record is invalid.");
  }
  const verdict: Verdict = yield* authenticate(auth, transcript, identityPub, options);
  const keys = yield* deriveTrafficKeys(
    sharedSecret,
    transcript,
    auth._tag === "device" ? auth.alg : "",
    auth._tag === "device" ? auth.publicKey : new Uint8Array(0),
  );
  const session: E2eeSession = {
    sendKey: keys.s2c,
    recvKey: keys.c2s,
    sendCounter: 0,
    recvCounter: 1,
  };
  const channel = makeV2Channel(
    session,
    aead,
    "server",
    options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  );
  if ("rejected" in verdict) {
    yield* channel.sendClose!(writer, verdict.rejected);
    yield* writer.write(new Socket.CloseEvent(1008));
    return yield* new E2eeRejectedError({ reason: verdict.rejected });
  }
  yield* writer.write(
    yield* sealInner(session, aead, DIRECTION_S2C, KIND_ACCEPT, new Uint8Array(0)),
  );
  return { channel, info: verdict.accepted } satisfies E2eeHandshakeResult;
});

/** Client side of v2: pins the host key and, when it has one, authenticates the device key. */
export const wrapClientSocketWithE2eeV2 = Effect.fn("socketE2ee.wrapClientSocketV2")(function* (
  socket: Socket.Socket,
  options: E2eeV2ClientOptions,
) {
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const wrapped: E2eeSocket = yield* makeE2eeSocket(
    socket,
    (source, writer) =>
      clientHandshake(source, writer, aead, options).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
      ),
    { mapReceiveError },
  );
  return wrapped;
});

/**
 * Host side of v2. By default it accepts only v2 with device authentication,
 * which is what the relay transport needs; direct connections may opt into
 * anonymous v2 and the v1 fallback.
 */
export const wrapServerSocketWithE2eeV2 = Effect.fn("socketE2ee.wrapServerSocketV2")(function* (
  socket: Socket.Socket,
  options: E2eeV2ServerOptions,
) {
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const wrapped: E2eeSocket = yield* makeE2eeSocket(
    socket,
    (source, writer) =>
      serverHandshake(source, writer, aead, options).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
      ),
    { mapReceiveError },
  );
  return wrapped;
});

/**
 * A view of a host socket that serves only device-authenticated v2 sessions: once the handshake
 * is done, an anonymous (pairing) or v1 session is closed with `host-policy`, and its reader and
 * writer fail. Hand this view, never the raw socket, to anything other than pairing.
 */
export const requireAuthenticatedDevice = (socket: E2eeSocket): E2eeSocket => {
  const authorize = (side: "read" | "write") =>
    Effect.flatMap(socket.sessionInfo, (info) => {
      if (info.version === 2 && info.deviceAuthenticated) return Effect.void;
      const cause = new E2eeRejectedError({ reason: "host-policy" });
      return Effect.andThen(
        socket.closeWithReason("host-policy"),
        Effect.fail(
          new Socket.SocketError({
            reason:
              side === "read"
                ? new Socket.SocketReadError({ cause })
                : new Socket.SocketWriteError({ cause }),
          }),
        ),
      );
    });
  const guarded = Socket.make({
    reader: Effect.tap(socket.reader, () => authorize("read")),
    writer: Effect.map(socket.writer, (writer) => {
      const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
        Socket.isCloseEvent(chunk)
          ? writer.write(chunk)
          : Effect.andThen(authorize("write"), writer.write(chunk));
      return {
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      } satisfies Socket.Writer;
    }),
  });
  return Object.assign(guarded, {
    closeWithReason: socket.closeWithReason,
    sessionInfo: socket.sessionInfo,
  }) satisfies E2eeSocket;
};
