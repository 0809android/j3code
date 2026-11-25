import { describe, expect, it } from "@effect/vitest";

import { K3RelayAccountClientError } from "./account.ts";
import {
  type K3RelayAccountScreenEvent,
  type K3RelayAccountScreenState,
  initialK3RelayAccountScreen,
  isK3RelayAccountCallback,
  k3relayAccountCallbackMatches,
  k3relayAccountScreenError,
  k3relayAccountScreenErrorText,
  k3relayAccountSignInChoices,
  k3relayAccountWebRedirect,
  reduceK3RelayAccountScreen,
} from "./accountScreen.ts";
import { K3RelayPairingError } from "./pairing.ts";

interface Pending {
  readonly keyId: string;
  readonly appState: string;
}
interface Session {
  readonly keyId: string;
}
interface Host {
  readonly hostId: string;
}
type State = K3RelayAccountScreenState<Pending, Session, Host>;
type Event = K3RelayAccountScreenEvent<Pending, Session, Host>;

const RELAY = "wss://relay.example";
const run = (state: State, ...events: ReadonlyArray<Event>): State =>
  events.reduce<State>(reduceK3RelayAccountScreen, state);
const start = (): State => initialK3RelayAccountScreen<Pending, Session, Host>(RELAY);
const pending: Pending = { keyId: "k3relay-account:a", appState: "s1" };
const session: Session = { keyId: "k3relay-account:a" };

const signedIn = (): State =>
  run(
    start(),
    { type: "offer-loading" },
    { type: "offer-loaded", providers: ["github", "google"] },
    { type: "sign-in-requested", provider: "github" },
    { type: "sign-in-opened", pending },
    { type: "signed-in", session },
  );

describe("which sign-ins the device screen offers", () => {
  it("shows only what the relay turned on, in a fixed order", () => {
    expect(k3relayAccountSignInChoices(["google", "github"], "web")).toEqual({
      providers: ["github", "google"],
      appleRequired: false,
    });
    expect(k3relayAccountSignInChoices(["apple", "google"], "android")).toEqual({
      providers: ["google", "apple"],
      appleRequired: false,
    });
    expect(k3relayAccountSignInChoices([], "web")).toEqual({
      providers: [],
      appleRequired: false,
    });
  });

  it("puts Sign in with Apple beside GitHub and Google on iOS", () => {
    expect(k3relayAccountSignInChoices(["github", "google", "apple"], "ios")).toEqual({
      providers: ["apple", "github", "google"],
      appleRequired: false,
    });
    expect(k3relayAccountSignInChoices(["apple"], "ios")).toEqual({
      providers: ["apple"],
      appleRequired: false,
    });
  });

  it("offers no other sign-in on iOS when the relay has not turned Apple on", () => {
    expect(k3relayAccountSignInChoices(["github", "google"], "ios")).toEqual({
      providers: [],
      appleRequired: true,
    });
  });
});

