import { assert, describe, it } from "@effect/vitest";
import { K3_RELAY_PROVISIONAL_ORIGIN } from "@t3tools/contracts";
import {
  type MuxStreamError,
  makeMuxHandler,
  serveHttp,
  serveWebSocket,
} from "@t3tools/shared/mux";
import { relayHostId } from "@t3tools/shared/relay";
import {
  type E2eeDeviceAlgorithm,
  deviceSignerFromKeypair,
  generateDeviceKeypair,
} from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { overTransport } from "./broker.ts";
import {
  layerTestCrypto,
  layerWebSocketGlobal,
  startTestHost,
  startTestRelay,
} from "./k3relay.testkit.ts";
import { fetchK3RelayHostPresence } from "./status.ts";
import * as K3RelayTunnels from "./tunnels.ts";
import { type K3RelayTunnelInput, openK3RelayTunnel } from "./tunnel.ts";

const layerTest = Layer.mergeAll(layerWebSocketGlobal, layerTestCrypto);

const DESCRIPTOR = {
  environmentId: "env-k3relay-test",
  label: "Studio Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.0.0",
  capabilities: { repositoryIdentity: true },
};

/** What the host serves inside the tunnel: echo routes, the descriptor and a WebSocket echo. */
const hostHandler = makeMuxHandler({
  http: serveHttp<MuxStreamError, never>((request) => {
    switch (request.path) {
      case "/.well-known/t3/environment":
        return Effect.succeed({
          status: 200,
          headers: [["content-type", "application/json"]],
          body: JSON.stringify(DESCRIPTOR),
        });
      case "/echo":
        return Effect.succeed({ status: 200, headers: [], body: request.body });
      case "/whoami":
        return Effect.succeed({
          status: 200,
          headers: [["content-type", "application/json"]],
          body: JSON.stringify({ path: request.path, headers: request.headers }),
        });
      default:
        return Effect.succeed({ status: 404, headers: [], body: "missing" });
    }
  }),
  ws: serveWebSocket<never, never>((request) =>
    Effect.gen(function* () {
      const channel = yield* request.accept();
      yield* Stream.runForEach(channel.messages, channel.send);
    }).pipe(Effect.orDie),
  ),
});

const newDevice = (alg: E2eeDeviceAlgorithm = "ed25519") =>
  Effect.map(generateDeviceKeypair(alg), deviceSignerFromKeypair);

const tunnelInputFor = Effect.fn(function* (
  relayUrl: string,
  host: Effect.Success<ReturnType<typeof startTestHost>>,
  alg: E2eeDeviceAlgorithm = "ed25519",
) {
  const signer = yield* newDevice(alg);
  const grant = yield* host.approveDevice(signer);
  return {
    relayUrl,
    hostId: host.hostId,
    hostIdentityKey: host.hostIdentityKey,
    signer,
    grant,
  } satisfies K3RelayTunnelInput;
});

const failureReason = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected the tunnel to fail");
  const error = Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: unknown }).error : null;
  return (error as { readonly reason?: string } | null)?.reason;
};

