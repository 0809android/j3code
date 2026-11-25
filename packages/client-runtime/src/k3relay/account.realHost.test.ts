// @effect-diagnostics nodeBuiltinImport:off -- loads the real host and relay test kits at run time.
// @effect-diagnostics globalFetchInEffect:off -- plays the browser, which follows plain redirects.
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  type K3RelayAccountState,
  type K3RelayHostState,
  K3RelayHostState as K3RelayHostStateSchema,
  K3_RELAY_PROVISIONAL_ORIGIN,
  WS_METHODS,
} from "@t3tools/contracts";
import { DpopPublicJwk } from "@t3tools/shared/dpop";
import { deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { resolveRemoteDpopWebSocketConnectionUrl } from "../authorization/remote.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as DpopProof from "../relay/dpopProof.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  type K3RelayAccountSession,
  completeK3RelayAccountSignIn,
  connectK3RelayAccountHost,
  listK3RelayAccountHosts,
  startK3RelayAccountSignIn,
} from "./account.ts";
import { K3RELAY_VIRTUAL_WS_ORIGIN, k3relayTunnelInput, overTransport } from "./broker.ts";
import * as DeviceKeyStore from "./deviceKeyStore.ts";
import { layerTestCrypto, layerWebSocketGlobal } from "./k3relay.testkit.ts";
import { type K3RelayPairingProgress, redeemK3RelayPairing } from "./pairing.ts";
import { openK3RelayTunnel } from "./tunnel.ts";

/**
 * Accounts end to end (spec §20): a fake GitHub / Google, the real `infra/k3-relay` with
 * accounts on, the server's real `RelayConnector` and `RelayAccount`, and this client runtime.
 * The host signs in through its loopback listener, the device through `k3relay://`, and the
 * device only gets in once the host's user approves it.
 */

// ── The fake provider and the relay's account settings, from infra/k3-relay ──

interface FakeUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly login: string;
  readonly avatar: string;
}

interface FakeProvider {
  readonly origin: string;
  user: FakeUser;
  close(): Promise<void>;
}

interface AccountTestkit {
  startFakeProvider(): Promise<FakeProvider>;
  accountConfig(fake: FakeProvider): object;
  readonly PUBLIC_URL: string;
}

interface RealHost {
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  readonly environmentId: string;
  readonly state: () => Promise<K3RelayHostState>;
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly createPairingOffer: () => Promise<unknown>;
  readonly approvePairing: (deviceId: string, confirmationCode?: string) => Promise<unknown>;
  readonly rejectPairing: () => Promise<void>;
  readonly account: {
    readonly signIn: (provider: "github" | "google" | "apple") => Promise<{ authorizeUrl: string }>;
    readonly signOut: () => Promise<void>;
    readonly state: () => Promise<K3RelayAccountState>;
    readonly awaitState: (
      predicate: (state: K3RelayAccountState) => boolean,
      timeoutMs?: number,
    ) => Promise<K3RelayAccountState>;
    readonly setApproval: (input: {
      readonly requireApproval: boolean;
      readonly acknowledgedRisk: boolean;
    }) => Promise<K3RelayAccountState>;
  };
  readonly dispose: () => Promise<void>;
}

interface RealHostTestkit {
  startK3RelayTestRelayHandle(
    overrides: object,
  ): Promise<{ url: string; dispose(): Promise<void> }>;
  startK3RelayTestHost(options: { readonly relayUrl: string }): Promise<RealHost>;
}

const load = <A>(relative: string) =>
  Effect.promise(
    async () =>
      (await import(
        /* @vite-ignore */ NodeURL.fileURLToPath(new URL(relative, import.meta.url))
      )) as A,
  );

const loadHostTestkit = load<RealHostTestkit>(
  "../../../../apps/server/src/relay/k3relay/k3relayHost.testkit.ts",
);
const loadAccountTestkit = load<AccountTestkit>(
  "../../../../infra/k3-relay/src/account.testkit.ts",
);

