import { encodePairingLink, relayHostId } from "@t3tools/shared/relay";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type K3RelayPairingPhase, K3RelayPairingView } from "./K3RelayPairingPanel";

const NOW = 1_800_000_000_000;
const hostKey = new Uint8Array(32).fill(7);
const LINK = encodePairingLink({
  relayUrl: "https://relay.example.com/",
  hostId: relayHostId(hostKey),
  hostIdentityKey: hostKey,
  secret: new Uint8Array(16).fill(3),
  expiresAt: NOW + 300_000,
});

function View({
  link = LINK,
  phase = { kind: "idle" },
  onPair = () => {},
}: {
  readonly link?: string;
  readonly phase?: K3RelayPairingPhase;
  readonly onPair?: () => void;
}) {
  return (
    <K3RelayPairingView
      link={link}
      deviceName="Kino's phone"
      phase={phase}
      now={NOW}
      onLinkChange={() => {}}
      onDeviceNameChange={() => {}}
      onPair={onPair}
    />
  );
}

describe("K3RelayPairingView", () => {
  it("says what the relay can see and which relay the link uses before anything is sent", async () => {
    const onPair = vi.fn();
    await using screen = await render(<View onPair={onPair} />);
    await expect.element(screen.getByText(/the relay only passes along ciphertext/)).toBeVisible();
    await expect.element(screen.getByText(/stores no device names/)).toBeVisible();
    await expect.element(screen.getByText("https://relay.example.com/")).toBeVisible();
    await screen.getByRole("button", { name: "Pair through the relay" }).click();
    expect(onPair).toHaveBeenCalledOnce();
  });

  it("shows the confirmation code to compare while the host decides", async () => {
    await using screen = await render(
      <View phase={{ kind: "awaiting-approval", confirmationCode: "K7QM-2XFD" }} />,
    );
    await expect
      .element(screen.getByTestId("k3relay-confirmation-code"))
      .toHaveTextContent("K7QM-2XFD");
    await expect.element(screen.getByText(/If the codes differ, reject on the host/)).toBeVisible();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Waiting for the host to approve…");
    expect(page.getByRole("button", { name: "Pair through the relay" }).query()).toBeNull();
  });

  it("refuses a link whose host key was swapped, and keeps the pair button off", async () => {
    const swapped = new URL(LINK);
    swapped.searchParams.set("hk", "A".repeat(43));
    await using screen = await render(<View link={swapped.toString()} />);
    await expect.element(screen.getByText(/The pairing link was altered/)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Pair through the relay" }))
      .toBeDisabled();
  });

  it("shows why pairing failed", async () => {
    await using screen = await render(
      <View phase={{ kind: "failed", message: "The host rejected this device." }} />,
    );
    await expect.element(screen.getByText("The host rejected this device.")).toBeVisible();
  });
});
