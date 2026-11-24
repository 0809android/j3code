import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LegacyImportKind } from "@t3tools/contracts";
import { ClientSettingsPatch } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { useContext, useState } from "react";

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

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

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
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const scan = AsyncResult.getOrElse(useAtomValue(scanAtom(environmentId)), () => null);
  const run = useAtomCommand(legacyImportRun, { reportFailure: false });
  const restart = useAtomCommand(legacyImportRestart, { reportFailure: false });
  const [unchecked, setUnchecked] = useState<ReadonlySet<LegacyImportKind>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "idle" });

  const available = (scan?.items ?? []).filter((item) => item.available);
  const chosen = available.filter((item) => !unchecked.has(item.kind));
  const busy = outcome._tag === "running" || outcome._tag === "restarting";

  const labels: Record<LegacyImportKind, string> = {
    settings: gt("Settings and keyboard shortcuts"),
    providers: gt("Provider settings"),
    sessions: gt("Sessions and history"),
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
    setOutcome({ _tag: "restarting" });
    await restart({ environmentId, input: {} });
  };

  const done = outcome._tag === "done" || outcome._tag === "restarting";

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
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
          {outcome._tag === "done" && outcome.restartRequired && scan?.canRestart === true ? (
            <Button onClick={() => void restartNow()}>{gt("Restart now")}</Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
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
    "j3code:legacy-import-prompted",
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
    />
  );
}
