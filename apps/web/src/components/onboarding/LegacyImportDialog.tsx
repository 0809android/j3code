import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LegacyImportKind, LegacyImportScanResult } from "@t3tools/contracts";
import { ClientSettingsPatch } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { useContext, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { updateClientSettings } from "../../hooks/useSettings";
import { legacyImportRestart, legacyImportRun, legacyImportScan } from "../../state/legacyImport";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const scanAtom = (environmentId: EnvironmentId) => legacyImportScan({ environmentId, input: {} });

const SERVER_SHUTDOWN_DELAY_MS = 750;
const RESTART_POLL_INTERVAL_MS = 300;
// 数 GB の履歴を取り込んだ最初の起動は、スレッドの後始末に 1 分ほどかかることがある。
const RESTART_TIMEOUT_MS = 180_000;

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

function waitForLegacyImportApplied(
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<typeof scanAtom>,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    let readyToCheck = false;
    let pollTimer: number | undefined;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(delayTimer);
      window.clearTimeout(timeoutTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };

    const check = (result: AsyncResult.AsyncResult<LegacyImportScanResult, unknown>) => {
      if (!readyToCheck) return;
      if (!result.waiting && result._tag === "Success" && !result.value.sessionsStaged) {
        finish(true);
      }
    };

    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort);

    const unsubscribe = registry.subscribe(atom, check);
    const delayTimer = window.setTimeout(() => {
      readyToCheck = true;
      const current = registry.get(atom);
      check(current);
      if (!settled && !current.waiting) {
        registry.refresh(atom);
      }
      if (!settled) {
        pollTimer = window.setInterval(() => {
          const latest = registry.get(atom);
          check(latest);
          if (!settled && !latest.waiting) {
            registry.refresh(atom);
          }
        }, RESTART_POLL_INTERVAL_MS);
      }
    }, SERVER_SHUTDOWN_DELAY_MS);

    const timeoutTimer = window.setTimeout(() => finish(false), RESTART_TIMEOUT_MS);
  });
}

/** Reads the other install's device-local settings key by key, so one stale key skips only itself. */
function decodeClientSettings(settings: Readonly<Record<string, unknown>>) {
  const decode = Schema.decodeUnknownOption(ClientSettingsPatch);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (Option.isSome(decode({ [key]: value }))) patch[key] = value;
  }
  return patch;
}

/** The imported kinds, to be listed once the data is in. */
type Outcome =
  | { readonly _tag: "idle" }
  | { readonly _tag: "running" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "done"; readonly restartRequired: boolean }
  | { readonly _tag: "restarting" };

/**
 * Carries settings, providers and history over from a T3 Code install on this machine. Used by
 * first-run setup and by Settings, so the same choice stays available later.
 */