describe("the device sign-in screen", () => {
  it("loads the relay's offer, then signs in and lists the hosts", () => {
    let state = run(start(), { type: "offer-loading" });
    expect(state).toMatchObject({ kind: "signed-out", offer: { status: "loading" } });
    state = run(state, { type: "offer-loaded", providers: ["github"] });
    expect(state).toMatchObject({ offer: { status: "ready", providers: ["github"] } });
    state = run(state, { type: "sign-in-requested", provider: "github" });
    expect(state).toMatchObject({ signIn: { step: "starting", provider: "github" } });
    state = run(state, { type: "sign-in-opened", pending });
    expect(state).toMatchObject({ signIn: { step: "waiting", provider: "github", pending } });
    state = run(state, { type: "signed-in", session });
    expect(state).toEqual({
      kind: "signed-in",
      relayUrl: RELAY,
      provider: "github",
      session,
      hosts: { status: "loading" },
      connecting: null,
      error: null,
    });
    state = run(state, { type: "hosts-loaded", hosts: [{ hostId: "h1" }] });
    expect(state).toMatchObject({ hosts: { status: "ready", hosts: [{ hostId: "h1" }] } });
  });

  it("changes the relay only while signed out and idle, and forgets the old offer", () => {
    const loaded = run(start(), { type: "offer-loaded", providers: ["github"] });
    const moved = run(loaded, { type: "relay-url-changed", relayUrl: "wss://own.example" });
    expect(moved).toMatchObject({ relayUrl: "wss://own.example", offer: { status: "idle" } });
    const busy = run(loaded, { type: "sign-in-requested", provider: "github" });
    expect(run(busy, { type: "relay-url-changed", relayUrl: "wss://x.example" })).toBe(busy);
    expect(run(signedIn(), { type: "relay-url-changed", relayUrl: "wss://x.example" })).toEqual(
      signedIn(),
    );
  });

  it("keeps the reason when the relay offers no sign-in", () => {
    const error = { kind: "account", reason: "accounts-unavailable" } as const;
    expect(run(start(), { type: "offer-failed", error })).toMatchObject({
      offer: { status: "failed", error },
    });
  });

  it("ends a sign-in that failed or was cancelled, and starts no second one meanwhile", () => {
    const loaded = run(start(), { type: "offer-loaded", providers: ["github", "google"] });
    const starting = run(loaded, { type: "sign-in-requested", provider: "github" });
    expect(run(starting, { type: "sign-in-requested", provider: "google" })).toBe(starting);
    const error = { kind: "account", reason: "sign-in-failed" } as const;
    expect(run(starting, { type: "sign-in-failed", error })).toMatchObject({
      signIn: null,
      error,
    });
    const waiting = run(starting, { type: "sign-in-opened", pending });
    expect(run(waiting, { type: "sign-in-cancelled" })).toMatchObject({
      signIn: null,
      error: null,
    });
    // A session only lands for a sign-in that is waiting for the browser.
    expect(run(loaded, { type: "signed-in", session })).toBe(loaded);
    expect(run(loaded, { type: "sign-in-opened", pending })).toBe(loaded);
  });

  it("connects to a host through its approval, one host at a time", () => {
    let state = run(signedIn(), { type: "hosts-loaded", hosts: [{ hostId: "h1" }] });
    state = run(state, { type: "connect-requested", hostId: "h1" });
    expect(state).toMatchObject({ connecting: { hostId: "h1", step: "connecting" } });
    expect(run(state, { type: "connect-requested", hostId: "h2" })).toBe(state);
    state = run(state, {
      type: "connect-progress",
      progress: { phase: "awaiting-approval", confirmationCode: "K7QM-2XFD" },
    });
    expect(state).toMatchObject({
      connecting: { hostId: "h1", step: "awaiting-approval", confirmationCode: "K7QM-2XFD" },
    });
    state = run(state, { type: "connect-progress", progress: { phase: "redeeming" } });
    expect(state).toMatchObject({ connecting: { hostId: "h1", step: "redeeming" } });
    state = run(state, { type: "connect-ended", error: null });
    expect(state).toMatchObject({ kind: "signed-in", connecting: null, error: null });
  });

  it("shows why a host did not let the device in, and stays signed in", () => {
    const error = { kind: "account", reason: "rejected" } as const;
    const state = run(
      signedIn(),
      { type: "connect-requested", hostId: "h1" },
      { type: "connect-ended", error },
    );
    expect(state).toMatchObject({ kind: "signed-in", connecting: null, error });
    // Starting again clears it.
    expect(run(state, { type: "connect-requested", hostId: "h1" })).toMatchObject({ error: null });
  });

  it("returns to signed out, with the reason, when the session expired", () => {
    const expired = { kind: "account", reason: "session-expired" } as const;
    for (const event of [
      { type: "hosts-failed", error: expired },
      { type: "connect-ended", error: expired },
    ] as const) {
      expect(run(signedIn(), { type: "connect-requested", hostId: "h1" }, event)).toEqual({
        kind: "signed-out",
        relayUrl: RELAY,
        offer: { status: "idle" },
        signIn: null,
        error: expired,
      });
    }
  });

  it("keeps the session when the host list fails for another reason", () => {
    const error = { kind: "account", reason: "relay-unreachable" } as const;
    expect(run(signedIn(), { type: "hosts-failed", error })).toMatchObject({
      kind: "signed-in",
      hosts: { status: "failed", error },
    });
    expect(
      run(signedIn(), { type: "hosts-failed", error }, { type: "hosts-requested" }),
    ).toMatchObject({ hosts: { status: "loading" } });
  });

  it("signs out to the same relay, ready to load its offer again", () => {
    expect(run(signedIn(), { type: "signed-out" })).toEqual(start());
    expect(run(start(), { type: "signed-out" })).toEqual(start());
  });
});

