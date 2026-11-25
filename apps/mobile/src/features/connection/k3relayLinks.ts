import * as Linking from "expo-linking";
import type { AtomRegistry } from "effect/reactivity";

import { isK3RelayLink } from "./K3RelayPairingCard";
import { pendingK3RelayLinkAtom } from "./k3relayPendingLink";

/**
 * `k3relay://pair?…#s=…` links stay out of React Navigation (the secret is in the fragment
 * and no screen should parse it); they open Add environment on the relay card instead.
 */
export function installK3RelayLinks(
  registry: AtomRegistry.AtomRegistry,
  openAddEnvironment: (href: string) => void,
): () => void {
  let active = true;
  const receive = (url: string | null) => {
    if (!active || url === null || !isK3RelayLink(url)) return;
    registry.set(pendingK3RelayLinkAtom, url.trim());
    openAddEnvironment("/connections/new");
  };
  void Linking.getInitialURL()
    .then(receive)
    .catch(() => undefined);
  const subscription = Linking.addEventListener("url", ({ url }) => receive(url));
  return () => {
    active = false;
    subscription.remove();
  };
}
