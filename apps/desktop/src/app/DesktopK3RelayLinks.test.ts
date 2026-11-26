import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { registerK3RelayLinks } from "./DesktopK3RelayLinks.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const CALLBACK = "k3relay://account/callback?code=c&state=s";

const makeDesktop = (argv: ReadonlyArray<string> = ["k3code"]) => {
  const received: Array<string> = [];
  let activations = 0;
  const listeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopWebLinks.DesktopWebLinks, {
      receive: (url: string) => Effect.sync(() => void received.push(url)),
      setRendererReady: () => Effect.void,
    }),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      activate: Effect.sync(() => {
        activations += 1;
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
    Layer.succeed(ElectronApp.ElectronApp, {
      on: (name: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
        Effect.sync(() => void listeners.set(name, listener)),
    } as unknown as ElectronApp.ElectronApp["Service"]),
    Layer.succeed(HostProcess.Arguments, argv),
  );
  return { received, activations: () => activations, listeners, layer };
};

describe("k3relay:// links on the desktop", () => {
  it.effect("takes the link a second launch passes over (Windows and Linux)", () => {
    const desktop = makeDesktop();
    return Effect.gen(function* () {
      yield* registerK3RelayLinks;
      desktop.listeners.get("second-instance")?.({}, ["k3code.exe", "--flag", CALLBACK]);
      yield* Effect.yieldNow;
      assert.deepEqual(desktop.received, [CALLBACK]);
      assert.equal(desktop.activations(), 0);
    }).pipe(Effect.scoped, Effect.provide(desktop.layer));
  });

  it.effect("brings the running app forward when a second launch carries no link", () => {
    const desktop = makeDesktop();
    return Effect.gen(function* () {
      yield* registerK3RelayLinks;
      desktop.listeners.get("second-instance")?.({}, ["k3code.exe"]);
      yield* Effect.yieldNow;
      assert.deepEqual(desktop.received, []);
      assert.equal(desktop.activations(), 1);
    }).pipe(Effect.scoped, Effect.provide(desktop.layer));
  });

  it.effect("takes macOS open-url and the link that launched the app", () => {
    const desktop = makeDesktop(["k3code", CALLBACK]);
    return Effect.gen(function* () {
      yield* registerK3RelayLinks;
      let prevented = false;
      desktop.listeners.get("open-url")?.(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        "k3relay://pair?v=2#s=x",
      );
      yield* Effect.yieldNow;
      assert.isTrue(prevented);
      assert.deepEqual(desktop.received, [CALLBACK, "k3relay://pair?v=2#s=x"]);
    }).pipe(Effect.scoped, Effect.provide(desktop.layer));
  });
});
