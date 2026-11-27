import type { EnvironmentId } from "@t3tools/contracts";

/** A saved default whose connection was removed reads as Automatic, as the thread list's filter does. */
export function resolveDefaultThreadEnvironmentId(
  saved: EnvironmentId | null | undefined,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
): EnvironmentId | null {
  return saved != null && isKnownEnvironment(saved) ? saved : null;
}
