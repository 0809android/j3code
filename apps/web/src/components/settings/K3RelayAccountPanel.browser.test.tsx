import type { K3RelayAccountHost, K3RelayAccountSession } from "@t3tools/client-runtime/k3relay";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { WebK3RelayAccountScreen, WebK3RelayAccountSignIn } from "~/k3relay/accountSignIn";
import { render } from "../../../test/render";
import { type K3RelayAccountPanelActions, K3RelayAccountView } from "./K3RelayAccountPanel";

const RELAY = "wss://relay.example.com";
const session = { keyId: "k3relay-account:test" } as unknown as K3RelayAccountSession;
const signIn = {
  pending: { keyId: "k3relay-account:test", appState: "s" },
  authorizeUrl: "https://relay.example.com/authorize",
} as unknown as WebK3RelayAccountSignIn;
const host = (hostId: string) =>
  ({ hostId, hostIdentityKey: new Uint8Array(32) }) as K3RelayAccountHost;

const signedOut = (
  overrides: Partial<Extract<WebK3RelayAccountScreen, { kind: "signed-out" }>> = {},
): WebK3RelayAccountScreen => ({
  kind: "signed-out",
  relayUrl: RELAY,
  offer: { status: "ready", providers: ["google", "github"] },
  signIn: null,
  error: null,
  ...overrides,
});

const signedIn = (
  overrides: Partial<Extract<WebK3RelayAccountScreen, { kind: "signed-in" }>> = {},
): WebK3RelayAccountScreen => ({
  kind: "signed-in",
  relayUrl: RELAY,
  provider: "github",
  session,
  hosts: { status: "ready", hosts: [host("aaaaaaaaaaaaaaaa"), host("bbbbbbbbbbbbbbbb")] },
  connecting: null,
  error: null,
  ...overrides,
});

const noActions = (): K3RelayAccountPanelActions => ({
  changeRelayUrl: vi.fn(),
  retryOffer: vi.fn(),
  signIn: vi.fn(),
  cancelSignIn: vi.fn(),
  signOut: vi.fn(),
  refreshHosts: vi.fn(),
  connect: vi.fn(),
});

function View({
  state,
  actions = noActions(),
  canReturn = true,
  savedHostIds = new Set<string>(),
}: {
  readonly state: WebK3RelayAccountScreen;
  readonly actions?: K3RelayAccountPanelActions;
  readonly canReturn?: boolean;
  readonly savedHostIds?: ReadonlySet<string>;
}) {
  return (
    <K3RelayAccountView
      state={state}
      canReturn={canReturn}
      deviceName="Kino's laptop"
      savedHostIds={savedHostIds}
      onDeviceNameChange={() => {}}
      actions={actions}
    />
  );
}

describe("K3RelayAccountView", () => {
  it("says what an account grants before signing in, and offers only the relay's sign-ins", async () => {
    const actions = noActions();
    await using screen = await render(<View state={signedOut()} actions={actions} />);
    await expect.element(screen.getByText(/only lets this device into the relay/)).toBeVisible();
    await expect
      .element(screen.getByText(/does not store your email address or name/))
      .toBeVisible();
    await expect.element(screen.getByText(RELAY)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    expect(page.getByRole("button", { name: "Sign in with Apple" }).query()).toBeNull();
    await screen.getByRole("button", { name: "Sign in with Google" }).click();
    expect(actions.signIn).toHaveBeenCalledWith("google");
  });

  it("lets the relay be changed while signed out", async () => {
    const actions = noActions();
    await using screen = await render(<View state={signedOut()} actions={actions} />);
    await screen.getByRole("button", { name: "Change" }).click();
    const field = screen.getByRole("textbox", { name: "Relay server address" });
    await field.fill("wss://own-relay.example");
    await screen.getByRole("button", { name: "Save" }).click();
    expect(actions.changeRelayUrl).toHaveBeenCalledWith("wss://own-relay.example");
  });

  it("waits for the browser with a way to reopen the page or cancel", async () => {
    const actions = noActions();
    await using screen = await render(
      <View
        state={signedOut({ signIn: { step: "waiting", provider: "github", pending: signIn } })}
        actions={actions}
      />,
    );
    await expect.element(screen.getByText(/Finish signing in with GitHub/)).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open the sign-in page again" }))
      .toHaveAttribute("href", "https://relay.example.com/authorize");
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(actions.cancelSignIn).toHaveBeenCalledOnce();
  });

  it("explains when this address cannot receive the sign-in", async () => {
    await using screen = await render(<View state={signedOut()} canReturn={false} />);
    await expect
      .element(screen.getByText(/Signing in from this address is not possible/))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Sign in with GitHub" }).query()).toBeNull();
  });

  it("shows why the relay offers no sign-in, with a retry", async () => {
    const actions = noActions();
    await using screen = await render(
      <View
        state={signedOut({
          offer: { status: "failed", error: { kind: "account", reason: "accounts-unavailable" } },
        })}
        actions={actions}
      />,
    );
    await expect.element(screen.getByText(/This relay does not offer sign-in/)).toBeVisible();
    await screen.getByRole("button", { name: "Try again" }).click();
    expect(actions.retryOffer).toHaveBeenCalledOnce();
  });

  it("lists the account's hosts, marks one already added, and connects to another", async () => {
    const actions = noActions();
    await using screen = await render(
      <View state={signedIn()} actions={actions} savedHostIds={new Set(["aaaaaaaaaaaaaaaa"])} />,
    );
    await expect.element(screen.getByText("Signed in with GitHub")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Added" })).toBeDisabled();
    await screen.getByRole("button", { name: "Connect" }).click();
    expect(actions.connect).toHaveBeenCalledWith(host("bbbbbbbbbbbbbbbb"));
  });

  it("shows the confirmation code to compare while the host decides", async () => {
    await using screen = await render(
      <View
        state={signedIn({
          connecting: {
            hostId: "bbbbbbbbbbbbbbbb",
            step: "awaiting-approval",
            confirmationCode: "K7QM-2XFD",
          },
        })}
      />,
    );
    await expect
      .element(screen.getByTestId("k3relay-account-confirmation-code"))
      .toHaveTextContent("K7QM-2XFD");
    await expect.element(screen.getByText(/If the codes differ, reject on the host/)).toBeVisible();
  });

  it("signs out, and says why a host did not let the device in", async () => {
    const actions = noActions();
    await using screen = await render(
      <View
        state={signedIn({ error: { kind: "account", reason: "rejected" } })}
        actions={actions}
      />,
    );
    await expect.element(screen.getByText("The host did not let this device in.")).toBeVisible();
    await screen.getByRole("button", { name: "Sign out" }).click();
    expect(actions.signOut).toHaveBeenCalledOnce();
  });

  it("says how to put a host on the account when there is none", async () => {
    await using screen = await render(
      <View state={signedIn({ hosts: { status: "ready", hosts: [] } })} />,
    );
    await expect.element(screen.getByText(/No hosts on this account yet/)).toBeVisible();
  });
});
