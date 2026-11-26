import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type K3RelayIntroducedProgress,
  K3RelayIntroducer,
  type K3RelayIntroductionClaims,
  type K3RelayIntroductionSession,
  K3RelayOnboarding,
  type K3RelayPairingProgress,
} from "@t3tools/client-runtime/k3relay";
import { createK3RelayAccountCommands } from "@t3tools/client-runtime/state/k3relay";

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

export interface K3RelayIntroducedCommandInput {
  readonly link: string;
  readonly deviceName: string;
  readonly onProgress: (progress: K3RelayIntroducedProgress) => void;
}

/** This device joins every host an introduction link names (spec §18.2). */
export const connectK3RelayIntroduction = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-k3relay-introduction",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: K3RelayIntroducedCommandInput) => input.link,
  },
  execute: (input: K3RelayIntroducedCommandInput) =>
    K3RelayOnboarding.pipe(
      Effect.flatMap((onboarding) =>
        onboarding.introduce({ link: input.link, deviceName: input.deviceName }, (progress) =>
          Effect.sync(() => input.onProgress(progress)),
        ),
      ),
    ),
});

/** This device introduces a new one to its relay hosts: open, wait for the claims, approve. */
export const k3relayIntroducer = {
  open: createRuntimeCommand(connectionAtomRuntime, {
    label: "web:connection:k3relay-introduce-open",
    execute: (_input: Record<string, never>) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.open)),
  }),
  collect: createRuntimeCommand(connectionAtomRuntime, {
    label: "web:connection:k3relay-introduce-collect",
    execute: (session: K3RelayIntroductionSession) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.collect(session))),
  }),
  approve: createRuntimeCommand(connectionAtomRuntime, {
    label: "web:connection:k3relay-introduce-approve",
    execute: (input: {
      readonly claims: K3RelayIntroductionClaims;
      readonly confirmationCode: string;
    }) =>
      K3RelayIntroducer.pipe(
        Effect.flatMap((introducer) => introducer.approve(input.claims, input.confirmationCode)),
      ),
  }),
  cancel: createRuntimeCommand(connectionAtomRuntime, {
    label: "web:connection:k3relay-introduce-cancel",
    execute: (session: K3RelayIntroductionSession) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.cancel(session))),
  }),
};

/** Signing this device in to a K3 Relay account and connecting to the account's hosts (§20). */
export const k3relayAccount = createK3RelayAccountCommands(
  connectionAtomRuntime,
  "web:connection:k3relay-account",
);
