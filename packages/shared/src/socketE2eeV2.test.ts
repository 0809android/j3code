import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { p256 } from "@noble/curves/nist.js";

import {
  E2EE_FRAGMENT_BYTES,
  type E2eeDeviceAlgorithm,
  type E2eeDeviceIdentity,
  type E2eeDeviceKeypair,
  type E2eeDeviceSigner,
  E2eeRejectedError,
  type E2eeRejectionReason,
  type E2eeV2ClientOptions,
  type E2eeV2ServerOptions,
  deviceIdFromPublicKey,
  deviceSignerFromKeypair,
  generateDeviceKeypair,
  generateIdentityKeypair,
  hostIdFromIdentityKey,
  wrapClientSocketWithE2ee,
  wrapClientSocketWithE2eeV2,
  wrapServerSocketWithE2ee,
  wrapServerSocketWithE2eeV2,
} from "./socketE2ee.ts";

const ENVIRONMENT_ID = "env-e2ee-v2-test";
const layerE2eeCrypto = Aead.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

type Frame = Uint8Array | string;

const socketEnd = (inbound: Queue.Queue<Frame>, outbound: Queue.Queue<Frame>): Socket.Socket =>
  Socket.make({
    reader: Effect.succeed({
      upgrade: (): Effect.Effect<void, Socket.SocketError> =>
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketUpgradeError({ cause: "unsupported" }),
          }),
        ),
      pull: Effect.map(Queue.take(inbound), (frame) => [frame] as const),
    }),
    writer: Effect.succeed({
      write: (chunk) =>
        Socket.isCloseEvent(chunk) ? Effect.void : Effect.asVoid(Queue.offer(outbound, chunk)),
      writeAll: (chunks) =>
        Effect.forEach(chunks, (chunk) => Queue.offer(outbound, chunk), { discard: true }),
    }),
  });

/**
 * Two hops with the test in the middle: what the client writes lands in
 * `fromClient`, what the test offers to `toServer` reaches the server, and
 * likewise in the other direction.
 */
const makeLink = Effect.gen(function* () {
  const fromClient = yield* Queue.unbounded<Frame>();
  const toServer = yield* Queue.unbounded<Frame>();
  const fromServer = yield* Queue.unbounded<Frame>();
  const toClient = yield* Queue.unbounded<Frame>();
  return {
    client: socketEnd(toClient, fromClient),
    server: socketEnd(toServer, fromServer),
    fromClient,
    toServer,
    fromServer,
    toClient,
  };
});

type Link = Effect.Success<typeof makeLink>;

const relay = (from: Queue.Queue<Frame>, to: Queue.Queue<Frame>, edit = (f: Frame) => f) =>
  Effect.flatMap(Queue.take(from), (frame) => Queue.offer(to, edit(frame)));

/** A direct pair: every frame forwarded untouched. */
const makePair = Effect.gen(function* () {
  const link = yield* makeLink;
  yield* Effect.forkScoped(Effect.forever(relay(link.fromClient, link.toServer)));
  yield* Effect.forkScoped(Effect.forever(relay(link.fromServer, link.toClient)));
  return link;
});

/** Pulls the E2EE failure out of a failed reader acquisition or pull. */
const e2eeCause = (error: unknown): unknown => {
  const reason = (error as { readonly reason?: { readonly _tag?: string } } | undefined)?.reason;
  return reason?._tag === "SocketReadError" || reason?._tag === "SocketWriteError"
    ? (reason as { readonly cause?: unknown }).cause
    : undefined;
};

const tagOf = (value: unknown): string | undefined =>
  (value as { readonly _tag?: string } | undefined)?._tag;

const assertRejected = (error: unknown, reason: E2eeRejectionReason) => {
  const cause = e2eeCause(error);
  assert.instanceOf(cause, E2eeRejectedError, `expected rejection, got ${String(cause)}`);
  assert.equal((cause as E2eeRejectedError).reason, reason);
};

