import { hostedAppOrigin } from "./hostedApp.ts";
import { isLoopbackHost } from "./preview.ts";

/**
 * Where a provider sign-in may send the browser back to: the desktop app, this machine, or the
 * hosted app named by `hostedAppUrl`. With no hosted app configured, only the first two qualify.
 */
export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppUrl?: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostedOrigin = hostedAppOrigin(hostedAppUrl);
    const desktop = ["k3code:", "k3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || (hostedOrigin !== undefined && url.origin === hostedOrigin));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
