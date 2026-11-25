import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { K3RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { resolveDeviceHubAccess } from "../state/deviceHubAccess.ts";
import { getEnvironmentSpeechStreamUrl } from "../voice-input/environment.ts";

const environmentId = EnvironmentId.make("env-relay");

/** A host reached through the relay, with a DPoP session: the kind media tickets used to go to. */
const relayed: PreparedConnection = {
  environmentId,
  label: "Studio Mac",
  httpBaseUrl: "https://k3host.invalid",
  socketUrl: "wss://k3host.invalid/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 4_102_444_800_000 },
  target: new K3RelayConnectionTarget({ environmentId, label: "Studio Mac", connectionId: "c" }),
};

let requests = 0;
const layerNoNetwork = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (async () => {
      requests += 1;
      throw new Error("no request should be made");
    }) as unknown as typeof fetch),
  ),
);

describe("features the relay never carries", () => {
  it.effect("are refused on the device, with the reason, before any request", () =>
    Effect.gen(function* () {
      requests = 0;
      const hub = yield* resolveDeviceHubAccess({
        prepared: relayed,
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.flip);
      expect(hub.message).toBe(
        "Devices on the host are not available through the relay. Connect over your network or a VPN to use them.",
      );
      const preview = yield* resolveDeviceHubAccess({
        prepared: relayed,
        hubBasePath: "/api/preview-stream",
        feature: "preview-stream",
      }).pipe(Effect.flip);
      expect(preview.message).toContain("browser preview");
      const voice = yield* getEnvironmentSpeechStreamUrl(relayed).pipe(Effect.flip);
      expect(voice.message).toContain("Live voice input");
      expect(requests).toBe(0);
    }).pipe(Effect.provide(layerNoNetwork)),
  );
});
