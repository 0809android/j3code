import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
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

export interface K3RelayIntroducedCommandInput {
  readonly link: string;
  readonly deviceName: string;
  readonly onProgress: (progress: K3RelayIntroducedProgress) => void;
}

/** This device joins every host an introduction link names (spec §18.2). */
export const connectK3RelayIntroduction = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-k3relay-introduction",
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
    label: "mobile:connection:k3relay-introduce-open",
    execute: (_input: Record<string, never>) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.open)),
  }),
  collect: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:connection:k3relay-introduce-collect",
    execute: (session: K3RelayIntroductionSession) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.collect(session))),
  }),
  approve: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:connection:k3relay-introduce-approve",
    execute: (input: {
      readonly claims: K3RelayIntroductionClaims;
      readonly confirmationCode: string;
    }) =>
      K3RelayIntroducer.pipe(
        Effect.flatMap((introducer) => introducer.approve(input.claims, input.confirmationCode)),
      ),
  }),
  cancel: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:connection:k3relay-introduce-cancel",
    execute: (session: K3RelayIntroductionSession) =>
      K3RelayIntroducer.pipe(Effect.flatMap((introducer) => introducer.cancel(session))),
  }),
};

/** Signing this device in to a K3 Relay account and connecting to the account's hosts (§20). */
export const k3relayAccount = createK3RelayAccountCommands(
  connectionAtomRuntime,
  "mobile:connection:k3relay-account",
);
