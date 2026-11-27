import {
  AuthEnvironmentMaintainScope,
  DEFAULT_SERVER_SETTINGS,
  type ThreadHistoryTrimReport,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  mocks: {
    preview: vi.fn(),
    trim: vi.fn(),
    writeSettings: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    withoutMaintain: false,
    maintainOnly: null as string | null,
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../../../state/server", () => ({
  serverEnvironment: {
    previewThreadHistoryTrim: "preview",
    trimThreadHistory: "trim",
    threadHistoryTrim: () => ({}),
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: "preview" | "trim") => mocks[command],
}));
vi.mock("../../../state/session", () => ({
  useEnvironmentsWithScope: (
    environments: ReadonlyArray<{ environmentId: string }>,
    scope: string,
  ) =>
    new Set(
      mocks.withoutMaintain && scope === AuthEnvironmentMaintainScope
        ? []
        : environments
            .filter(
              (environment) =>
                mocks.maintainOnly === null ||
                scope !== AuthEnvironmentMaintainScope ||
                environment.environmentId === mocks.maintainOnly,
            )
            .map((environment) => environment.environmentId),
    ),
}));
vi.mock("../useSettingsWriter", () => ({ useSettingsWriter: () => mocks.writeSettings }));
vi.mock("../../../components/ui/Dialog", () => ({ alert: mocks.alert, confirm: mocks.confirm }));
vi.mock("../../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <div>
      {children}
      <p>{footer}</p>
    </div>
  ),
}));
vi.mock("./SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("../../../components/ui/NumberField", () => ({
  NumberField: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: number;
    disabled?: boolean;
    onValueChange: (value: number) => void;
  }) => (
    <button aria-label={label} disabled={disabled} onClick={() => onValueChange(value + 1)}>
      {value}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { ThreadHistoryTrimSection } from "./ThreadHistoryTrimSection";

type Targets = Parameters<typeof ThreadHistoryTrimSection>[0]["targets"];

function target(options: { days: number | null; capable?: boolean; id?: string }) {
  return {
    environmentId: options.id ?? "local",
    label: options.id ?? "Local",
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          threadHistoryAfterDays: options.days,
        },
      },
      environment: {
        capabilities: options.capable === false ? {} : { threadHistoryTrim: true },
      },
    },
  } as unknown as Targets[number];
}

const report = (threadCount: number): ThreadHistoryTrimReport => ({
  dryRun: true,
  afterDays: 30,
  threadCount,
  itemCount: threadCount * 10,
  estimatedBytes: 2048,
});

// The server only queues the pass, so a real trim answers with zeros.
const zeroReport: ThreadHistoryTrimReport = {
  ...report(0),
  dryRun: false,
  estimatedBytes: 0,
};

let root: Root;
let container: HTMLDivElement;

const render = (...targets: Targets) =>
  act(() => root.render(<ThreadHistoryTrimSection targets={targets} />));
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  )!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.withoutMaintain = false;
  mocks.maintainOnly = null;
  for (const mock of [mocks.preview, mocks.trim, mocks.writeSettings, mocks.alert, mocks.confirm]) {
    mock.mockReset();
  }
  mocks.writeSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ThreadHistoryTrimSection", () => {
  it("renders nothing for a server that cannot trim thread history", () => {
    render(target({ days: null, capable: false }));
    expect(container.innerHTML).toBe("");
  });

  it("turns trimming on at 30 days, changes the days, and turns it off again", () => {
    render(target({ days: null }));
    expect(button("Days without use")).toBeUndefined();

    act(() => button("Trim old threads").click());
    expect(mocks.writeSettings).toHaveBeenLastCalledWith(expect.anything(), [
      { environmentId: "local", patch: { storageCleanup: { threadHistoryAfterDays: 30 } } },
    ]);

    render(target({ days: 30 }));
    expect(button("Days without use").textContent).toBe("30");
    act(() => button("Days without use").click());
    expect(mocks.writeSettings).toHaveBeenLastCalledWith(expect.anything(), [
      { environmentId: "local", patch: { storageCleanup: { threadHistoryAfterDays: 31 } } },
    ]);

    act(() => button("Trim old threads").click());
    expect(mocks.writeSettings).toHaveBeenLastCalledWith(expect.anything(), [
      { environmentId: "local", patch: { storageCleanup: { threadHistoryAfterDays: null } } },
    ]);
  });

  it("cannot trim now while the days are unset", () => {
    render(target({ days: null }));
    expect(button("Trim now").disabled).toBe(true);

    render(target({ days: 30 }));
    expect(button("Trim now").disabled).toBe(false);
  });

  it("shows what qualifies and trims only after confirmation", async () => {
    mocks.preview.mockResolvedValue({ _tag: "Success", value: report(3) });
    mocks.trim.mockResolvedValue({ _tag: "Success", value: zeroReport });
    render(target({ days: 30 }));

    await act(async () => button("Trim now").click());
    expect(mocks.preview).toHaveBeenCalledWith({ environmentId: "local", input: {} });
    expect(mocks.trim).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
      title: "Trim old threads?",
      destructive: true,
    });
    expect(mocks.confirm.mock.calls[0]![0].message).toContain("3 unused threads");

    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
    expect(mocks.trim).toHaveBeenCalledWith({ environmentId: "local", input: {} });
  });

  it("reports the previewed count and size even though the server returns zero", async () => {
    mocks.preview.mockResolvedValue({ _tag: "Success", value: report(3) });
    mocks.trim.mockResolvedValue({ _tag: "Success", value: zeroReport });
    render(target({ days: 30 }));

    await act(async () => button("Trim now").click());
    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
    expect(mocks.alert).toHaveBeenCalledWith(
      "Trimming 3 threads",
      expect.stringContaining("2.0 KB"),
    );
  });

  it("trims the environments with maintenance access when others lack it", async () => {
    mocks.maintainOnly = "a";
    mocks.preview.mockResolvedValue({ _tag: "Success", value: report(2) });
    mocks.trim.mockResolvedValue({ _tag: "Success", value: zeroReport });
    render(target({ days: 30, id: "a" }), target({ days: 30, id: "b" }));

    expect(button("Trim now").disabled).toBe(false);
    await act(async () => button("Trim now").click());
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledWith({ environmentId: "a", input: {} });
    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
    expect(mocks.trim).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("needs maintenance access");
  });

  it("says so, without asking to confirm, when nothing qualifies", async () => {
    mocks.preview.mockResolvedValue({ _tag: "Success", value: report(0) });
    render(target({ days: 30 }));

    await act(async () => button("Trim now").click());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Nothing to trim",
      "No threads have gone unused long enough yet.",
    );
  });

  it("is read-only without maintenance access", () => {
    mocks.withoutMaintain = true;
    render(target({ days: 30 }));

    expect(button("Trim old threads").disabled).toBe(true);
    expect(button("Days without use").disabled).toBe(true);
    expect(button("Trim now").disabled).toBe(true);
    expect(container.textContent).toContain("needs maintenance access");
  });
});
