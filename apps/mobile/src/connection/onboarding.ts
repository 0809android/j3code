import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { K3RelayOnboarding, type K3RelayPairingProgress } from "@t3tools/client-runtime/k3relay";
import { createK3RelayAccountCommands } from "@t3tools/client-runtime/state/k3relay";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    // The same link used for another machine needs its own expected-machine check.
    key: (input: { readonly pairingUrl: string; readonly expectedEnvironmentId?: EnvironmentId }) =>
      JSON.stringify([input.pairingUrl, input.expectedEnvironmentId ?? null]),
  },
  execute: (input: {
    readonly pairingUrl: string;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.updateBearer(input)),
    ),
});

export const reachesEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:reaches-environment",
  execute: (input: { readonly host: string; readonly environmentId: EnvironmentId }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.reaches(input)),
    ),
});

export interface K3RelayPairingCommandInput {
  readonly link: string;
  readonly deviceName: string;
  readonly onProgress: (progress: K3RelayPairingProgress) => void;
}

export const connectK3RelayPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-k3relay-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: K3RelayPairingCommandInput) => input.link,
  },
  execute: (input: K3RelayPairingCommandInput) =>
    K3RelayOnboarding.pipe(
      Effect.flatMap((onboarding) =>
        onboarding.pair({ link: input.link, deviceName: input.deviceName }, (progress) =>
          Effect.sync(() => input.onProgress(progress)),
        ),
      ),
    ),
});

/** Signing this device in to a K3 Relay account and connecting to the account's hosts (§20). */
export const k3relayAccount = createK3RelayAccountCommands(
  connectionAtomRuntime,
  "mobile:connection:k3relay-account",
);