/** A fake provider and a relay with accounts on, for the scope. */
const startWorld = Effect.gen(function* () {
  const accounts = yield* loadAccountTestkit;
  const hosts = yield* loadHostTestkit;
  const fake = yield* Effect.acquireRelease(
    Effect.promise(() => accounts.startFakeProvider()),
    (provider) => Effect.promise(() => provider.close()),
  );
  const relay = yield* Effect.acquireRelease(
    Effect.promise(() => hosts.startK3RelayTestRelayHandle(accounts.accountConfig(fake))),
    (handle) => Effect.promise(() => handle.dispose()),
  );
  const relayHttp = relay.url.replace(/^ws:/u, "http:");
  /**
   * The browser: signs in at the provider, which sends it to the relay's public callback (served
   * here by the local relay), which sends it on to the app's return address.
   */
  const browse = (authorizeUrl: string) =>
    Effect.promise(async () => {
      const atProvider = await fetch(authorizeUrl, { redirect: "manual" });
      const toRelay = new URL(atProvider.headers.get("location") ?? "");
      expect(toRelay.origin).toBe(accounts.PUBLIC_URL);
      const atRelay = await fetch(`${relayHttp}${toRelay.pathname}${toRelay.search}`, {
        redirect: "manual",
      });
      expect(atRelay.status).toBe(302);
      return atRelay.headers.get("location") ?? "";
    });
  const startHost = Effect.acquireRelease(
    Effect.promise(() => hosts.startK3RelayTestHost({ relayUrl: relay.url })),
    (host) => Effect.promise(() => host.dispose()),
  );
  return { fake, relay, relayHttp, browse, startHost };
});

type World = Effect.Success<typeof startWorld>;

/** The host's user signs it in, in a browser on the host's machine. */
const signInHost = (world: World, host: RealHost, provider: "github" | "google" = "github") =>
  Effect.gen(function* () {
    const { authorizeUrl } = yield* Effect.promise(() => host.account.signIn(provider));
    const back = new URL(yield* world.browse(authorizeUrl));
    // The provider's answer comes back to this machine only.
    expect(back.hostname).toBe("127.0.0.1");
    const delivered = yield* Effect.promise(() => fetch(back));
    expect(delivered.status).toBe(200);
    const state = yield* Effect.promise(() =>
      host.account.awaitState(
        (next) => (next.signedIn || next.lastError !== null) && !next.signInPending,
      ),
    );
    expect(state.lastError).toBeNull();
    return state;
  });

const signInDevice = (world: World, provider: "github" | "google" = "github") =>
  Effect.gen(function* () {
    const started = yield* startK3RelayAccountSignIn({ relayUrl: world.relay.url, provider });
    const callback = yield* world.browse(started.authorizeUrl);
    expect(callback.startsWith("k3relay://account/callback?")).toBe(true);
    return yield* completeK3RelayAccountSignIn(started.pending, callback);
  });

// ── The device's platform pieces, as in realHost.test.ts ─────────────────────

const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

const webCryptoDpopKey = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.promise(
    () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
  );
  const publicJwk = yield* Effect.promise(() =>
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ).pipe(Effect.flatMap(decodePublicJwk), Effect.orDie);
  const privateKey = yield* Signature.privateKeyFromCryptoKey(
    Signature.ecdsaP256,
    pair.privateKey,
  ).pipe(Effect.orDie);
  return {
    publicJwk,
    sign: (data) => signature.sign(privateKey, data).pipe(Effect.orDie),
  } satisfies DpopProof.DpopProofKey;
});

const layerDevice = Layer.mergeAll(
  layerTestCrypto,
  DeviceKeyStore.layerMemory(),
  FetchHttpClient.layer,
  DpopProof.layerSigner({ keyStore: "indexed-db", loadOrCreateKey: webCryptoDpopKey }).pipe(
    Layer.provide(
      Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      ),
    ),
  ),
  SecureRandom.layerWebCrypto,
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Test phone", deviceType: "mobile" },
  }),
);

const HostRpcs = RpcGroup.make(
  Rpc.make("relayProbe.whoami", {
    success: Schema.Struct({ subject: Schema.String, transport: Schema.String }),
  }),
  Rpc.make(WS_METHODS.k3RelaySubscribe, {
    payload: Schema.Struct({}),
    success: K3RelayHostStateSchema,
    stream: true,
  }),
);

