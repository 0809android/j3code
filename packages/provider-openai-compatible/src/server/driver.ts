import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { OPENAI_COMPATIBLE_DRIVER_KIND, OpenAiCompatibleSettings } from "../settings.ts";
import { makeOpenAiCompatibleAdapterV2 } from "./adapter.ts";
import { buildInitialOpenAiCompatibleSnapshot, checkOpenAiCompatibleStatus } from "./status.ts";
import { makeOpenAiCompatibleTextGeneration } from "./textGeneration.ts";

const decodeSettings = Schema.decodeSync(OpenAiCompatibleSettings);

export type OpenAiCompatibleDriverEnv = HttpClient.HttpClient | ProviderHost.ProviderHost;

export const OpenAiCompatibleDriver: ProviderDriver<
  OpenAiCompatibleSettings,
  OpenAiCompatibleDriverEnv
> = {
  driverKind: OPENAI_COMPATIBLE_DRIVER_KIND,
  metadata: {
    displayName: "Mistral / OpenAI-Compatible API",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: OpenAiCompatibleSettings,
  defaultConfig: (): OpenAiCompatibleSettings => decodeSettings({}),
  create: Effect.fn("OpenAiCompatibleDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const httpClient = yield* HttpClient.HttpClient;
    const platform = yield* HostProcess.Platform;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OPENAI_COMPATIBLE_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: OPENAI_COMPATIBLE_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig: OpenAiCompatibleSettings = {
      ...config,
      enabled,
    };

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<OpenAiCompatibleSettings>
    >({
      resolveMaintenance: () =>
        Effect.succeed({
          provider: OPENAI_COMPATIBLE_DRIVER_KIND,
          packageName: null,
          update: null,
          latestVersion: null,
        }),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOpenAiCompatibleSnapshot(settings.provider, processEnv).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider: checkOpenAiCompatibleStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the OpenAI-compatible provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = makeOpenAiCompatibleAdapterV2({
      instanceId,
      settings: effectiveConfig,
      environment: processEnv,
      platform,
      httpClient,
    });

    const textGeneration = makeOpenAiCompatibleTextGeneration({
      settings: effectiveConfig,
      environment: processEnv,
      httpClient,
    });

    return {
      instanceId,
      driverKind: OPENAI_COMPATIBLE_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
