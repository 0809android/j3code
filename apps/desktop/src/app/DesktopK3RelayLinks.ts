import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

/** Pairing links a host shares (spec §8): `k3relay://pair?…#s=…`. */
export const K3RELAY_LINK_SCHEME = "k3relay";

export const isK3RelayLink = (value: string) =>
  value.trim().toLowerCase().startsWith(`${K3RELAY_LINK_SCHEME}:`);

/**
 * Hands `k3relay://` links (pairing links and account sign-in callbacks) to the renderer the way
 * web links go: macOS sends them as `open-url` (registered before `ready` so a link that launches
 * the app is not lost). Windows and Linux put the link in the arguments of the process it
 * launches: this one at startup, or a second one that passes them over as `second-instance`.
 */
export const registerK3RelayLinks = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const deliver = (url: string) => {
    runFork(webLinks.receive(url.trim()));
  };
  yield* electronApp.on("open-url", (event: { preventDefault(): void }, url: string) => {
    if (!isK3RelayLink(url)) return;
    event.preventDefault();
    deliver(url);
  });
  yield* electronApp.on("second-instance", (_event: unknown, argv: ReadonlyArray<string>) => {
    const links = (Array.isArray(argv) ? argv : []).filter(isK3RelayLink);
    if (links.length > 0) {
      for (const link of links) deliver(link);
      return;
    }
    // Opening the app again brings the running one forward.
    runFork(desktopWindow.activate.pipe(Effect.ignore));
  });
  for (const argument of yield* HostProcess.Arguments) {
    if (isK3RelayLink(argument)) deliver(argument);
  }
}).pipe(
  // Pairing links are a convenience: the app must start even if they cannot be wired.
  Effect.catchCause((cause) => Effect.logWarning("Could not listen for K3 Relay links.", cause)),
);