const openRpc = (transport: Parameters<typeof overTransport>[0] & object, accessToken: string) =>
  Effect.gen(function* () {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
      wsBaseUrl: K3RELAY_VIRTUAL_WS_ORIGIN,
      httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
      accessToken,
      createProof: (input) => signer.createProof(input),
    }).pipe(overTransport(transport));
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
      ).pipe(
        Layer.provide(Socket.layerWebSocket(url)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (socketUrl, options) =>
            transport.webSocketConstructor(
              socketUrl,
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provide(protocol));
  });

/** Knocks through the account and reports the code the device shows. */
const knock = (session: K3RelayAccountSession, host: RealHost, approvalTimeoutMs?: number) =>
  Effect.gen(function* () {
    const progress = yield* Queue.unbounded<K3RelayPairingProgress>();
    const listed = yield* listK3RelayAccountHosts(session);
    const entry = listed.find((candidate) => candidate.hostId === host.hostId);
    assert(entry !== undefined);
    const fiber = yield* connectK3RelayAccountHost(
      session,
      entry,
      { deviceName: "Kino's phone", ...(approvalTimeoutMs ? { approvalTimeoutMs } : {}) },
      (next) => Queue.offer(progress, next).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);
    const deviceCode = Effect.gen(function* () {
      while (true) {
        const next = yield* Queue.take(progress);
        if (next.phase === "awaiting-approval") return next.confirmationCode;
      }
    });
    return { fiber, deviceCode };
  });