const assertProtocolError = (error: unknown, includes?: string) => {
  const cause = e2eeCause(error);
  assert.equal(tagOf(cause), "E2eeProtocolError", `expected protocol error, got ${String(cause)}`);
  if (includes !== undefined) assert.include(String((cause as Error).message), includes);
};

/** A host ledger: approved device ids, every lookup recorded. */
const makeLedger = (approved: ReadonlyArray<E2eeDeviceKeypair>) => {
  const seen: Array<E2eeDeviceIdentity> = [];
  const ids = new Set(approved.map((key) => deviceIdFromPublicKey(key.alg, key.publicKey)));
  const verifyDevice = (device: E2eeDeviceIdentity) => {
    seen.push(device);
    return ids.has(device.deviceId)
      ? Effect.void
      : Effect.fail(new E2eeRejectedError({ reason: "unknown-device" }));
  };
  return { seen, verifyDevice };
};

const hostOptions = (
  seed: Uint8Array,
  verifyDevice: E2eeV2ServerOptions["verifyDevice"],
  extra: Partial<E2eeV2ServerOptions> = {},
): E2eeV2ServerOptions => ({
  environmentId: ENVIRONMENT_ID,
  identitySeed: seed,
  verifyDevice,
  ...extra,
});

const clientOptions = (
  hostKey: Uint8Array,
  device: E2eeDeviceSigner | undefined,
  extra: Partial<E2eeV2ClientOptions> = {},
): E2eeV2ClientOptions => ({
  environmentId: ENVIRONMENT_ID,
  expectedServerIdentityKey: hostKey,
  device,
  ...extra,
});

/** Runs `body` on an established host connection; fails with the reader's error. */
const host = <A = never, E = never>(
  socket: Socket.Socket,
  options: E2eeV2ServerOptions,
  body: (reader: Socket.Reader, writer: Socket.Writer) => Effect.Effect<A, E> = () =>
    Effect.never as never,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const wrapped = yield* wrapServerSocketWithE2eeV2(socket, options);
      const reader = yield* wrapped.reader;
      return yield* body(reader, yield* wrapped.writer);
    }),
  );

const device = <A = void, E = never>(
  socket: Socket.Socket,
  options: E2eeV2ClientOptions,
  body: (reader: Socket.Reader, writer: Socket.Writer) => Effect.Effect<A, E> = () =>
    Effect.void as never,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const wrapped = yield* wrapClientSocketWithE2eeV2(socket, options);
      const reader = yield* wrapped.reader;
      return yield* body(reader, yield* wrapped.writer);
    }),
  );

const pullOne = (reader: Socket.Reader) =>
  Effect.map(reader.pull, (batch) => {
    assert.equal(batch.length, 1);
    return batch[0]!;
  });

const bytes = (length: number, seed = 7) =>
  Uint8Array.from({ length }, (_, i) => (i * seed + 3) % 256);

/** Forwards both hellos, the confirm and the verdict one by one. */
const handshakeThrough = (link: Link) =>
  Effect.gen(function* () {
    yield* relay(link.fromClient, link.toServer);
    yield* relay(link.fromServer, link.toClient);
    yield* relay(link.fromClient, link.toServer);
    yield* relay(link.fromServer, link.toClient);
  });

