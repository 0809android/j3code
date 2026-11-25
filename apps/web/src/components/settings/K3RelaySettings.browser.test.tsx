import type { K3RelayHostState } from "@t3tools/client-runtime/k3relay";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type K3RelaySettingsActions, K3RelaySettingsView } from "./K3RelaySettings";

const NOW = 1_800_000_000_000;

const baseState: K3RelayHostState = {
  enabled: true,
  relayUrl: "https://relay.k3.kinocode.jp/",
  status: "online",
  statusDetail: null,
  allowedByPolicy: true,
  networkAccessEnabled: true,
  offer: null,
  pending: null,
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
        actions={actions}
        state={{
          ...baseState,
          pending: {
            deviceId: "d".repeat(32),
            name: "Kino's phone",
            alg: "ed25519",
            confirmationCode: "K7QM-2XFD",
            approvalDeadline: NOW + 600_000,
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
    expect(actions.approve).toHaveBeenCalledWith("d".repeat(32));
    await screen.getByRole("button", { name: "Reject" }).click();
    expect(actions.reject).toHaveBeenCalledWith("d".repeat(32));
  });

  it("warns about hijacking before showing the offer as a link", async () => {
    await using screen = await render(
      <K3RelaySettingsView
        canWrite
        busy={false}
        actions={makeActions()}
        state={{
          ...baseState,
          offer: { link: "k3relay://pair?v=1#s=secret", expiresAt: NOW + 300_000 },
        }}
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
        actions={actions}
        state={{
          ...baseState,
          devices: [
            {
              deviceId: "a".repeat(32),
              name: "Old laptop",
              alg: "ed25519",
              approvedAt: NOW - 86_400_000,
              revokedAt: NOW,
              lastSeenAt: null,
            },
            {
              deviceId: "b".repeat(32),
              name: "Phone",
              alg: "p256",
              approvedAt: NOW,
              revokedAt: null,
              lastSeenAt: null,
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
        actions={makeActions()}
        state={{ ...baseState, enabled: false, status: "disabled", networkAccessEnabled: false }}
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
        actions={makeActions()}
        state={{ ...baseState, networkAccessEnabled: false }}
      />,
    );
    await expect.element(screen.getByText("Network access is off")).toBeVisible();
    await expect
      .element(screen.getByText(/Devices paired through the relay can still reach this machine/))
      .toBeVisible();
  });
});
