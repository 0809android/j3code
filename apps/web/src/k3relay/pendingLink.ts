import { Atom } from "effect/reactivity";

/** A `k3relay://` pairing link the OS opened the app with, waiting for the add-environment dialog. */
export const pendingK3RelayLinkAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("k3relay-pending-link"),
);

export const isK3RelayLink = (value: string) => value.trim().toLowerCase().startsWith("k3relay:");
