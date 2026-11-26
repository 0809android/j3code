import type { ReactNode } from "react";

export type T3ConnectAccountPageUrl = "mobile-clients" | "t3-connect" | "t3-chat";

// oxlint-disable-next-line t3code/no-hookless-use-function -- Clerk was removed; this stub keeps the hook-shaped API for its callers.
export function useT3ConnectAccountPage(): {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  return { open: null, portals: null };
}
