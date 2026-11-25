import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { trackKeyboardLayout } from "./keyboardLayout";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { forwardK3RelayAccountCallback } from "./k3relay/accountSignIn";
import { chunkLoadState } from "./lib/chunkReloadGuard";

function startApp(): Promise<void> {
  const stopTrackingKeyboardLayout = trackKeyboardLayout();
  import.meta.hot?.dispose(stopTrackingKeyboardLayout);

  const router = startAppServices();

  const app = <AppRoot router={router} />;

  return (
    router
      .load()
      // Chained so settings have usually hydrated; English resolves without a chunk load.
      .then(whenLocaleReady)
      .then(() => {
        // Route chunk failures resolve router.load() and surface later through the error boundary.
        if (chunkLoadState.reloadScheduled) return;
        ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
          <React.StrictMode>{app}</React.StrictMode>,
        );
      })
      .catch((error: unknown) => {
        if (chunkLoadState.reloadScheduled) return;
        throw error;
      })
  );
}

// A relay account sign-in returns to its own page; that tab only hands the result back.
export const startup = forwardK3RelayAccountCallback(window.location)
  ? Promise.resolve()
  : startApp();
