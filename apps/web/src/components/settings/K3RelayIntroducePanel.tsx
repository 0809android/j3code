import {
  type K3RelayIntroductionApproval,
  type K3RelayIntroductionClaims,
  type K3RelayIntroductionFailureReason,
  type K3RelayIntroductionSession,
  k3relayIntroductionFailureText,
} from "@t3tools/client-runtime/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { UsersRoundIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";

import { k3relayIntroducer } from "~/connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export type K3RelayIntroducePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "waiting"; readonly session: K3RelayIntroductionSession }
  | {
      readonly kind: "compare";
      readonly session: K3RelayIntroductionSession;
      readonly claims: K3RelayIntroductionClaims;
    }
  | { readonly kind: "approving" }
  | { readonly kind: "done"; readonly approvals: ReadonlyArray<K3RelayIntroductionApproval> }
  | { readonly kind: "failed"; readonly reason: K3RelayIntroductionFailureReason };

const formatTime = (epochMs: number) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(epochMs);

/** Stateless: each step renders from props, so tests show them directly. */
export function K3RelayIntroduceView({
  phase,
  onStart,
  onApprove,
  onCancel,
  onReset,
}: {
  readonly phase: K3RelayIntroducePhase;
  readonly onStart: () => void;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  return (
    <SettingsSection
      id="k3-relay-introduce"
      title={gt("Introduce a device")}
      icon={<UsersRoundIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title={gt("Add a new device to all your relay hosts at once")}
        description={gt(
          "The new device scans a QR code from this one, and you compare one code on both screens. Each host must first allow this device to introduce, in its relay settings.",
        )}
        control={
          phase.kind === "idle" || phase.kind === "done" || phase.kind === "failed" ? (
            <Button
              size="xs"
              onClick={phase.kind === "idle" ? onStart : onReset}
              data-testid="k3relay-introduce-start"
            >
              {phase.kind === "idle" ? <T>Introduce a device</T> : <T>Start again</T>}
            </Button>
          ) : null
        }
      />
      {phase.kind === "opening" || phase.kind === "approving" ? (
        <div className={ITEM_ROW_CLASSNAME} role="status">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {phase.kind === "opening" ? <T>Asking your hosts…</T> : <T>Approving on your hosts…</T>}
          </p>
        </div>
      ) : null}
      {phase.kind === "waiting" ? (
        <div className={ITEM_ROW_CLASSNAME} data-testid="k3relay-introduce-qr">
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              <T>Scan with the new device</T>
            </p>
            <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
              <QRCodeSvg
                value={phase.session.link}
                size={168}
                level="M"
                marginSize={2}
                title={gt("Introduction code. Scan it with the new device")}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              <T>
                For <Var>{phase.session.opened.map((window) => window.host.label).join(", ")}</Var>.
                Valid until <Var>{formatTime(phase.session.expiresAt)}</Var>. Show it in person
                only.
              </T>
            </p>
            {phase.session.refused.map(({ host, reason }) => (
              <p key={host.hostId} className="text-xs text-muted-foreground">
                <T>
                  Not included: <Var>{host.label}</Var>.{" "}
                  <Var>{k3relayIntroductionFailureText(reason, resolve)}</Var>
                </T>
              </p>
            ))}
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3" />
              <T>Waiting for the new device…</T>
            </p>
            <Button size="xs" variant="outline" onClick={onCancel}>
              <T>Cancel</T>
            </Button>
          </div>
        </div>
      ) : null}
      {phase.kind === "compare" ? (
        <div className={ITEM_ROW_CLASSNAME} data-testid="k3relay-introduce-compare">
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              <T>
                <Var>{phase.claims.deviceName}</Var> wants to join{" "}
                <Var>{phase.claims.claims.map(({ window }) => window.host.label).join(", ")}</Var>
              </T>
            </p>
            <p className="font-mono text-2xl font-semibold tracking-widest text-foreground tabular-nums">
              {phase.claims.confirmationCode}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              <T>
                Approve only if the new device is in your hands and shows this exact code. A
                different code means someone else scanned the QR code: cancel.
              </T>
            </p>
            {phase.claims.unclaimed.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>
                  The new device did not reach{" "}
                  <Var>{phase.claims.unclaimed.map((window) => window.host.label).join(", ")}</Var>.
                  Introduce it again later for those.
                </T>
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="xs" variant="destructive-outline" onClick={onCancel}>
                <T>Cancel</T>
              </Button>
              <Button size="xs" onClick={onApprove}>
                <T>Approve</T>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {phase.kind === "done" ? (
        <div className={ITEM_ROW_CLASSNAME} data-testid="k3relay-introduce-done">
          <ul className="space-y-1 text-xs">
            {phase.approvals.map(({ host, result }) => (
              <li key={host.hostId} className="text-muted-foreground">
                {result.ok ? (
                  <T>
                    <Var>{host.label}</Var>: added
                  </T>
                ) : (
                  <T>
                    <Var>{host.label}</Var>:{" "}
                    <Var>{k3relayIntroductionFailureText(result.reason, resolve)}</Var>
                  </T>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <Alert variant="error">
            <AlertDescription>
              {k3relayIntroductionFailureText(phase.reason, resolve)}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
    </SettingsSection>
  );
}

const reasonOf = (result: {
  readonly cause: Cause.Cause<unknown>;
}): K3RelayIntroductionFailureReason => {
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "K3RelayIntroductionError"
    ? (error as unknown as { readonly reason: K3RelayIntroductionFailureReason }).reason
    : "internal";
};

/** This device introduces a new one to every host it reaches through the relay. */
export function K3RelayIntroducePanel() {
  const options = { reportFailure: false } as const;
  const open = useAtomCommand(k3relayIntroducer.open, options);
  const collect = useAtomCommand(k3relayIntroducer.collect, options);
  const approve = useAtomCommand(k3relayIntroducer.approve, options);
  const cancel = useAtomCommand(k3relayIntroducer.cancel, options);
  const [phase, setPhase] = useState<K3RelayIntroducePhase>({ kind: "idle" });
  // A result for an introduction the user cancelled must not land.
  const attemptRef = useRef(0);

  const start = async () => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: "opening" });
    const opened = await open({});
    if (attempt !== attemptRef.current) return;
    if (opened._tag !== "Success") {
      setPhase(
        isAtomCommandInterrupted(opened)
          ? { kind: "idle" }
          : { kind: "failed", reason: reasonOf(opened) },
      );
      return;
    }
    const session = opened.value;
    setPhase({ kind: "waiting", session });
    const collected = await collect(session);
    if (attempt !== attemptRef.current) return;
    if (collected._tag !== "Success") {
      void cancel(session);
      setPhase(
        isAtomCommandInterrupted(collected)
          ? { kind: "idle" }
          : { kind: "failed", reason: reasonOf(collected) },
      );
      return;
    }
    setPhase({ kind: "compare", session, claims: collected.value });
  };

  const confirm = async () => {
    if (phase.kind !== "compare") return;
    const attempt = ++attemptRef.current;
    const { claims } = phase;
    setPhase({ kind: "approving" });
    const approved = await approve({ claims, confirmationCode: claims.confirmationCode });
    if (attempt !== attemptRef.current) return;
    setPhase(
      approved._tag === "Success"
        ? { kind: "done", approvals: approved.value }
        : { kind: "failed", reason: reasonOf(approved) },
    );
  };

  const stop = () => {
    attemptRef.current += 1;
    if (phase.kind === "waiting" || phase.kind === "compare") void cancel(phase.session);
    setPhase({ kind: "idle" });
  };

  return (
    <K3RelayIntroduceView
      phase={phase}
      onStart={() => void start()}
      onApprove={() => void confirm()}
      onCancel={stop}
      onReset={() => {
        attemptRef.current += 1;
        setPhase({ kind: "idle" });
      }}
    />
  );
}