describe("the sign-in's way back", () => {
  it("recognizes the app link and the web page that carry the code", () => {
    expect(isK3RelayAccountCallback("k3relay://account/callback?code=c&state=s")).toBe(true);
    expect(isK3RelayAccountCallback("K3RELAY://account/callback?error=access_denied")).toBe(true);
    expect(isK3RelayAccountCallback("http://localhost:3773/k3relay/account/callback?code=c")).toBe(
      true,
    );
    expect(isK3RelayAccountCallback("https://app.example/k3relay/account/callback?code=c")).toBe(
      true,
    );
    expect(isK3RelayAccountCallback("k3relay://pair?v=2#s=secret")).toBe(false);
    expect(isK3RelayAccountCallback("k3relay://account/elsewhere")).toBe(false);
    expect(isK3RelayAccountCallback("not a url")).toBe(false);
  });

  it("matches a callback to its own sign-in only", () => {
    expect(
      k3relayAccountCallbackMatches(pending, "k3relay://account/callback?code=c&state=s1"),
    ).toBe(true);
    expect(
      k3relayAccountCallbackMatches(pending, "k3relay://account/callback?code=c&state=s2"),
    ).toBe(false);
    expect(k3relayAccountCallbackMatches(pending, "k3relay://account/callback?code=c")).toBe(false);
  });

  it("returns a web page only to an address the relay can allow", () => {
    expect(k3relayAccountWebRedirect("https://app.example")).toBe(
      "https://app.example/k3relay/account/callback",
    );
    expect(k3relayAccountWebRedirect("http://localhost:3773")).toBe(
      "http://localhost:3773/k3relay/account/callback",
    );
    expect(k3relayAccountWebRedirect("http://127.0.0.1:5733")).toBe(
      "http://127.0.0.1:5733/k3relay/account/callback",
    );
    expect(k3relayAccountWebRedirect("http://[::1]:5733")).toBe(
      "http://[::1]:5733/k3relay/account/callback",
    );
    // Plain HTTP elsewhere, a loopback without a port, and app origins have no allowed return.
    expect(k3relayAccountWebRedirect("http://100.64.0.1:3773")).toBeNull();
    expect(k3relayAccountWebRedirect("http://localhost")).toBeNull();
    expect(k3relayAccountWebRedirect("k3code://app")).toBeNull();
    expect(k3relayAccountWebRedirect("null")).toBeNull();
  });
});

describe("what the screen says when something did not finish", () => {
  it("names the reason from either kind of failure", () => {
    expect(
      k3relayAccountScreenError(
        new K3RelayAccountClientError({ reason: "host-offline", detail: "x" }),
      ),
    ).toEqual({ kind: "account", reason: "host-offline" });
    expect(
      k3relayAccountScreenError(new K3RelayPairingError({ reason: "redeem-failed", detail: "x" })),
    ).toEqual({ kind: "pairing", reason: "redeem-failed" });
    expect(k3relayAccountScreenError(new Error("boom"))).toBeNull();
  });

  it("uses the sentences the account and pairing flows already have", () => {
    expect(k3relayAccountScreenErrorText({ kind: "account", reason: "rejected" })).toBe(
      "The host did not let this device in.",
    );
    expect(k3relayAccountScreenErrorText({ kind: "pairing", reason: "redeem-failed" })).toBe(
      "The host approved this device, but signing in failed. Pair again.",
    );
    expect(k3relayAccountScreenErrorText({ kind: "message", message: "Disk full." })).toBe(
      "Disk full.",
    );
  });
});
