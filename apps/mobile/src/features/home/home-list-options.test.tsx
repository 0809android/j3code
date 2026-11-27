import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("../../state/preferences", () => ({ saveMobilePreferences: {} }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    harness.saved.push(value);
    return { _tag: "Success", value: undefined };
  },
}));

import {
  createHomeListOptionsAtom,
  HomeListOptionsProvider,
  useHomeListOptions,
} from "./home-list-options";

const ENVIRONMENT = "env-1" as EnvironmentId;
const AVAILABLE = new Set([ENVIRONMENT]);

it("saves the scope from every update made in one event", async () => {
  harness.saved = [];
  let controls: ReturnType<typeof useHomeListOptions> | undefined;
  function Probe() {
    const result = useHomeListOptions(AVAILABLE);
    useLayoutEffect(() => {
      controls = result;
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <HomeListOptionsProvider projectGroupingMode="repository">
        <Probe />
      </HomeListOptionsProvider>,
    ),
  );
  act(() => {
    controls!.setSelectedEnvironmentId(ENVIRONMENT);
    controls!.setSelectedProjectKey("env-1:project-1");
  });

  expect(harness.saved.at(-1)).toEqual({
    threadListFilters: { environmentId: ENVIRONMENT, projectKey: "env-1:project-1" },
  });
  expect(controls!.options.selectedEnvironmentId).toBe(ENVIRONMENT);
  expect(controls!.options.selectedProjectKey).toBe("env-1:project-1");
  act(() => root.unmount());
});

it("shares the sort order with the layout through the options atom", async () => {
  const registry = AtomRegistry.make();
  const optionsAtom = createHomeListOptionsAtom();
  let controls: ReturnType<typeof useHomeListOptions> | undefined;
  function Probe() {
    const result = useHomeListOptions(AVAILABLE);
    useLayoutEffect(() => {
      controls = result;
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <HomeListOptionsProvider projectGroupingMode="repository" optionsAtom={optionsAtom}>
          <Probe />
        </HomeListOptionsProvider>
      </RegistryContext.Provider>,
    ),
  );
  act(() => controls!.setProjectSortOrder("created_at"));

  expect(registry.get(optionsAtom).projectSortOrder).toBe("created_at");
  act(() => root.unmount());
  registry.dispose();
});
