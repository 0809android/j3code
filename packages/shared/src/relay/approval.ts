/**
 * Approval of new devices (spec §20.3, §18.2). Approval is on by default; turning it off needs
 * a recorded, explicit choice. New devices are only considered while an "Add device" window
 * is open, and QR pairing always asks the user to compare confirmation codes (§8).
 */

export const ADD_DEVICE_WINDOW_MS = 10 * 60_000;

/** Lets an approved device introduce or approve others (§18.2). Never granted by pairing. */
export type DevicePermission = "devices:invite";

export type ApprovalActor =
  | { readonly kind: "host-user" }
  | {
      readonly kind: "device";
      readonly deviceId: string;
      readonly permissions: ReadonlyArray<DevicePermission>;
    };

export interface ApprovalPolicy {
  readonly requireApproval: boolean;
  /** Recorded when the user turned approval off after being shown the risk. */
  readonly optOut: { readonly chosenAt: number; readonly acknowledgedRisk: true } | null;
}

export const defaultApprovalPolicy: ApprovalPolicy = { requireApproval: true, optOut: null };

/** The only way to turn approval off: the user's own choice, with its time recorded. */
export const disableApproval = (now: number): ApprovalPolicy => ({
  requireApproval: false,
  optOut: { chosenAt: now, acknowledgedRisk: true },
});

/** Approval stays on unless it was switched off with a recorded acknowledgement. */
export const approvalRequired = (policy: ApprovalPolicy): boolean =>
  policy.requireApproval || policy.optOut?.acknowledgedRisk !== true;

export interface AddDeviceWindow {
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly openedBy: ApprovalActor;
  /** The one-tap approval is for the first device only. */
  readonly used: boolean;
}

const canInvite = (actor: ApprovalActor): boolean =>
  actor.kind === "host-user" || actor.permissions.includes("devices:invite");

/** Opens the 10-minute window. Devices need `devices:invite`; otherwise `null`. */
export const openAddDeviceWindow = (actor: ApprovalActor, now: number): AddDeviceWindow | null =>
  canInvite(actor)
    ? { openedAt: now, expiresAt: now + ADD_DEVICE_WINDOW_MS, openedBy: actor, used: false }
    : null;

export const isAddDeviceWindowOpen = (window: AddDeviceWindow | null, now: number): boolean =>
  window !== null && now >= window.openedAt && now < window.expiresAt;

export type PairingRoute = "qr" | "account";

export type ApprovalDecision =
  | { readonly kind: "reject"; readonly reason: "outside-window" }
  /** Show the confirmation code on both sides; the user compares and approves. */
  | { readonly kind: "compare-code" }
  /** First device in a window the host's user opened: one tap, no comparison. */
  | { readonly kind: "one-tap" }
  /** Approval is off by the user's recorded choice. */
  | { readonly kind: "auto-approve" };

export const decideNewDeviceApproval = (input: {
  readonly policy: ApprovalPolicy;
  readonly window: AddDeviceWindow | null;
  readonly route: PairingRoute;
  readonly now: number;
}): ApprovalDecision => {
  if (input.window === null || !isAddDeviceWindowOpen(input.window, input.now)) {
    return { kind: "reject", reason: "outside-window" };
  }
  if (input.route === "qr") return { kind: "compare-code" };
  if (!approvalRequired(input.policy)) return { kind: "auto-approve" };
  if (input.window.openedBy.kind === "host-user" && !input.window.used) return { kind: "one-tap" };
  return { kind: "compare-code" };
};

/** Marks the window's one-tap approval as spent once a device was approved through it. */
export const consumeAddDeviceWindow = (window: AddDeviceWindow): AddDeviceWindow => ({
  ...window,
  used: true,
});
