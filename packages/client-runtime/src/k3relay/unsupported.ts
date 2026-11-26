import type { K3RelayUnsupportedFeature } from "@t3tools/contracts";
import { msg } from "gt-i18n";

import { translatableMessage } from "../errors/translatable.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

/** Whether this connection's traffic goes through a K3 relay (spec §12). */
export const isK3RelayConnection = (prepared: Pick<PreparedConnection, "target">): boolean =>
  prepared.target._tag === "K3RelayConnectionTarget";

/** Why a feature is off through the relay, in the words the screen shows. */
function k3relayUnsupportedMessage(feature: K3RelayUnsupportedFeature) {
  switch (feature) {
    case "device-hub":
      return msg(
        "Devices on the host are not available through the relay. Connect over your network or a VPN to use them.",
      );
    case "preview-tunnel":
      return msg(
        "Opening the host's local ports is not available through the relay. Connect over your network or a VPN to use it.",
      );
    case "preview-stream":
      return msg(
        "The host's browser preview is not available through the relay. Connect over your network or a VPN to use it.",
      );
    case "voice-input":
      return msg(
        "Live voice input is not available through the relay. Connect over your network or a VPN to use it.",
      );
    case "guest-share":
      return msg("Guest links are not available through the relay.");
    case "signed-url":
    case "media-ticket":
      return msg(
        "This is not available through the relay. Connect over your network or a VPN to use it.",
      );
  }
}

/**
 * Refuses, before any request, what the relay never carries: credentials in URLs for `<img>`,
 * EventSource and sockets. The host refuses them too; this says why on the device.
 */
export const k3relayUnsupportedError = (feature: K3RelayUnsupportedFeature) =>
  new RemoteEnvironmentAuthFetchError({
    ...translatableMessage(k3relayUnsupportedMessage(feature)),
    cause: { code: "relay-unsupported", feature },
  });
