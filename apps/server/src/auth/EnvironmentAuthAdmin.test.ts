import { AuthStandardClientScopes, type ManagedPolicyDocument } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { markRelayRequest } from "./transportSecurity.ts";

const layerServerConfig = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-auth-control-plane-test-",
      }),
    ),
  );

const layerEnvironmentAuth = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
  policy?: ManagedPolicyDocument,
) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

const desktopAndLocalOnly: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Example Corp",
  limits: { clients: ["desktop", "local-browser"] },
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "EnvironmentAuth administrative operations",
  (it) => {
    it.effect("refuses pairing links when the policy does not allow remote clients", () =>
      Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

        const error = yield* environmentAuth.issuePairingCredential().pipe(Effect.flip);
        const startup = yield* environmentAuth.issueStartupPairingCredential();

        assert.equal(
          error.message,
          "Example Corp's policy does not allow remote clients, so this server cannot create pairing links.",
        );
        assert.isAbove(startup.credential.length, 0);
      }).pipe(Effect.provide(layerEnvironmentAuth(undefined, desktopAndLocalOnly))),
    );

    it.effect("revokes link-paired clients on startup under a policy without remote clients", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const phone = yield* sessions.issue({ subject: "one-time-token" });
        const bot = yield* sessions.issue({ subject: "cli-issued-session" });
        const startup = (ipAddress: string) =>
          sessions.issue({
            subject: EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
            client: { deviceType: "unknown", ipAddress },
          });
        const startupPhone = yield* startup("192.168.1.20");
        const startupBrowser = yield* startup("127.0.0.1");
        yield* environmentAuth.createPairingLink({ subject: "one-time-token" });
        yield* environmentAuth.issuePairingCredential({ access: "auto" });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(ManagedPolicy.layerTest(desktopAndLocalOnly), layerServerConfig()),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        assert.notInclude(remaining, phone.sessionId);
        assert.notInclude(remaining, startupPhone.sessionId);
        assert.include(remaining, startupBrowser.sessionId);
        assert.include(remaining, bot.sessionId);
        assert.lengthOf(yield* pairingLinks.listActive(), 0);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("revokes only T3 Connect clients when the policy keeps remote clients", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const phone = yield* sessions.issue({ subject: "one-time-token" });
        const connect = yield* sessions.issue({ subject: "cloud-connect" });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(
              ManagedPolicy.layerTest({
                schemaVersion: 1,
                organization: "Example Corp",
                limits: { connect: false },
              }),
              layerServerConfig(),
            ),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        assert.include(remaining, phone.sessionId);
        assert.notInclude(remaining, connect.sessionId);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("revokes relay-paired devices when the policy turns the relay off", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const phone = yield* sessions.issue({ subject: "one-time-token" });
        const relayDevice = yield* sessions.issue({
          subject: EnvironmentAuth.RELAY_PAIRED_DEVICE_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });
        // Whatever subject it has, a session that came through the relay goes with them.
        const relayOther = yield* sessions.issue({
          subject: "cli-issued-session",
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });
        const bot = yield* sessions.issue({ subject: "cli-issued-session" });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(
              ManagedPolicy.layerTest({
                schemaVersion: 1,
                organization: "Example Corp",
                limits: { connect: false },
              }),
              layerServerConfig(),
            ),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        assert.notInclude(remaining, relayDevice.sessionId);
        assert.notInclude(remaining, relayOther.sessionId);
        assert.include(remaining, phone.sessionId);
        assert.include(remaining, bot.sessionId);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("revokes relayed sessions, even a startup one, without remote clients", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const relayDevice = yield* sessions.issue({
          subject: EnvironmentAuth.RELAY_PAIRED_DEVICE_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });
        // The relay address is not empty and not loopback, so it is never taken for this machine.
        const relayStartup = yield* sessions.issue({
          subject: EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });
        const localStartup = yield* sessions.issue({
          subject: EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "127.0.0.1" },
        });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(ManagedPolicy.layerTest(desktopAndLocalOnly), layerServerConfig()),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        assert.notInclude(remaining, relayDevice.sessionId);
        assert.notInclude(remaining, relayStartup.sessionId);
        assert.include(remaining, localStartup.sessionId);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("keeps relay-paired devices when the policy allows the relay", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const relayDevice = yield* sessions.issue({
          subject: EnvironmentAuth.RELAY_PAIRED_DEVICE_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });

        yield* EnvironmentAuth.make.pipe(
          Effect.provide(
            Layer.merge(
              ManagedPolicy.layerTest({
                schemaVersion: 1,
                organization: "Example Corp",
                limits: { clients: ["remote"] },
              }),
              layerServerConfig(),
            ),
          ),
        );

        const remaining = (yield* sessions.listActive()).map((session) => session.sessionId);
        assert.include(remaining, relayDevice.sessionId);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("refuses a relayed request under a policy without the relay, and only that", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* sessions.issue({
          subject: EnvironmentAuth.RELAY_PAIRED_DEVICE_SUBJECT,
          client: { deviceType: "unknown", ipAddress: "k3relay" },
        });
        const request = () =>
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { authorization: `Bearer ${issued.token}` },
            }),
          );

        const refused = yield* environmentAuth
          .authenticateHttpRequest(markRelayRequest(request()))
          .pipe(Effect.flip);
        const direct = yield* environmentAuth.authenticateHttpRequest(request());

        assert.equal(refused._tag, "ServerAuthInvalidCredentialError");
        assert.equal(
          refused._tag === "ServerAuthInvalidCredentialError" ? refused.diagnostic : undefined,
          "Example Corp's policy does not allow the K3 relay.",
        );
        assert.equal(direct.sessionId, issued.sessionId);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth(undefined, {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { connect: false },
          }),
        ),
      ),
    );

    it.effect("creates, lists, and revokes client pairing links", () =>
      Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

        const created = yield* environmentAuth.createPairingLink({
          scopes: ["orchestration:read"],
          subject: "one-time-token",
          label: "CI phone",
        });
        // An app approval code is never listed.
        yield* environmentAuth.issuePairingCredential({ access: "auto" });
        const listedBeforeRevoke = yield* environmentAuth.listPairingLinks();
        const revoked = yield* environmentAuth.revokePairingLink(created.id);
        const listedAfterRevoke = yield* environmentAuth.listPairingLinks();

        expect(created.scopes).toEqual(["orchestration:read"]);
        expect(created.credential.length).toBeGreaterThan(0);
        expect(listedBeforeRevoke).toHaveLength(1);
        expect(listedBeforeRevoke[0]?.id).toBe(created.id);
        expect(listedBeforeRevoke[0]?.label).toBe("CI phone");
        expect(listedBeforeRevoke[0]).not.toHaveProperty("credential");
        expect(revoked).toBe(true);
        expect(listedAfterRevoke).toHaveLength(0);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("issues bearer access token sessions without exposing raw tokens", () =>
      Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessionCredentials = yield* SessionStore.SessionStore;

        const issued = yield* environmentAuth.issueSession({
          label: "deploy-bot",
        });
        const verified = yield* sessionCredentials.verify(issued.token);
        const listedBeforeRevoke = yield* environmentAuth.listSessions();
        const revoked = yield* environmentAuth.revokeSession(issued.sessionId);
        const listedAfterRevoke = yield* environmentAuth.listSessions();

        expect(issued.method).toBe("bearer-access-token");
        expect(issued.scopes).toEqual(AuthStandardClientScopes);
        expect(issued.client.deviceType).toBe("bot");
        expect(issued.client.label).toBe("deploy-bot");
        expect(verified.sessionId).toBe(issued.sessionId);
        expect(verified.scopes).toEqual(AuthStandardClientScopes);
        expect(verified.method).toBe("bearer-access-token");
        expect(listedBeforeRevoke).toHaveLength(1);
        expect(listedBeforeRevoke[0]?.sessionId).toBe(issued.sessionId);
        expect("token" in (listedBeforeRevoke[0] ?? {})).toBe(false);
        expect(revoked).toBe(true);
        expect(listedAfterRevoke).toHaveLength(0);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );
  },
);