export function LegacyImportDialog({
  environmentId,
  open,
  onOpenChange,
  onRestarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestarted?: () => void;
}) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const scan = AsyncResult.getOrElse(useAtomValue(scanAtom(environmentId)), () => null);
  const run = useAtomCommand(legacyImportRun, { reportFailure: false });
  const restart = useAtomCommand(legacyImportRestart, { reportFailure: false });
  const [unchecked, setUnchecked] = useState<ReadonlySet<LegacyImportKind>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "idle" });
  const restartAbortRef = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts any pending restart wait when the dialog unmounts
  useEffect(() => () => restartAbortRef.current?.abort(), []);

  const available = (scan?.items ?? []).filter((item) => item.available);
  const chosen = available.filter((item) => !unchecked.has(item.kind));
  const busy = outcome._tag === "running" || outcome._tag === "restarting";

  const labels: Record<LegacyImportKind, string> = {
    settings: gt("Settings and keyboard shortcuts"),
    providers: gt("Provider settings"),
    sessions: gt("Sessions and history"),
  };

  const close = () => {
    if (busy) return;
    setOutcome({ _tag: "idle" });
    onOpenChange(false);
  };

  const startImport = async () => {
    setOutcome({ _tag: "running" });
    const result = await run({
      environmentId,
      input: { kinds: chosen.map((item) => item.kind) },
    });
    if (result._tag === "Success") {
      if (result.value.clientSettings !== undefined) {
        await updateClientSettings(decodeClientSettings(result.value.clientSettings)).catch(
          () => undefined,
        );
      }
      registry.refresh(scanAtom(environmentId));
      setOutcome({ _tag: "done", restartRequired: result.value.restartRequired });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setOutcome({ _tag: "idle" });
      return;
    }
    setOutcome({
      _tag: "failed",
      message: thrownErrorMessage(squashAtomCommandFailure(result)) ?? gt("Unknown error."),
    });
  };

  const restartNow = async () => {
    restartAbortRef.current?.abort();
    const controller = new AbortController();
    restartAbortRef.current = controller;

    setOutcome({ _tag: "restarting" });
    const result = await restart({ environmentId, input: {} });
    if (controller.signal.aborted) return;
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) {
        setOutcome({ _tag: "done", restartRequired: true });
        return;
      }
      setOutcome({
        _tag: "failed",
        message: thrownErrorMessage(squashAtomCommandFailure(result)) ?? gt("Unknown error."),
      });
      return;
    }
    if (!result.value.restarting) {
      registry.refresh(scanAtom(environmentId));
      setOutcome({ _tag: "done", restartRequired: true });
      return;
    }

    const restarted = await waitForLegacyImportApplied(
      registry,
      scanAtom(environmentId),
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (!restarted) {
      registry.refresh(scanAtom(environmentId));
      setOutcome({ _tag: "done", restartRequired: true });
      return;
    }

    onOpenChange(false);
    if (onRestarted !== undefined) {
      onRestarted();
    } else {
      window.location.reload();
    }
  };

  const done = outcome._tag === "done" || outcome._tag === "restarting";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full sm:w-[30rem]">
        <DialogHeader>
          <DialogTitle>{gt("Import from T3 Code")}</DialogTitle>
          <DialogDescription>
            {scan === null || scan.sourceDir === null ? (
              <T>No T3 Code data was found on this computer.</T>
            ) : (
              <T>
                Choose what to bring over from your T3 Code install. Your T3 Code data is only read,
                never changed.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        {scan !== null && scan.sourceDir !== null ? (
          <DialogPanel>
            <div className="flex flex-col gap-1">
              {available.map((item) => (
                <label
                  key={item.kind}
                  className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-muted/40"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={!unchecked.has(item.kind)}
                    disabled={busy || done}
                    onCheckedChange={(checked) =>
                      setUnchecked((current) => {
                        const next = new Set(current);
                        if (checked === true) next.delete(item.kind);
                        else next.add(item.kind);
                        return next;
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-foreground">{labels[item.kind]}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.kind === "providers" && item.count !== undefined
                        ? gt("{count, plural, one {{count} provider} other {{count} providers}}", {
                            count: item.count,
                          })
                        : null}
                      {item.kind === "sessions"
                        ? gt(
                            "Replaces the history in this app after a restart. {size} MB. The current history is kept as a backup file.",
                            { size: item.sizeBytes === undefined ? 0 : megabytes(item.sizeBytes) },
                          )
                        : null}
                      {item.kind === "sessions" ? (
                        <span className="mt-1 block">
                          {gt(
                            "So nothing runs twice, threads still working in T3 Code stop here and scheduled tasks arrive paused. Continue them in this app once you stop using T3 Code.",
                          )}
                        </span>
                      ) : null}
                      {item.kind === "settings"
                        ? gt("Appearance, shortcuts and preferences. Sign-ins and devices stay.")
                        : null}
                    </span>
                  </span>
                </label>
              ))}
              {available.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  <T>There is nothing to import.</T>
                </p>
              ) : null}
            </div>
            {outcome._tag === "failed" ? (
              <p className="mt-3 text-sm text-destructive-foreground">
                {gt("Could not import: {message}", { message: outcome.message })}
              </p>
            ) : null}
            {done ? (
              <p className="mt-3 text-sm text-foreground">
                {outcome._tag === "done" && !outcome.restartRequired
                  ? gt("Imported.")
                  : scan.canRestart
                    ? gt("Imported. Restart to finish bringing over your history.")
                    : gt("Imported. Quit and reopen the app to finish bringing over your history.")}
              </p>
            ) : null}
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {outcome._tag === "restarting" ? (
            <Button disabled>{gt("Restarting…")}</Button>
          ) : outcome._tag === "done" && outcome.restartRequired && scan?.canRestart === true ? (
            <Button onClick={() => void restartNow()}>{gt("Restart now")}</Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={close}>
            {done ? gt("Close") : gt("Skip")}
          </Button>
          {!done && available.length > 0 ? (
            <Button disabled={busy || chosen.length === 0} onClick={() => void startImport()}>
              {outcome._tag === "running" ? gt("Importing…") : gt("Import")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** First run: asks once, when this computer has T3 Code data to bring over. */
export function LegacyImportPrompt({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const scan = AsyncResult.getOrElse(useAtomValue(scanAtom(environmentId)), () => null);
  const [prompted, setPrompted] = useLocalStorage(
    "k3code:legacy-import-prompted",
    false,
    Schema.Boolean,
  );
  const hasData =
    scan !== null && scan.sourceDir !== null && scan.items.some((item) => item.available);
  return (
    <LegacyImportDialog
      environmentId={environmentId}
      open={hasData && !prompted}
      onOpenChange={(open) => {
        if (!open) setPrompted(true);
      }}
      onRestarted={() => {
        setPrompted(true);
        if (isElectron) {
          window.location.hash = "#/";
          window.location.reload();
        } else {
          window.location.replace("/");
        }
      }}
    />
  );
}
