import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { K3RelayOnboarding, type K3RelayPairingProgress } from "@t3tools/client-runtime/k3relay";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

export const reachesEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:reaches-environment",
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
  label: "web:connection:connect-k3relay-pairing",
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