describe("socketE2ee v2", () => {
  it.effect("device and host ids are 32 lowercase base32 characters bound to the algorithm", () =>
    Effect.gen(function* () {
      const ed = yield* generateDeviceKeypair("ed25519");
      const nist = yield* generateDeviceKeypair("p256");
      const identity = yield* generateIdentityKeypair();
      assert.equal(ed.publicKey.length, 32);
      assert.equal(nist.publicKey.length, 65);
      assert.equal(nist.publicKey[0], 0x04);
      for (const id of [
        deviceIdFromPublicKey("ed25519", ed.publicKey),
        deviceIdFromPublicKey("p256", nist.publicKey),
        hostIdFromIdentityKey(identity.publicKey),
      ]) {
        assert.match(id, /^[a-z2-7]{32}$/);
      }
      // The same bytes under another algorithm name are another device.
      assert.notEqual(
        deviceIdFromPublicKey("ed25519", ed.publicKey),
        deviceIdFromPublicKey("p256", ed.publicKey),
      );
      for (const keypair of [ed, nist]) {
        const signature = yield* deviceSignerFromKeypair(keypair).sign(new Uint8Array([1, 2, 3]));
        assert.equal(signature.length, 64);
      }
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect.each(["ed25519", "p256"] satisfies ReadonlyArray<E2eeDeviceAlgorithm>)(
    "%s: text, binary and multi-fragment frames round-trip",
    (alg) =>
      Effect.gen(function* () {
        const pair = yield* makePair;
        const identity = yield* generateIdentityKeypair();
        const key = yield* generateDeviceKeypair(alg);
        const ledger = makeLedger([key]);
        const large = bytes(E2EE_FRAGMENT_BYTES * 2 + 1234);
        const largeText = "ü漢🙂".repeat(9000);
        const exact = bytes(E2EE_FRAGMENT_BYTES * 2, 11);

        const hostFiber = yield* Effect.forkScoped(
          host(pair.server, hostOptions(identity.seed, ledger.verifyDevice), (reader, writer) =>
            Effect.gen(function* () {
              for (let index = 0; index < 5; index += 1) {
                yield* writer.write(yield* pullOne(reader));
              }
            }),
          ),
        );
        yield* device(
          pair.client,
          clientOptions(identity.publicKey, deviceSignerFromKeypair(key)),
          (reader, writer) =>
            Effect.gen(function* () {
              for (const frame of ["hello", new Uint8Array([0, 255, 1]), large, largeText, exact]) {
                yield* writer.write(frame);
                const echoed = yield* pullOne(reader);
                if (typeof frame === "string") {
                  assert.equal(echoed, frame);
                } else {
                  assert.instanceOf(echoed, Uint8Array);
                  assert.deepEqual(Array.from(echoed as Uint8Array), Array.from(frame));
                }
              }
            }),
        );
        yield* Fiber.join(hostFiber);
        assert.deepEqual(
          ledger.seen.map((seen) => seen.deviceId),
          [deviceIdFromPublicKey(alg, key.publicKey)],
        );
        assert.equal(ledger.seen[0]!.alg, alg);
      }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("every record on the wire is padded to 256 bytes and carries no plaintext", () =>
    Effect.gen(function* () {
      const link = yield* makeLink;
      const identity = yield* generateIdentityKeypair();
      const key = yield* generateDeviceKeypair("ed25519");
      const ledger = makeLedger([key]);
      const secret = "x".repeat(E2EE_FRAGMENT_BYTES + 10);
      yield* Effect.forkScoped(
        host(link.server, hostOptions(identity.seed, ledger.verifyDevice), (_reader, writer) =>
          Effect.andThen(writer.write(secret), Effect.never),
        ),
      );
      const client = yield* Effect.forkScoped(
        device(
          link.client,
          clientOptions(identity.publicKey, deviceSignerFromKeypair(key)),
          (reader) => pullOne(reader),
        ),
      );
      yield* handshakeThrough(link);
      const records = [
        yield* Queue.take(link.fromServer),
        yield* Queue.take(link.fromServer),
      ] as Array<Uint8Array>;
      for (const record of records) yield* Queue.offer(link.toClient, record);
      assert.equal(yield* Fiber.join(client), secret);
      for (const record of records) {
        assert.instanceOf(record, Uint8Array);
        assert.equal(record.length % 256, 0);
        assert.notInclude(new TextDecoder().decode(record), "xxxxxxxx");
      }
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("another approved device relaying the handshake cannot swap in its own confirm", () =>
    Effect.gen(function* () {
      const identity = yield* generateIdentityKeypair();
      const victim = yield* generateDeviceKeypair("ed25519");
      const attacker = yield* generateDeviceKeypair("p256");
      const ledger = makeLedger([victim, attacker]);

      // The attacker's own, legitimate session gives it a confirm record it can replay.
      const own = yield* makeLink;
      yield* Effect.forkScoped(host(own.server, hostOptions(identity.seed, ledger.verifyDevice)));
      yield* Effect.forkScoped(
        device(
          own.client,
          clientOptions(identity.publicKey, deviceSignerFromKeypair(attacker)),
          () => Effect.never,
        ),
      );
      yield* relay(own.fromClient, own.toServer);
      yield* relay(own.fromServer, own.toClient);
      const attackerConfirm = yield* Queue.take(own.fromClient);
      yield* Queue.offer(own.toServer, attackerConfirm);

      const link = yield* makeLink;
      const hostFiber = yield* Effect.forkScoped(
        Effect.flip(host(link.server, hostOptions(identity.seed, ledger.verifyDevice))),
      );
      yield* Effect.forkScoped(
        device(link.client, clientOptions(identity.publicKey, deviceSignerFromKeypair(victim))),
      );
      yield* relay(link.fromClient, link.toServer);
      yield* relay(link.fromServer, link.toClient);
      yield* Queue.take(link.fromClient);
      yield* Queue.offer(link.toServer, attackerConfirm);
      assertProtocolError(yield* Fiber.join(hostFiber), "decryption failed");
      // Only the attacker's own session was ever authenticated, as the attacker.
      assert.deepEqual(
        ledger.seen.map((seen) => seen.deviceId),
        [deviceIdFromPublicKey("p256", attacker.publicKey)],
      );
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect(
    "a relay that substitutes its own hello authenticates as itself and breaks the victim",
    () =>
      Effect.gen(function* () {
        const identity = yield* generateIdentityKeypair();
        const victim = yield* generateDeviceKeypair("ed25519");
        const attacker = yield* generateDeviceKeypair("ed25519");
        const ledger = makeLedger([victim, attacker]);
        const link = yield* makeLink;
        const side = yield* makeLink;
        const hostFiber = yield* Effect.forkScoped(
          host(link.server, hostOptions(identity.seed, ledger.verifyDevice), () => Effect.void),
        );
        const victimFiber = yield* Effect.forkScoped(
          Effect.flip(
            device(link.client, clientOptions(identity.publicKey, deviceSignerFromKeypair(victim))),
          ),
        );
        yield* Effect.forkScoped(
          device(
            side.client,
            clientOptions(identity.publicKey, deviceSignerFromKeypair(attacker)),
            () => Effect.never,
          ),
        );
        yield* Queue.take(link.fromClient);
        yield* relay(side.fromClient, link.toServer);
        const serverHello = yield* Queue.take(link.fromServer);
        yield* Queue.offer(link.toClient, serverHello);
        yield* Queue.offer(side.toClient, serverHello);
        yield* relay(side.fromClient, link.toServer);
        yield* Fiber.join(hostFiber);
        assertProtocolError(yield* Fiber.join(victimFiber), "signature is invalid");
        assert.deepEqual(
          ledger.seen.map((seen) => seen.deviceId),
          [deviceIdFromPublicKey("ed25519", attacker.publicKey)],
        );
      }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a v2-only host refuses v1 clients, and v1 hosts refuse v2 clients", () =>
    Effect.gen(function* () {
      const identity = yield* generateIdentityKeypair();
      const ledger = makeLedger([]);
      for (const extra of [{}, { acceptV1: true }] satisfies ReadonlyArray<
        Partial<E2eeV2ServerOptions>
      >) {
        const pair = yield* makePair;
        const hostFiber = yield* Effect.forkScoped(
          Effect.flip(host(pair.server, hostOptions(identity.seed, ledger.verifyDevice, extra))),
        );
        yield* Effect.forkScoped(
          Effect.scoped(
            Effect.flatMap(
              wrapClientSocketWithE2ee(pair.client, {
                environmentId: ENVIRONMENT_ID,
                expectedServerIdentityKey: identity.publicKey,
              }),
              (wrapped) => wrapped.reader,
            ),
          ),
        );
        assertProtocolError(yield* Fiber.join(hostFiber), "v1 handshake was refused");
      }

      const pair = yield* makePair;
      const v1Host = yield* Effect.forkScoped(
        Effect.flip(
          Effect.scoped(
            Effect.flatMap(
              wrapServerSocketWithE2ee(pair.server, {
                environmentId: ENVIRONMENT_ID,
                identitySeed: identity.seed,
              }),
              (wrapped) => wrapped.reader,
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(device(pair.client, clientOptions(identity.publicKey, undefined)));
      assertProtocolError(yield* Fiber.join(v1Host), "invalid E2EE handshake");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("rewriting the version bytes to downgrade a v2 client fails its signature check", () =>
    Effect.gen(function* () {
      const identity = yield* generateIdentityKeypair();
      const link = yield* makeLink;
      const ledger = makeLedger([]);
      yield* Effect.forkScoped(
        host(
          link.server,
          hostOptions(identity.seed, ledger.verifyDevice, {
            acceptV1: true,
            requireDeviceAuth: false,
          }),
        ),
      );
      const client = yield* Effect.forkScoped(
        Effect.flip(device(link.client, clientOptions(identity.publicKey, undefined))),
      );
      const setVersion = (version: number) => (frame: Frame) => {
        const copy = Uint8Array.from(frame as Uint8Array);
        copy[1] = version;
        return copy;
      };
      yield* relay(link.fromClient, link.toServer, setVersion(1));
      yield* relay(link.fromServer, link.toClient, setVersion(2));
      assertProtocolError(yield* Fiber.join(client), "signature is invalid");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a direct host that opts in still serves v1 and anonymous v2 clients", () =>
    Effect.gen(function* () {
      const identity = yield* generateIdentityKeypair();
      const ledger = makeLedger([]);
      const options = hostOptions(identity.seed, ledger.verifyDevice, {
        acceptV1: true,
        requireDeviceAuth: false,
      });
      const echo = (reader: Socket.Reader, writer: Socket.Writer) =>
        Effect.flatMap(pullOne(reader), (frame) => writer.write(frame));

      const v1Pair = yield* makePair;
      const v1Host = yield* Effect.forkScoped(host(v1Pair.server, options, echo));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const wrapped = yield* wrapClientSocketWithE2ee(v1Pair.client, {
            environmentId: ENVIRONMENT_ID,
            expectedServerIdentityKey: identity.publicKey,
          });
          const reader = yield* wrapped.reader;
          yield* (yield* wrapped.writer).write('{"v":1}');
          assert.equal(yield* pullOne(reader), '{"v":1}');
        }),
      );
      yield* Fiber.join(v1Host);

      const v2Pair = yield* makePair;
      const v2Host = yield* Effect.forkScoped(host(v2Pair.server, options, echo));
      yield* device(v2Pair.client, clientOptions(identity.publicKey, undefined), (reader, writer) =>
        Effect.gen(function* () {
          yield* writer.write(new Uint8Array([9]));
          assert.deepEqual(Array.from((yield* pullOne(reader)) as Uint8Array), [9]);
        }),
      );
      yield* Fiber.join(v2Host);
      assert.equal(ledger.seen.length, 0);
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a pinned host key that differs fails with an identity mismatch", () =>
    Effect.gen(function* () {
      const pair = yield* makePair;
      const identity = yield* generateIdentityKeypair();
      const rogue = yield* generateIdentityKeypair();
      const key = yield* generateDeviceKeypair("ed25519");
      yield* Effect.forkScoped(
        host(pair.server, hostOptions(identity.seed, makeLedger([key]).verifyDevice)),
      );
      const failure = yield* Effect.flip(
        device(pair.client, clientOptions(rogue.publicKey, deviceSignerFromKeypair(key))),
      );
      assert.equal(tagOf(e2eeCause(failure)), "E2eeIdentityMismatchError");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  describe("forged device signatures are refused as key-mismatch", () => {
    const LABEL_PREFIX_LENGTH = 2 + "k3code-e2ee-v2/client-auth".length;
    const forgeries: ReadonlyArray<{
      readonly name: string;
      readonly forge: (victim: E2eeDeviceKeypair, other: E2eeDeviceKeypair) => E2eeDeviceSigner;
    }> = [
      {
        name: "a flipped bit",
        forge: (victim) => {
          const signer = deviceSignerFromKeypair(victim);
          return {
            ...signer,
            sign: (message) =>
              Effect.map(signer.sign(message), (signature) => {
                const copy = Uint8Array.from(signature);
                copy[10] = (copy[10] ?? 0) ^ 1;
                return copy;
              }),
          };
        },
      },
      {
        name: "a signature without the role label",
        forge: (victim) => {
          const signer = deviceSignerFromKeypair(victim);
          return { ...signer, sign: (message) => signer.sign(message.slice(LABEL_PREFIX_LENGTH)) };
        },
      },
      {
        name: "another device's key behind the victim's public key",
        forge: (victim, other) => ({
          ...deviceSignerFromKeypair(other),
          publicKey: victim.publicKey,
        }),
      },
      {
        name: "a DER-encoded P-256 signature",
        forge: (victim) => ({
          ...deviceSignerFromKeypair(victim),
          sign: (message) =>
            Effect.succeed(p256.sign(message, victim.secretKey, { prehash: true }).toDERRawBytes()),
        }),
      },
    ];
    it.effect.each(forgeries)("$name", ({ forge }) =>
      Effect.gen(function* () {
        const pair = yield* makePair;
        const identity = yield* generateIdentityKeypair();
        const victim = yield* generateDeviceKeypair("p256");
        const other = yield* generateDeviceKeypair("p256");
        const ledger = makeLedger([victim, other]);
        const hostFiber = yield* Effect.forkScoped(
          Effect.flip(host(pair.server, hostOptions(identity.seed, ledger.verifyDevice))),
        );
        const failure = yield* Effect.flip(
          device(pair.client, clientOptions(identity.publicKey, forge(victim, other))),
        );
        assertRejected(failure, "key-mismatch");
        assertRejected(yield* Fiber.join(hostFiber), "key-mismatch");
        assert.equal(ledger.seen.length, 0);
      }).pipe(Effect.provide(layerE2eeCrypto)),
    );
  });

  it.effect(
    "a signature or confirm record from an earlier session does not authenticate a new one",
    () =>
      Effect.gen(function* () {
        const identity = yield* generateIdentityKeypair();
        const key = yield* generateDeviceKeypair("ed25519");
        const ledger = makeLedger([key]);
        const honest = deviceSignerFromKeypair(key);
        let recorded: Uint8Array | undefined;
        const replaying: E2eeDeviceSigner = {
          ...honest,
          sign: (message) =>
            recorded !== undefined
              ? Effect.succeed(recorded)
              : Effect.tap(honest.sign(message), (signature) =>
                  Effect.sync(() => {
                    recorded = signature;
                  }),
                ),
        };

        const first = yield* makeLink;
        yield* Effect.forkScoped(
          host(first.server, hostOptions(identity.seed, ledger.verifyDevice), () => Effect.void),
        );
        const firstClient = yield* Effect.forkScoped(
          device(first.client, clientOptions(identity.publicKey, replaying)),
        );
        yield* relay(first.fromClient, first.toServer);
        yield* relay(first.fromServer, first.toClient);
        const oldConfirm = yield* Queue.take(first.fromClient);
        yield* Queue.offer(first.toServer, oldConfirm);
        yield* relay(first.fromServer, first.toClient);
        yield* Fiber.join(firstClient);

        // The same signature inside a fresh, correctly encrypted confirm.
        const second = yield* makePair;
        const secondHost = yield* Effect.forkScoped(
          Effect.flip(host(second.server, hostOptions(identity.seed, ledger.verifyDevice))),
        );
        assertRejected(
          yield* Effect.flip(device(second.client, clientOptions(identity.publicKey, replaying))),
          "key-mismatch",
        );
        assertRejected(yield* Fiber.join(secondHost), "key-mismatch");

        // The whole confirm record of the first session, replayed into a third.
        const third = yield* makeLink;
        const thirdHost = yield* Effect.forkScoped(
          Effect.flip(host(third.server, hostOptions(identity.seed, ledger.verifyDevice))),
        );
        yield* Effect.forkScoped(device(third.client, clientOptions(identity.publicKey, honest)));
        yield* relay(third.fromClient, third.toServer);
        yield* relay(third.fromServer, third.toClient);
        yield* Queue.take(third.fromClient);
        yield* Queue.offer(third.toServer, oldConfirm);
        assertProtocolError(yield* Fiber.join(thirdHost), "decryption failed");
        assert.equal(ledger.seen.length, 1);
      }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("ledger rejections reach the device as typed reasons over the encrypted channel", () =>
    Effect.gen(function* () {
      const identity = yield* generateIdentityKeypair();
      const key = yield* generateDeviceKeypair("ed25519");
      const reasons: ReadonlyArray<E2eeRejectionReason> = [
        "revoked",
        "unknown-device",
        "grant-expired",
        "host-policy",
        "limit",
      ];
      for (const reason of reasons) {
        const link = yield* makeLink;
        const hostFiber = yield* Effect.forkScoped(
          Effect.flip(
            host(
              link.server,
              hostOptions(identity.seed, () => Effect.fail(new E2eeRejectedError({ reason }))),
            ),
          ),
        );
        const client = yield* Effect.forkScoped(
          Effect.flip(
            device(link.client, clientOptions(identity.publicKey, deviceSignerFromKeypair(key))),
          ),
        );
        yield* relay(link.fromClient, link.toServer);
        yield* relay(link.fromServer, link.toClient);
        yield* relay(link.fromClient, link.toServer);
        const verdict = yield* Queue.take(link.fromServer);
        assert.instanceOf(verdict, Uint8Array);
        assert.equal((verdict as Uint8Array).length % 256, 0);
        assert.notInclude(new TextDecoder().decode(verdict as Uint8Array), reason);
        yield* Queue.offer(link.toClient, verdict);
        assertRejected(yield* Fiber.join(client), reason);
        assertRejected(yield* Fiber.join(hostFiber), reason);
      }
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("a host that requires device auth refuses anonymous v2 clients with host-policy", () =>
    Effect.gen(function* () {
      const pair = yield* makePair;
      const identity = yield* generateIdentityKeypair();
      const hostFiber = yield* Effect.forkScoped(
        Effect.flip(host(pair.server, hostOptions(identity.seed, makeLedger([]).verifyDevice))),
      );
      assertRejected(
        yield* Effect.flip(device(pair.client, clientOptions(identity.publicKey, undefined))),
        "host-policy",
      );
      assertRejected(yield* Fiber.join(hostFiber), "host-policy");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  it.effect("closeWithReason on a live session fails the device's next pull with the reason", () =>
    Effect.gen(function* () {
      const pair = yield* makePair;
      const identity = yield* generateIdentityKeypair();
      const key = yield* generateDeviceKeypair("p256");
      const ledger = makeLedger([key]);
      yield* Effect.forkScoped(
        Effect.scoped(
          Effect.gen(function* () {
            const wrapped = yield* wrapServerSocketWithE2eeV2(
              pair.server,
              hostOptions(identity.seed, ledger.verifyDevice),
            );
            const reader = yield* wrapped.reader;
            yield* (yield* wrapped.writer).write("before");
            yield* pullOne(reader);
            yield* wrapped.closeWithReason("revoked");
            return yield* Effect.never;
          }),
        ),
      );
      const failure = yield* Effect.flip(
        device(
          pair.client,
          clientOptions(identity.publicKey, deviceSignerFromKeypair(key)),
          (reader, writer) =>
            Effect.gen(function* () {
              assert.equal(yield* pullOne(reader), "before");
              yield* writer.write("ack");
              yield* reader.pull;
            }),
        ),
      );
      assertRejected(failure, "revoked");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );

  describe("manipulated records on a live session close it", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly manipulate: (records: ReadonlyArray<Uint8Array>) => ReadonlyArray<Frame>;
      readonly expected: string;
    }> = [
      {
        name: "a flipped ciphertext bit",
        manipulate: ([zero, one]) => {
          const copy = Uint8Array.from(zero!);
          copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
          return [copy, one!];
        },
        expected: "decryption failed",
      },
      { name: "a replayed record", manipulate: ([zero]) => [zero!, zero!], expected: "replayed" },
      {
        name: "reordered records",
        manipulate: ([zero, one]) => [one!, zero!],
        expected: "out of order",
      },
      {
        name: "a truncated record",
        manipulate: ([zero, one]) => [zero!.slice(0, -1), one!],
        expected: "non-canonical length",
      },
      {
        name: "a plaintext frame",
        manipulate: ([zero]) => [zero!, '{"plaintext":true}'],
        expected: "plaintext",
      },
    ];
    it.effect.each(cases)("$name", ({ manipulate, expected }) =>
      Effect.gen(function* () {
        const link = yield* makeLink;
        const identity = yield* generateIdentityKeypair();
        const key = yield* generateDeviceKeypair("ed25519");
        yield* Effect.forkScoped(
          host(
            link.server,
            hostOptions(identity.seed, makeLedger([key]).verifyDevice),
            (_r, writer) =>
              Effect.andThen(
                Effect.andThen(writer.write("zero"), writer.write("one")),
                Effect.never,
              ),
          ),
        );
        const client = yield* Effect.forkScoped(
          Effect.flip(
            device(
              link.client,
              clientOptions(identity.publicKey, deviceSignerFromKeypair(key)),
              (reader) => Effect.andThen(pullOne(reader), pullOne(reader)),
            ),
          ),
        );
        yield* handshakeThrough(link);
        const records = [yield* Queue.take(link.fromServer), yield* Queue.take(link.fromServer)];
        for (const frame of manipulate(records as Array<Uint8Array>)) {
          yield* Queue.offer(link.toClient, frame);
        }
        assertProtocolError(yield* Fiber.join(client), expected);
      }).pipe(Effect.provide(layerE2eeCrypto)),
    );
  });

  it.effect("a frame over the receiver's limit is refused before it is reassembled", () =>
    Effect.gen(function* () {
      const pair = yield* makePair;
      const identity = yield* generateIdentityKeypair();
      const key = yield* generateDeviceKeypair("ed25519");
      yield* Effect.forkScoped(
        host(
          pair.server,
          hostOptions(identity.seed, makeLedger([key]).verifyDevice),
          (_r, writer) =>
            Effect.andThen(writer.write(bytes(E2EE_FRAGMENT_BYTES * 3)), Effect.never),
        ),
      );
      const failure = yield* Effect.flip(
        device(
          pair.client,
          clientOptions(identity.publicKey, deviceSignerFromKeypair(key), {
            maxFrameBytes: E2EE_FRAGMENT_BYTES * 2,
          }),
          (reader) => reader.pull,
        ),
      );
      assertProtocolError(failure, "frame limit");
    }).pipe(Effect.provide(layerE2eeCrypto)),
  );
});
