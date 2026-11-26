import {
  type K3RelayPairingFailureReason,
  type K3RelayPairingProgress,
  k3relayPairingFailureText,
  previewK3RelayIntroductionLink,
  previewK3RelayOffer,
} from "@t3tools/client-runtime/k3relay";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { LockKeyholeIcon, RadioTowerIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";

import { connectK3RelayIntroduction, connectK3RelayPairing } from "~/connection/onboarding";
import { m } from "~/i18n/messages";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export type K3RelayPairingPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "awaiting-approval"; readonly confirmationCode: string }
  | { readonly kind: "redeeming" }
  | { readonly kind: "failed"; readonly message: string };

const isK3RelayPairingError = (
  error: unknown,
): error is {
  readonly _tag: "K3RelayPairingError";
  readonly reason: K3RelayPairingFailureReason;
} =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "K3RelayPairingError";

/** A `k3relay://` link pasted where a host or pairing URL goes belongs to this panel. */
export const isK3RelayPairingLink = (value: string) => value.trim().startsWith("k3relay://");

/** Stateless: everything comes from props, so tests render each step directly. */
export function K3RelayPairingView({
  link,
  deviceName,
  phase,
  now,
  onLinkChange,
  onDeviceNameChange,
  onPair,
}: {
  readonly link: string;
  readonly deviceName: string;
  readonly phase: K3RelayPairingPhase;
  readonly now: number;
  readonly onLinkChange: (link: string) => void;
  readonly onDeviceNameChange: (name: string) => void;
  readonly onPair: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const busy =
    phase.kind === "connecting" || phase.kind === "awaiting-approval" || phase.kind === "redeeming";
  const introductionPreview =
    link.trim() === "" ? null : previewK3RelayIntroductionLink(link.trim(), now);
  const introduction =
    typeof introductionPreview === "object" && introductionPreview?.kind === "introduction"
      ? introductionPreview
      : null;
  const preview =
    link.trim() === ""
      ? null
      : typeof introductionPreview === "string"
        ? introductionPreview
        : introduction === null
          ? previewK3RelayOffer(link, now)
          : null;
  const offer = typeof preview === "object" ? preview : null;
  const linkProblem =
    typeof preview === "string" ? k3relayPairingFailureText(preview, resolve) : null;

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
        <LockKeyholeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>
            <T>
              Use this when this device can't reach the host directly. Everything is end-to-end
              encrypted: the relay only passes along ciphertext it cannot read.
            </T>
          </p>
          <p>
            <T>
              This device saves the host's key, a relay pass and its own key, which never leaves it.
              The relay stores no device names, project names or messages.
            </T>
          </p>
        </div>
      </div>

      {phase.kind === "awaiting-approval" ? (
        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-4 text-center">
          <p className="text-xs font-medium text-muted-foreground">
            <T>Confirmation code</T>
          </p>
          <p
            className="font-mono text-3xl font-semibold tracking-widest text-foreground tabular-nums"
            data-testid="k3relay-confirmation-code"
          >
            {phase.confirmationCode}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {introduction !== null ? (
              <T>
                Check that the introducing device shows exactly this code, then approve there. If
                the codes differ, cancel there: someone else may have scanned the QR code.
              </T>
            ) : (
              <T>
                Check that the host shows exactly this code, then approve there. If the codes
                differ, reject on the host: someone else may be pairing.
              </T>
            )}
          </p>
          <p
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Spinner aria-hidden className="size-3" />
            <T>Waiting for the host to approve…</T>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Pairing link</T>
            </span>
            <Input
              value={link}
              onChange={(event) => onLinkChange(event.target.value)}
              placeholder="k3relay://pair?…"
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          {introduction !== null ? (
            <p className="text-2xs text-muted-foreground" data-testid="k3relay-introduction-link">
              {gt(
                "An introduction from one of your devices, for {count, plural, =1 {one host} other {{count} hosts}}. Approve it on that device after comparing codes.",
                { count: introduction.hosts },
              )}
            </p>
          ) : offer !== null ? (
            <p className="flex items-start gap-2 text-2xs text-muted-foreground">
              <RadioTowerIcon aria-hidden className="mt-px size-3 shrink-0" />
              <span>
                <T>
                  Relay:{" "}
                  <span className="font-mono break-all text-foreground">
                    <Var>{offer.relayUrl}</Var>
                  </span>
                  . The host chooses its relay in Settings › Relay, and a self-hosted relay works
                  the same way.
                </T>
              </span>
            </p>
          ) : linkProblem !== null ? (
            <p className="text-2xs text-destructive">{linkProblem}</p>
          ) : (
            <p className="text-2xs text-muted-foreground">
              <T>
                On the host, open Settings › Relay and choose Add device to get a link or QR code.
              </T>
            </p>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Name for this device</T>
            </span>
            <Input
              value={deviceName}
              onChange={(event) => onDeviceNameChange(event.target.value)}
              maxLength={64}
              disabled={busy}
            />
            <span className="mt-1 block text-2xs text-muted-foreground">
              <T>Shown on the host's approval screen. The relay never sees it.</T>
            </span>
          </label>
        </div>
      )}

      {phase.kind === "failed" ? (
        <Alert variant="error">
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
      ) : null}

      {phase.kind !== "awaiting-approval" ? (
        <Button
          variant="outline"
          className="w-full"
          disabled={busy || (offer === null && introduction === null) || deviceName.trim() === ""}
          onClick={onPair}
        >
          {phase.kind === "connecting"
            ? gt("Connecting to the relay…")
            : phase.kind === "redeeming"
              ? gt("Signing in…")
              : gt("Pair through the relay")}
        </Button>
      ) : null}
    </div>
  );
}

const phaseOf = (progress: K3RelayPairingProgress): K3RelayPairingPhase =>
  progress.phase === "awaiting-approval"
    ? { kind: "awaiting-approval", confirmationCode: progress.confirmationCode }
    : progress.phase === "redeeming"
      ? { kind: "redeeming" }
      : { kind: "connecting" };

export function K3RelayPairingPanel({
  initialLink = "",
  defaultDeviceName,
  onPaired,
}: {
  readonly initialLink?: string;
  readonly defaultDeviceName: string;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const resolve = useMessages();
  const pair = useAtomCommand(connectK3RelayPairing, { reportFailure: false });
  const introduce = useAtomCommand(connectK3RelayIntroduction, { reportFailure: false });
  const [link, setLink] = useState(initialLink);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [phase, setPhase] = useState<K3RelayPairingPhase>({ kind: "idle" });
  // Read when the link changes, not during render: it only decides whether the offer expired.
  const [now, setNow] = useState(() => Date.now());
  // A result for an attempt the user moved on from (a new link) must not land.
  const attemptRef = useRef(0);

  const joinIntroduction = async (attempt: number) => {
    const result = await introduce({
      link: link.trim(),
      deviceName: deviceName.trim(),
      onProgress: (progress) => {
        if (attempt !== attemptRef.current) return;
        setPhase(
          progress.phase === "awaiting-approval"
            ? { kind: "awaiting-approval", confirmationCode: progress.confirmationCode }
            : progress.phase === "redeeming"
              ? { kind: "redeeming" }
              : { kind: "connecting" },
        );
      },
    });
    if (attempt !== attemptRef.current) return;
    if (result._tag === "Success") {
      const joined = result.value.find((host) => host.ok);
      const refused = result.value.find((host) => !host.ok);
      if (joined?.ok) {
        setPhase({ kind: "idle" });
        onPaired(joined.environmentId);
      } else {
        setPhase({
          kind: "failed",
          message: k3relayPairingFailureText(
            refused !== undefined && !refused.ok ? refused.reason : "rejected",
            resolve,
          ),
        });
      }
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setPhase({ kind: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setPhase({
      kind: "failed",
      message: k3relayPairingFailureText(
        isK3RelayPairingError(error) ? error.reason : "invalid-reply",
        resolve,
      ),
    });
  };

  const start = async () => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: "connecting" });
    const introductionLink = previewK3RelayIntroductionLink(link.trim(), Date.now());
    if (typeof introductionLink === "object" && introductionLink.kind === "introduction") {
      return joinIntroduction(attempt);
    }
    const result = await pair({
      link: link.trim(),
      deviceName: deviceName.trim(),
      onProgress: (progress) => {
        if (attempt === attemptRef.current) setPhase(phaseOf(progress));
      },
    });
    if (attempt !== attemptRef.current) return;
    if (result._tag === "Success") {
      setPhase({ kind: "idle" });
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setPhase({ kind: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setPhase({
      kind: "failed",
      message: isK3RelayPairingError(error)
        ? k3relayPairingFailureText(error.reason, resolve)
        : error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : k3relayPairingFailureText("redeem-failed", resolve),
    });
  };

  return (
    <K3RelayPairingView
      link={link}
      deviceName={deviceName}
      phase={phase}
      now={now}
      onLinkChange={(next) => {
        attemptRef.current += 1;
        setNow(Date.now());
        setLink(next);
        setPhase({ kind: "idle" });
      }}
      onDeviceNameChange={setDeviceName}
      onPair={() => void start()}
    />
  );
}
