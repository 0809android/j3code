import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * K3 Code has no hosted web app of its own. A deployment that hosts one names its router host and
 * the two channel origins (K3CODE_HOSTED_APP_HOST, K3CODE_HOSTED_APP_LATEST_ORIGIN,
 * K3CODE_HOSTED_APP_NIGHTLY_ORIGIN); without all three, nothing is routed by host.
 */
function channelRouter(env: Environment) {
  const host = env.K3CODE_HOSTED_APP_HOST?.trim();
  const latestOrigin = env.K3CODE_HOSTED_APP_LATEST_ORIGIN?.trim();
  const nightlyOrigin = env.K3CODE_HOSTED_APP_NIGHTLY_ORIGIN?.trim();
  if (!host || !latestOrigin || !nightlyOrigin) return [];
  return [
    {
      src: "/(.*)",
      has: [matchers.host(host), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${nightlyOrigin}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(host)],
      dest: `${latestOrigin}/$1`,
    },
  ];
}

export function makeConfig(env: Environment = process.env): VercelConfig {
  return {
    buildCommand:
      'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
    git: {
      deploymentEnabled: false,
    },
    installCommand:
      "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
    routes: [
      {
        src: "/__t3code/channel",
        has: [matchers.query("channel", "nightly")],
        transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
        headers: {
          Location: "/",
          "Set-Cookie": channelCookie("nightly"),
        },
        status: 302,
      },
      {
        src: "/__t3code/channel",
        transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
        headers: {
          Location: "/",
          "Set-Cookie": channelCookie("latest"),
        },
        status: 302,
      },
      ...channelRouter(env),
    ],
    rewrites: [
      // Apple fetches it without an extension; the .json file is served as application/json.
      routes.rewrite(
        "/.well-known/apple-app-site-association",
        "/.well-known/apple-app-site-association.json",
      ),
      routes.rewrite("/(.*)", "/index.html"),
    ],
  };
}

export const config: VercelConfig = makeConfig();
