import type { K3RelayHostState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type K3RelaySettingsActions, K3RelaySettingsView } from "./K3RelaySettings";

const NOW = 1_800_000_000_000;

const baseState: K3RelayHostState = {
  enabled: true,
  policyAllowed: true,
  transportPolicyAllowed: true,
  relayUrl: "wss://relay.k3.kinocode.jp",
  status: "connected",
  error: null,
  registered: true,
  hostId: "h".repeat(32),
  activeSessions: 0,
  connectedDevices: 0,
  maxSessions: 8,
  reachableWhenNetworkAccessOff: true,
  requireApproval: true,
  pairing: { phase: "idle" },
  devices: [],
};

const makeActions = () =>
  ({
    setEnabled: vi.fn(),
    setRelayUrl: vi.fn(),
    createOffer: vi.fn(),
    cancelOffer: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    revoke: vi.fn(),
    rename: vi.fn(),
  }) satisfies K3RelaySettingsActions;

describe("K3RelaySettingsView", () => {
  it("asks to compare the code before approving a pending device", async () => {
    const actions = makeActions();
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={null}
        networkAccessEnabled
        actions={actions}
        state={{
          ...baseState,
          pairing: {
            phase: "awaiting-approval",
            deviceId: "d".repeat(32),
            deviceName: "Kino's phone",
            alg: "ed25519",
            confirmationCode: "K7QM-2XFD",
            approvalDeadline: NOW + 600_000,
            approval: "compare-code",
          },
        }}
      />,
    );
    const pending = screen.getByTestId("k3relay-pending");
    await expect.element(pending).toHaveTextContent("Kino's phone wants to connect");
    await expect.element(pending).toHaveTextContent("K7QM-2XFD");
    await expect
      .element(pending.getByText(/is in your hands and shows this exact code/))
      .toBeVisible();
    await screen.getByRole("button", { name: "Approve" }).click();
    // The approval names the code the user compared; the host refuses one without it.
    expect(actions.approve).toHaveBeenCalledWith("d".repeat(32), "K7QM-2XFD");
    await screen.getByRole("button", { name: "Reject" }).click();
    expect(actions.reject).toHaveBeenCalled();
  });

  it("approves with one tap, and no code, when the host offers it", async () => {
    const actions = makeActions();
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={null}
        networkAccessEnabled
        actions={actions}
        state={{
          ...baseState,
          pairing: {
            phase: "awaiting-approval",
            deviceId: "e".repeat(32),
            deviceName: "Kino's tablet",
            alg: "p256",
            confirmationCode: "K7QM-2XFD",
            approvalDeadline: NOW + 600_000,
            approval: "one-tap",
          },
        }}
      />,
    );
    const pending = screen.getByTestId("k3relay-pending");
    await expect.element(pending).not.toHaveTextContent("K7QM-2XFD");
    await expect.element(pending.getByText(/new device is in your hands/)).toBeVisible();
    await screen.getByRole("button", { name: "Approve" }).click();
    expect(actions.approve).toHaveBeenCalledWith("e".repeat(32), undefined);
  });

  it("warns about hijacking before showing the offer as a link", async () => {
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={{
          link: "k3relay://pair?v=1#s=secret",
          relayUrl: "https://relay.k3.kinocode.jp",
          hostId: "h".repeat(32),
          hostIdentityKey: "k".repeat(43),
          expiresAt: NOW + 300_000,
        }}
        networkAccessEnabled
        actions={makeActions()}
        state={{ ...baseState, pairing: { phase: "open", expiresAt: NOW + 300_000 } }}
      />,
    );
    await expect.element(screen.getByTestId("k3relay-offer")).toBeVisible();
    expect(screen.getByText(/can try to pair in its place/).query()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show as a link instead" }));
    await expect.element(screen.getByText(/can try to pair in its place/)).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Relay pairing link" }))
      .toHaveValue("k3relay://pair?v=1#s=secret");
  });

  it("lists revoked devices without actions, and active ones with revoke and rename", async () => {
    const actions = makeActions();
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={null}
        networkAccessEnabled
        actions={actions}
        state={{
          ...baseState,
          devices: [
            {
              deviceId: "a".repeat(32),
              name: "Old laptop",
              alg: "ed25519",
              createdAt: NOW - 86_400_000,
              lastSeenAt: null,
              status: "revoked",
              revokedAt: NOW,
              connectedSessions: 0,
            },
            {
              deviceId: "b".repeat(32),
              name: "Phone",
              alg: "p256",
              createdAt: NOW,
              lastSeenAt: null,
              status: "active",
              revokedAt: null,
              connectedSessions: 0,
            },
          ],
        }}
      />,
    );
    const rows = screen.getByTestId("k3relay-device");
    await expect.element(rows.nth(1).getByText("Old laptop")).toBeVisible();
    await expect.element(rows.nth(1).getByText(/^Revoked/)).toBeVisible();
    expect(rows.nth(1).getByRole("button").query()).toBeNull();
    await rows.nth(0).getByRole("button", { name: "Revoke" }).click();
    expect(actions.revoke).toHaveBeenCalledWith("b".repeat(32));
  });

  it("when the relay is off: no pairing, an Off status, and network access still explained when on", async () => {
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={null}
        networkAccessEnabled={false}
        actions={makeActions()}
        state={{
          ...baseState,
          enabled: false,
          status: "disabled",
          reachableWhenNetworkAccessOff: false,
        }}
      />,
    );
    await expect.element(screen.getByTestId("k3relay-status")).toHaveTextContent("Off");
    expect(screen.getByRole("button", { name: "Add device" }).query()).toBeNull();
    expect(screen.getByText("Network access is off").query()).toBeNull();
  });

  it("says the relay still reaches the machine while network access is off", async () => {
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        offer={null}
        networkAccessEnabled={false}
        actions={makeActions()}
        state={baseState}
      />,
    );
    await expect.element(screen.getByText("Network access is off")).toBeVisible();
    await expect
      .element(screen.getByText(/Devices paired through the relay can still reach this machine/))
      .toBeVisible();
  });
});
