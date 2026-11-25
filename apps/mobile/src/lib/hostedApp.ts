import { hostedAppOrigin } from "@t3tools/shared/hostedApp";
import Constants from "expo-constants";

/**
 * The hosted web app this build was configured with (`K3CODE_HOSTED_APP_URL` at config time), or
 * undefined. K3 Code has no hosted app of its own, so a build without one never links to one:
 * copied links are `t3-thread://` and `k3code://` links and no web address opens the app.
 */
export function resolveHostedAppUrl(extra: unknown): string | undefined {
  const value =
    typeof extra === "object" && extra !== null && "hostedAppUrl" in extra
      ? (extra as { readonly hostedAppUrl?: unknown }).hostedAppUrl
      : undefined;
  return typeof value === "string" ? hostedAppOrigin(value) : undefined;
}

export function configuredHostedAppUrl(): string | undefined {
  return resolveHostedAppUrl(Constants.expoConfig?.extra);
}

/** Universal-link prefixes for the configured hosted app: none without one. */
export function hostedAppLinkPrefixes(hostedAppUrl: string | undefined): readonly string[] {
  return hostedAppUrl === undefined ? [] : [hostedAppUrl];
}