describe("K3 Relay accounts, end to end", () => {
  it.live(
    "signs in on the host and the device, lists the host, waits for approval, then connects",
    () =>
      Effect.gen(function* () {
        const world = yield* startWorld;
        const host = yield* world.startHost;
        const signedIn = yield* signInHost(world, host);
        expect(signedIn).toMatchObject({
          signedIn: true,
          provider: "github",
          requireApproval: true,
        });

        const session = yield* signInDevice(world);
        const listed = yield* listK3RelayAccountHosts(session);
        expect(listed.map((entry) => entry.hostId)).toEqual([host.hostId]);

        const { fiber, deviceCode } = yield* knock(session, host);
        const code = yield* deviceCode;
        const waiting = (yield* Effect.promise(() =>
          host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
        )).pairing;
        assert(waiting.phase === "awaiting-approval");
        // The same code on both screens; the name came over E2EE, not through the relay.
        expect(waiting.confirmationCode).toBe(code);
        expect(waiting.deviceName).toBe("Kino's phone");
        const accountState = yield* Effect.promise(() =>
          host.account.awaitState((state) => state.pendingDevice !== null),
        );
        expect(accountState.pendingDevice).toEqual({ deviceId: waiting.deviceId, oneTap: false });
        // Nothing is in the ledger until the user approves.
        expect((yield* Effect.promise(() => host.state())).devices).toEqual([]);

        // No "Add device" window was open, so the user compares codes: approving needs the code.
        expect(waiting.approval).toBe("compare-code");
        const withoutCode = yield* Effect.promise(() =>
          host.approvePairing(waiting.deviceId).then(
            () => null,
            (error: unknown) => error,
          ),
        );
        expect(withoutCode).toMatchObject({ failure: "confirmation-required" });
        yield* Effect.promise(() =>
          host.approvePairing(waiting.deviceId, waiting.confirmationCode),
        );
        const paired = yield* Fiber.join(fiber);
        expect(deviceIdFromPublicKey(paired.signer.alg, paired.signer.publicKey)).toBe(
          waiting.deviceId,
        );

        const registration = yield* redeemK3RelayPairing(paired);
        expect(registration.target.environmentId).toBe(host.environmentId);
        const tunnel = yield* openK3RelayTunnel(yield* k3relayTunnelInput(registration.profile));
        const rpc = yield* openRpc(tunnel.transport, registration.credential.accessToken);
        expect(yield* rpc["relayProbe.whoami"]()).toEqual({
          subject: `relay-paired-device:${waiting.deviceId}`,
          transport: "k3relay",
        });
        expect((yield* Effect.promise(() => host.account.state())).pendingDevice).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerDevice, layerWebSocketGlobal))),
  );

  it.live(
    "gets a signed-in device no further than the host's approval: rejected means no grant",
    () =>
      Effect.gen(function* () {
        const world = yield* startWorld;
        const host = yield* world.startHost;
        yield* signInHost(world, host);
        const session = yield* signInDevice(world);
        const { fiber, deviceCode } = yield* knock(session, host);
        yield* deviceCode;
        yield* Effect.promise(() =>
          host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
        );
        yield* Effect.promise(() => host.rejectPairing());
        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit));
        expect(JSON.stringify(exit.cause)).toContain('"reason":"rejected"');
        expect((yield* Effect.promise(() => host.state())).devices).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerDevice, layerWebSocketGlobal))),
  );

  it.live(
    "refuses account devices once the host signed out, and hosts on other accounts are never listed",
    () =>
      Effect.gen(function* () {
        const world = yield* startWorld;
        const host = yield* world.startHost;
        yield* signInHost(world, host);
        world.fake.user = { ...world.fake.user, id: "777000111", login: "someone-else" };
        const stranger = yield* signInDevice(world);
        expect(yield* listK3RelayAccountHosts(stranger)).toEqual([]);

        world.fake.user = { ...world.fake.user, id: "583231" };
        const session = yield* signInDevice(world);
        const [entry] = yield* listK3RelayAccountHosts(session);
        assert(entry !== undefined);
        yield* Effect.promise(() => host.account.signOut());
        // Signing out takes the host off the account's list at the relay...
        expect(yield* listK3RelayAccountHosts(session)).toEqual([]);
        // ...and a device that listed it before gets nowhere.
        const exit = yield* Effect.exit(
          connectK3RelayAccountHost(
            session,
            entry,
            { deviceName: "Late phone" },
            () => Effect.void,
          ),
        );
        assert(Exit.isFailure(exit));
        expect((yield* Effect.promise(() => host.state())).pairing.phase).not.toBe(
          "awaiting-approval",
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerDevice, layerWebSocketGlobal))),
  );

  it.live('lets the first account device in an open "Add device" window in with one tap', () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      const host = yield* world.startHost;
      yield* signInHost(world, host);
      yield* Effect.promise(() => host.createPairingOffer());

      const session = yield* signInDevice(world);
      const { fiber, deviceCode } = yield* knock(session, host);
      yield* deviceCode;
      const waiting = (yield* Effect.promise(() =>
        host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
      )).pairing;
      assert(waiting.phase === "awaiting-approval");
      expect(waiting.approval).toBe("one-tap");
      const accountState = yield* Effect.promise(() =>
        host.account.awaitState((state) => state.pendingDevice !== null),
      );
      expect(accountState.pendingDevice).toEqual({ deviceId: waiting.deviceId, oneTap: true });

      yield* Effect.promise(() => host.approvePairing(waiting.deviceId));
      const paired = yield* Fiber.join(fiber);
      expect(deviceIdFromPublicKey(paired.signer.alg, paired.signer.publicKey)).toBe(
        waiting.deviceId,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerDevice, layerWebSocketGlobal))),
  );

  it.live("approves without the user only after an acknowledged opt-out", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      const host = yield* world.startHost;
      yield* signInHost(world, host);
      const refused = yield* Effect.exit(
        Effect.promise(() =>
          host.account.setApproval({ requireApproval: false, acknowledgedRisk: false }),
        ),
      );
      assert(Exit.isFailure(refused));
      expect((yield* Effect.promise(() => host.account.state())).requireApproval).toBe(true);
      const off = yield* Effect.promise(() =>
        host.account.setApproval({ requireApproval: false, acknowledgedRisk: true }),
      );
      expect(off.requireApproval).toBe(false);
      expect(off.approvalOptOutAt).not.toBeNull();
      // The relay state on the host's settings screen follows the account's policy.
      yield* Effect.promise(() => host.awaitState((state) => !state.requireApproval));

      const session = yield* signInDevice(world);
      const { fiber } = yield* knock(session, host);
      const paired = yield* Fiber.join(fiber);
      const deviceId = deviceIdFromPublicKey(paired.signer.alg, paired.signer.publicKey);
      expect((yield* Effect.promise(() => host.state())).devices).toEqual([
        expect.objectContaining({ deviceId, status: "active" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerDevice, layerWebSocketGlobal))),
  );
});