describe("K3 Relay tunnel", () => {
  it.live.each(["ed25519", "p256"] as const)(
    "carries fetch and WebSocket round trips through a real relay (%s)",
    (alg) =>
      Effect.gen(function* () {
        const relay = yield* startTestRelay;
        const host = yield* startTestHost(relay, { handler: hostHandler });
        const tunnel = yield* openK3RelayTunnel(yield* tunnelInputFor(relay.relayUrl, host, alg));
        assert.isTrue(tunnel.session.deviceAuthenticated);

        const echoed = yield* Effect.promise(async () => {
          const response = await tunnel.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}/echo`, {
            method: "POST",
            body: "over the relay",
          });
          return { status: response.status, text: await response.text() };
        });
        assert.deepStrictEqual(echoed, { status: 200, text: "over the relay" });

        const socket = yield* Socket.makeWebSocket(`wss://k3host.invalid/ws/echo`).pipe(
          Effect.provideService(Socket.WebSocketConstructor, (url, options) =>
            tunnel.transport.webSocketConstructor(
              url,
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ),
          ),
        );
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        yield* writer.write("ping");
        const [reply] = yield* reader.pull;
        assert.strictEqual(
          typeof reply === "string" ? reply : new TextDecoder().decode(reply),
          "ping",
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("routes the HTTP client to the host behind the virtual origin, and nowhere else", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { handler: hostHandler });
      const tunnel = yield* openK3RelayTunnel(yield* tunnelInputFor(relay.relayUrl, host));
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
      }).pipe(overTransport(tunnel.transport), Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(descriptor.environmentId, DESCRIPTOR.environmentId);
      // Without the tunnel the same request goes to the reserved `.invalid` name and fails.
      const direct = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
        timeoutMs: 3_000,
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.exit);
      assert.isTrue(Exit.isFailure(direct));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("hides forwarding headers the device tries to send to the host", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { handler: hostHandler });
      const tunnel = yield* openK3RelayTunnel(yield* tunnelInputFor(relay.relayUrl, host));
      const seen = yield* Effect.promise(async () => {
        const response = await tunnel.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}/whoami`, {
          headers: { "x-forwarded-for": "10.0.0.1", "cf-connecting-ip": "10.0.0.1" },
        });
        return (await response.json()) as { headers: Array<[string, string]> };
      });
      const names = seen.headers.map(([name]) => name.toLowerCase());
      assert.notInclude(names, "x-forwarded-for");
      assert.notInclude(names, "cf-connecting-ip");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("stops with `revoked` when the host's ledger revoked the device", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { handler: hostHandler });
      const input = yield* tunnelInputFor(relay.relayUrl, host);
      yield* host.revoke(input.signer);
      const exit = yield* openK3RelayTunnel(input).pipe(Effect.exit);
      assert.strictEqual(failureReason(exit), "revoked");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("stops with `unknown-device` for a valid grant the host's ledger does not know", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { handler: hostHandler });
      const signer = yield* newDevice();
      const grant = yield* host.issueGrantFor(signer);
      const exit = yield* openK3RelayTunnel({
        relayUrl: relay.relayUrl,
        hostId: host.hostId,
        hostIdentityKey: host.hostIdentityKey,
        signer,
        grant,
      }).pipe(Effect.exit);
      assert.strictEqual(failureReason(exit), "unknown-device");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("refuses a host that proves a different key than the pinned one", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const impostorSeed = crypto.getRandomValues(new Uint8Array(32));
      const host = yield* startTestHost(relay, { handler: hostHandler, impostorSeed });
      const exit = yield* openK3RelayTunnel(yield* tunnelInputFor(relay.relayUrl, host)).pipe(
        Effect.exit,
      );
      assert.strictEqual(failureReason(exit), "key-mismatch");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live(
    "never dials when the pinned key does not match the host id, or the grant is not this device's",
    () =>
      Effect.gen(function* () {
        const relay = yield* startTestRelay;
        const host = yield* startTestHost(relay, { handler: hostHandler });
        const input = yield* tunnelInputFor(relay.relayUrl, host);
        let dialed = 0;
        const counting = Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
          dialed += 1;
          return new globalThis.WebSocket(
            url,
            typeof options === "string" || Array.isArray(options) ? options : undefined,
          ) as unknown as Socket.WebSocketLike;
        });
        const otherKey = crypto.getRandomValues(new Uint8Array(32));
        const swapped = yield* openK3RelayTunnel({ ...input, hostIdentityKey: otherKey }).pipe(
          Effect.provide(counting),
          Effect.exit,
        );
        assert.strictEqual(failureReason(swapped), "key-mismatch");
        const otherDevice = yield* newDevice();
        const borrowed = yield* openK3RelayTunnel({ ...input, signer: otherDevice }).pipe(
          Effect.provide(counting),
          Effect.exit,
        );
        assert.strictEqual(failureReason(borrowed), "unauthorized");
        const expired = yield* host.issueGrantFor(
          input.signer,
          (yield* Clock.currentTimeMillis) - 91 * 86_400_000,
        );
        const old = yield* openK3RelayTunnel({ ...input, grant: expired }).pipe(
          Effect.provide(counting),
          Effect.exit,
        );
        assert.strictEqual(failureReason(old), "grant-expired");
        assert.strictEqual(dialed, 0);
        assert.notStrictEqual(relayHostId(otherKey), host.hostId);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("names an offline host from the relay's close code", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { offline: true });
      const exit = yield* openK3RelayTunnel(yield* tunnelInputFor(relay.relayUrl, host)).pipe(
        Effect.exit,
      );
      assert.strictEqual(failureReason(exit), "host-offline");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("asks the relay whether the host is online, signed by the device key", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const online = yield* startTestHost(relay, { handler: hostHandler });
      const offline = yield* startTestHost(relay, { offline: true });
      const onlineInput = yield* tunnelInputFor(relay.relayUrl, online);
      const offlineInput = yield* tunnelInputFor(relay.relayUrl, offline);
      const up = yield* fetchK3RelayHostPresence(onlineInput);
      const down = yield* fetchK3RelayHostPresence(offlineInput);
      assert.deepInclude(up, { kind: "reachable", online: true });
      assert.deepInclude(down, { kind: "reachable", online: false });
      // A grant from another host gets the same answer as an unknown host.
      const stranger = yield* fetchK3RelayHostPresence({
        ...onlineInput,
        grant: offlineInput.grant,
      });
      assert.deepStrictEqual(stranger, { kind: "unauthorized" });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("shares one tunnel per connection and opens a new one after it dies", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, { handler: hostHandler });
      const input = yield* tunnelInputFor(relay.relayUrl, host);
      const tunnels = yield* K3RelayTunnels.make;
      const first = yield* tunnels.acquire("k3relay:test", input);
      const again = yield* tunnels.acquire("k3relay:test", input);
      assert.strictEqual(again, first);
      yield* tunnels.close("k3relay:test");
      yield* first.closed;
      const fresh = yield* tunnels.acquire("k3relay:test", input);
      assert.notStrictEqual(fresh, first);
      const response = yield* Effect.promise(() =>
        fresh.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}/echo`, {
          method: "POST",
          body: "again",
        }),
      );
      assert.strictEqual(response.status, 200);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
