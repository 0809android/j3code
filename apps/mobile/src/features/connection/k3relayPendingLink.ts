import { Atom } from "effect/reactivity";

/** A `k3relay://` pairing link the OS opened the app with, until the add screen takes it. */
export const pendingK3RelayLinkAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("k3relay-pending-link"),
  Atom.keepAlive,
);
