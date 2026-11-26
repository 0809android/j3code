import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const DEVICE = "aaaabbbbccccddddeeeeffffgggghhhh";
const OTHER_DEVICE = "zzzzyyyyxxxxwwwwvvvvuuuuttttssss";
const DPOP_KEY = "dpop-thumbprint-of-the-device";
const relayMetadata = { deviceType: "mobile" as const, ipAddress: "k3relay" };

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-relay-test-" });

const layerAuth = (policy?: ManagedPolicyDocument) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );

const exchange = (
  credential: string,
  input: { readonly proofKeyThumbprint?: string; readonly relayDeviceId?: string },
) =>
  Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
    auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, relayMetadata, input),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "EnvironmentAuth relay device credentials",
  (it) => {
    it.effect("is spent only through the relay, by its own device, with a DPoP key", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });

        // A direct route, with or without a DPoP key, never matches the device binding.
        const direct = yield* exchange(issued.credential, { proofKeyThumbprint: DPOP_KEY }).pipe(
          Effect.flip,
        );
        expect(direct._tag).toBe("ServerAuthInvalidCredentialError");
        expect((yield* exchange(issued.credential, {}).pipe(Effect.flip))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
        // Another relay device cannot spend it either.
        const other = yield* exchange(issued.credential, {
          relayDeviceId: OTHER_DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        }).pipe(Effect.flip);
        expect(other._tag).toBe("ServerAuthInvalidCredentialError");
        // The right device without a DPoP key is refused before anything is spent.
        const bearer = yield* exchange(issued.credential, { relayDeviceId: DEVICE }).pipe(
          Effect.flip,
        );
        expect(bearer._tag).toBe("ServerAuthInvalidCredentialError");

        // None of the refusals spent it.
        const token = yield* exchange(issued.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        });
        expect(token.token_type).toBe("DPoP");
        const session = yield* sessions.verify(token.access_token);
        expect(session.subject).toBe(EnvironmentAuth.relayPairedDeviceSubject(DEVICE));
        expect(session.proofKeyThumbprint).toBe(DPOP_KEY);
        expect(session.client.ipAddress).toBe("k3relay");

        // One-time.
        const again = yield* exchange(issued.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        }).pipe(Effect.flip);
        expect(again._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerAuth())),
    );

    it.effect("keeps at most one outstanding credential per device", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const first = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });
        const second = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });
        const stale = yield* exchange(first.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        }).pipe(Effect.flip);
        expect(stale._tag).toBe("ServerAuthInvalidCredentialError");
        yield* exchange(second.credential, { relayDeviceId: DEVICE, proofKeyThumbprint: DPOP_KEY });
      }).pipe(Effect.provide(layerAuth())),
    );

    it.effect("does not let a relay device spend an ordinary pairing link", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const link = yield* auth.issuePairingCredential();
        const refused = yield* exchange(link.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        }).pipe(Effect.flip);
        expect(refused._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerAuth())),
    );

    it.effect("revoking the device ends its sessions and unused credentials only", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const used = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });
        const token = yield* exchange(used.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        });
        const otherIssued = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: OTHER_DEVICE,
          label: "iPad",
        });
        const otherToken = yield* exchange(otherIssued.credential, {
          relayDeviceId: OTHER_DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        });
        const unused = yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });

        expect(yield* auth.revokeRelayDevice(DEVICE)).toBe(2);
        expect((yield* sessions.verify(token.access_token).pipe(Effect.flip))._tag).toBeDefined();
        expect((yield* sessions.verify(otherToken.access_token)).subject).toBe(
          EnvironmentAuth.relayPairedDeviceSubject(OTHER_DEVICE),
        );
        const spent = yield* exchange(unused.credential, {
          relayDeviceId: DEVICE,
          proofKeyThumbprint: DPOP_KEY,
        }).pipe(Effect.flip);
        expect(spent._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerAuth())),
    );

    it.effect("refuses relay credentials when the policy shuts the relay", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const refused = yield* auth
          .issueRelayDeviceBootstrapCredential({ deviceId: DEVICE, label: "Pixel" })
          .pipe(Effect.flip);
        expect(refused._tag).toBe("ManagedPolicyRefusedError");
      }).pipe(
        Effect.provide(
          layerAuth({ schemaVersion: 1, organization: "Example Corp", limits: { connect: false } }),
        ),
      ),
    );

    it.effect("revokes per-device relay sessions and credentials when the policy shuts it", () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        // No relay address: the subject alone must be enough.
        const device = yield* sessions.issue({
          subject: EnvironmentAuth.relayPairedDeviceSubject(DEVICE),
        });
        const phone = yield* sessions.issue({ subject: "one-time-token" });
        yield* auth.issueRelayDeviceBootstrapCredential({
          deviceId: DEVICE,
          label: "Pixel",
        });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(
              ManagedPolicy.layerTest({
                schemaVersion: 1,
                organization: "Example Corp",
                limits: { connect: false },
              }),
              layerConfig,
            ),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        expect(remaining).not.toContain(device.sessionId);
        expect(remaining).toContain(phone.sessionId);
        const links = yield* auth.listPairingLinks();
        expect(links.some((link) => EnvironmentAuth.isRelayPairedDeviceSubject(link.subject))).toBe(
          false,
        );
      }).pipe(Effect.provide(layerAuth())),
    );
  },
);
