import type {
  K3RelayHostApi,
  K3RelayHostApiError,
  K3RelayHostState,
} from "@t3tools/client-runtime/k3relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type K3RelayHostApiResolver = (environmentId: EnvironmentId) => K3RelayHostApi | null;

/**
 * Until the host's relay RPCs land in `packages/contracts`, no environment offers the relay and
 * the section stays hidden. Development builds can provide a fake here.
 */
const resolveNone: K3RelayHostApiResolver = () => null;

const K3RelayHostApiContext = createContext<K3RelayHostApiResolver>(resolveNone);

export function K3RelayHostApiProvider(props: {
  readonly resolve: K3RelayHostApiResolver;
  readonly children: ReactNode;
}) {
  return <K3RelayHostApiContext value={props.resolve}>{props.children}</K3RelayHostApiContext>;
}

export function useK3RelayHostApi(environmentId: EnvironmentId): K3RelayHostApi | null {
  return useContext(K3RelayHostApiContext)(environmentId);
}

export function useK3RelayHostState(api: K3RelayHostApi | null): {
  readonly state: K3RelayHostState | null;
  readonly error: string | null;
} {
  const [view, setView] = useState<{
    readonly state: K3RelayHostState | null;
    readonly error: string | null;
  }>({ state: null, error: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the host's relay state stream
  useEffect(() => {
    if (api === null) return;
    const fiber = Effect.runFork(
      api.state.pipe(
        Stream.runForEach((state) => Effect.sync(() => setView({ state, error: null }))),
        Effect.catch((error: K3RelayHostApiError) =>
          Effect.sync(() => setView((current) => ({ ...current, error: error.detail }))),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [api]);
  return api === null ? { state: null, error: null } : view;
}
