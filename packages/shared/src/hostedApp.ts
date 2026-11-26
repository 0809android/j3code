// Dependency-free on purpose: the mobile app config imports this file directly.
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * K3 Code has no hosted web app of its own. A hosted app exists only when a user or operator
 * names one (`K3CODE_HOSTED_APP_URL` on the server, `VITE_HOSTED_APP_URL` for the web build).
 * Everything that links to or returns to a hosted app takes that origin as an argument and does
 * nothing, or stays on this machine, when it is undefined.
 */
export function hostedAppOrigin(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    const secure = url.protocol === "https:";
    const loopbackHttp = url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.has(url.hostname);
    return secure || loopbackHttp ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
