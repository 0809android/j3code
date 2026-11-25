const MIB = 1024 * 1024;

export type AccountProviderKind = "github" | "google" | "apple";

/**
 * One OAuth / OIDC provider the relay signs people in with (spec section 20.2). The relay is the
 * confidential client: the secret never leaves it. A provider is on only when all of its settings
 * are present; the endpoints default to the real provider and are overridden only by tests.
 */
export interface AccountProviderConfig {
  readonly kind: AccountProviderKind;
  readonly clientId: string;
  /** GitHub and Google. Apple signs a short client-secret JWT with `appleKey` instead. */
  readonly clientSecret: string | null;
  readonly appleKey: {
    readonly teamId: string;
    readonly keyId: string;
    readonly privateKeyPem: string;
  } | null;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** OIDC only (Google, Apple): the accepted `iss` values and the key set. */
  readonly issuers: ReadonlyArray<string>;
  readonly jwksUrl: string | null;
  /** GitHub only: the REST API base, for checking and revoking the token. */
  readonly apiUrl: string | null;
}

export interface RelayConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  /** Read the client address from the last `X-Forwarded-For` entry (set by the proxy in front). */
  readonly trustProxy: boolean;
  readonly requireInvite: boolean;
  readonly blockedHosts: ReadonlyArray<string>;
  readonly powSecret: string | null;
  readonly gitCommit: string;
  readonly imageDigest: string;

  readonly preAuthMaxPayload: number;
  readonly postAuthMaxPayload: number;
  readonly controlMaxPayload: number;
  readonly maxFragments: number;
  readonly authTimeoutMs: number;
  readonly sessionSetupMs: number;
  readonly dataTokenTtlMs: number;
  readonly pingIntervalMs: number;

  readonly maxControlConnections: number;
  readonly maxSessions: number;
  readonly maxSessionsPerHost: number;
  readonly maxSessionsPerDevice: number;
  readonly controlMessagesPerMinute: number;
  readonly maxGrantsPerHost: number;
  readonly maxHosts: number;

  readonly preAuthMaxConcurrentPerIp: number;
  readonly preAuthPerMinutePerIp: number;
  readonly registrationsPerIpPerDay: number;
  readonly statusPerMinutePerDevice: number;
  readonly statusMaxSkewMs: number;

  readonly powBaseDifficulty: number;
  readonly powLoadExtraDifficulty: number;
  readonly powLoadThresholdPerMinute: number;
  readonly powTtlMs: number;

  readonly pairingMaxConcurrent: number;
  readonly pairingAttemptsPerHour: number;
  readonly pairingWindowMaxMs: number;
  readonly pairingSessionMaxMs: number;

  readonly backpressureHighWaterBytes: number;
  readonly backpressureCloseMs: number;
  readonly bufferBudgetBytes: number;
  readonly budgetPauseFloorBytes: number;
  readonly globalBandwidthBytesPerSec: number;
  readonly globalBurstBytes: number;
  readonly fairQuantumBytes: number;
  readonly monthlyQuotaBytes: number;
  readonly newHostAgeDays: number;
  readonly newHostWeight: number;
  readonly overQuotaWeight: number;

  /** Monthly egress the free tier allows (spec section 9). Relayed bytes are counted against it. */
  readonly egressBudgetBytes: number;
  /** Fraction of the budget that raises the first alarm and squeezes low-priority hosts. */
  readonly egressWarnFraction: number;
  /** Fraction of the budget that starts degraded operation. */
  readonly egressDegradedFraction: number;
  /** Per-host ceiling for a host over its monthly quota while the relay is degraded. */
  readonly degradedHostBytesPerSec: number;
  /** Multiplier on the weight of hosts that already have a reduced weight, from the first alarm on. */
  readonly pressureWeightFactor: number;
  readonly trafficCheckMs: number;
  /** How often the blocklist in the database is re-read, so `cli block` reaches a running relay. */
  readonly blockedPollMs: number;
  /** Optional. Receives a subject and numbers when the egress alarms fire. Never ids or addresses. */
  readonly alertWebhookUrl: string | null;
  /** Optional. A light request to the relay's own public URL, for the idle-reclaim risk. */
  readonly selfPingUrl: string | null;
  /** 0 turns the self-ping off. */
  readonly selfPingIntervalMs: number;

  readonly hostIdleRetentionDays: number;
  readonly grantRetentionAfterExpiryDays: number;
  readonly revocationRetentionDays: number;
  readonly inviteRetentionAfterUseDays: number;
  readonly inviteTtlDays: number;

  /** Accounts (spec section 20). Off unless at least one provider is fully configured. */
  readonly publicUrl: string | null;
  /** Ed25519 seed (base64url, 32 bytes) for account tokens. Separate from every K3 key. */
  readonly accountTokenSeed: string | null;
  /** HMAC key for provider identifiers. Lives in the environment, never in the database. */
  readonly accountHmacKey: string | null;
  readonly accountProviders: ReadonlyArray<AccountProviderConfig>;
  /** Exact return addresses for the browser client, besides `k3relay://` and loopback. */
  readonly accountWebRedirects: ReadonlyArray<string>;
  readonly maxHostsPerAccount: number;
  readonly accountStartsPerMinutePerIp: number;
  readonly accountsPerIpPerDay: number;
  readonly maxPendingAccountFlows: number;
  readonly accountFlowTtlMs: number;
  readonly accountCodeTtlMs: number;
  readonly accountTokenTtlMs: number;
  readonly accountHostTokenTtlMs: number;
  readonly accountAdmissionsPerHostPerHour: number;
  readonly accountMaxConcurrentPerHost: number;
  readonly accountSessionMaxMs: number;
}

export const DEFAULT_CONFIG: RelayConfig = {
  host: "0.0.0.0",
  port: 8080,
  dbPath: "/data/relay.sqlite",
  trustProxy: false,
  requireInvite: false,
  blockedHosts: [],
  powSecret: null,
  gitCommit: "unknown",
  imageDigest: "unknown",

  preAuthMaxPayload: 4 * 1024,
  postAuthMaxPayload: MIB,
  controlMaxPayload: 64 * 1024,
  maxFragments: 64,
  authTimeoutMs: 5_000,
  sessionSetupMs: 10_000,
  dataTokenTtlMs: 10_000,
  pingIntervalMs: 25_000,

  maxControlConnections: 3_000,
  maxSessions: 300,
  maxSessionsPerHost: 16,
  maxSessionsPerDevice: 8,
  controlMessagesPerMinute: 120,
  maxGrantsPerHost: 256,
  maxHosts: 200_000,

  preAuthMaxConcurrentPerIp: 30,
  preAuthPerMinutePerIp: 120,
  registrationsPerIpPerDay: 20,
  statusPerMinutePerDevice: 12,
  statusMaxSkewMs: 60_000,

  powBaseDifficulty: 18,
  powLoadExtraDifficulty: 4,
  powLoadThresholdPerMinute: 30,
  powTtlMs: 5 * 60_000,

  pairingMaxConcurrent: 1,
  pairingAttemptsPerHour: 10,
  pairingWindowMaxMs: 10 * 60_000,
  pairingSessionMaxMs: 5 * 60_000,

  backpressureHighWaterBytes: MIB,
  backpressureCloseMs: 10_000,
  bufferBudgetBytes: 200 * MIB,
  budgetPauseFloorBytes: 64 * 1024,
  globalBandwidthBytesPerSec: (45 * 1_000_000) / 8,
  globalBurstBytes: 256 * 1024,
  fairQuantumBytes: 32 * 1024,
  monthlyQuotaBytes: 200 * 1_000_000_000,
  newHostAgeDays: 7,
  newHostWeight: 0.5,
  overQuotaWeight: 0.25,

  egressBudgetBytes: 10 * 1_000_000_000_000,
  egressWarnFraction: 0.7,
  egressDegradedFraction: 0.9,
  degradedHostBytesPerSec: 1_000_000 / 8,
  pressureWeightFactor: 0.5,
  trafficCheckMs: 5_000,
  blockedPollMs: 5_000,
  alertWebhookUrl: null,
  selfPingUrl: null,
  selfPingIntervalMs: 0,

  hostIdleRetentionDays: 365,
  grantRetentionAfterExpiryDays: 30,
  revocationRetentionDays: 30,
  inviteRetentionAfterUseDays: 30,
  inviteTtlDays: 30,

  publicUrl: null,
  accountTokenSeed: null,
  accountHmacKey: null,
  accountProviders: [],
  accountWebRedirects: [],
  maxHostsPerAccount: 20,
  accountStartsPerMinutePerIp: 10,
  accountsPerIpPerDay: 20,
  maxPendingAccountFlows: 2_000,
  accountFlowTtlMs: 10 * 60_000,
  accountCodeTtlMs: 60_000,
  accountTokenTtlMs: 60 * 60_000,
  accountHostTokenTtlMs: 5 * 60_000,
  accountAdmissionsPerHostPerHour: 20,
  accountMaxConcurrentPerHost: 2,
  // The device waits on this session while the host's user compares codes (10 minutes).
  accountSessionMaxMs: 11 * 60_000,
};

type NumericKey = {
  [K in keyof RelayConfig]: RelayConfig[K] extends number ? K : never;
}[keyof RelayConfig];

const NUMERIC_ENV: ReadonlyArray<readonly [NumericKey, string]> = [
  ["port", "PORT"],
  ["preAuthMaxPayload", "PREAUTH_MAX_PAYLOAD"],
  ["postAuthMaxPayload", "POSTAUTH_MAX_PAYLOAD"],
  ["controlMaxPayload", "CONTROL_MAX_PAYLOAD"],
  ["authTimeoutMs", "AUTH_TIMEOUT_MS"],
  ["sessionSetupMs", "SESSION_SETUP_MS"],
  ["dataTokenTtlMs", "DATA_TOKEN_TTL_MS"],
  ["pingIntervalMs", "PING_INTERVAL_MS"],
  ["maxControlConnections", "MAX_CONTROL_CONNECTIONS"],
  ["maxSessions", "MAX_SESSIONS"],
  ["maxSessionsPerHost", "MAX_SESSIONS_PER_HOST"],
  ["maxSessionsPerDevice", "MAX_SESSIONS_PER_DEVICE"],
  ["maxGrantsPerHost", "MAX_GRANTS_PER_HOST"],
  ["maxHosts", "MAX_HOSTS"],
  ["preAuthMaxConcurrentPerIp", "PREAUTH_MAX_CONCURRENT_PER_IP"],
  ["preAuthPerMinutePerIp", "PREAUTH_PER_MINUTE_PER_IP"],
  ["registrationsPerIpPerDay", "REGISTRATIONS_PER_IP_PER_DAY"],
  ["statusPerMinutePerDevice", "STATUS_PER_MINUTE_PER_DEVICE"],
  ["powBaseDifficulty", "POW_BASE_DIFFICULTY"],
  ["powLoadExtraDifficulty", "POW_LOAD_EXTRA_DIFFICULTY"],
  ["powLoadThresholdPerMinute", "POW_LOAD_THRESHOLD_PER_MINUTE"],
  ["pairingAttemptsPerHour", "PAIRING_ATTEMPTS_PER_HOUR"],
  ["backpressureHighWaterBytes", "BACKPRESSURE_HIGH_WATER_BYTES"],
  ["backpressureCloseMs", "BACKPRESSURE_CLOSE_MS"],
  ["bufferBudgetBytes", "BUFFER_BUDGET_BYTES"],
  ["budgetPauseFloorBytes", "BUDGET_PAUSE_FLOOR_BYTES"],
  ["monthlyQuotaBytes", "MONTHLY_QUOTA_BYTES"],
  ["newHostAgeDays", "NEW_HOST_AGE_DAYS"],
  ["newHostWeight", "NEW_HOST_WEIGHT"],
  ["overQuotaWeight", "OVER_QUOTA_WEIGHT"],
  ["egressBudgetBytes", "EGRESS_BUDGET_BYTES"],
  ["egressWarnFraction", "EGRESS_WARN_FRACTION"],
  ["egressDegradedFraction", "EGRESS_DEGRADED_FRACTION"],
  ["pressureWeightFactor", "PRESSURE_WEIGHT_FACTOR"],
  ["trafficCheckMs", "TRAFFIC_CHECK_MS"],
  ["blockedPollMs", "BLOCKED_POLL_MS"],
  ["maxHostsPerAccount", "MAX_HOSTS_PER_ACCOUNT"],
  ["accountStartsPerMinutePerIp", "ACCOUNT_STARTS_PER_MINUTE_PER_IP"],
  ["accountsPerIpPerDay", "ACCOUNTS_PER_IP_PER_DAY"],
  ["accountAdmissionsPerHostPerHour", "ACCOUNT_ADMISSIONS_PER_HOST_PER_HOUR"],
];

export type RelayEnv = Readonly<Record<string, string | undefined>>;

const isTruthy = (value: string | undefined): boolean => value === "1" || value === "true";

/** Overlay environment variables on the defaults. A malformed number is an error, not a fallback. */
export function loadConfig(env: RelayEnv): RelayConfig {
  const overrides: { -readonly [K in keyof RelayConfig]?: RelayConfig[K] } = {};
  for (const [key, name] of NUMERIC_ENV) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number >= 0`);
    overrides[key] = value;
  }
  const mbps = env.GLOBAL_BANDWIDTH_MBPS;
  if (mbps !== undefined && mbps !== "") {
    const value = Number(mbps);
    if (!Number.isFinite(value) || value <= 0) throw new Error("GLOBAL_BANDWIDTH_MBPS must be > 0");
    overrides.globalBandwidthBytesPerSec = (value * 1_000_000) / 8;
  }
  const degradedMbps = env.DEGRADED_HOST_MBPS;
  if (degradedMbps !== undefined && degradedMbps !== "") {
    const value = Number(degradedMbps);
    if (!Number.isFinite(value) || value <= 0) throw new Error("DEGRADED_HOST_MBPS must be > 0");
    overrides.degradedHostBytesPerSec = (value * 1_000_000) / 8;
  }
  const pingSeconds = env.K3_SELF_PING_INTERVAL_SEC;
  if (pingSeconds !== undefined && pingSeconds !== "") {
    const value = Number(pingSeconds);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("K3_SELF_PING_INTERVAL_SEC must be a number >= 0");
    }
    overrides.selfPingIntervalMs = value * 1000;
  }
  if (env.K3_ALERT_WEBHOOK_URL) {
    overrides.alertWebhookUrl = checkedUrl("K3_ALERT_WEBHOOK_URL", env.K3_ALERT_WEBHOOK_URL);
  }
  if (env.K3_SELF_PING_URL) {
    overrides.selfPingUrl = checkedUrl("K3_SELF_PING_URL", env.K3_SELF_PING_URL);
  }
  if (env.HOST) overrides.host = env.HOST;
  if (env.DB_PATH) overrides.dbPath = env.DB_PATH;
  if (env.POW_SECRET) overrides.powSecret = env.POW_SECRET;
  if (env.GIT_COMMIT) overrides.gitCommit = env.GIT_COMMIT;
  if (env.IMAGE_DIGEST) overrides.imageDigest = env.IMAGE_DIGEST;
  overrides.trustProxy = isTruthy(env.TRUST_PROXY);
  overrides.requireInvite = isTruthy(env.REQUIRE_INVITE);
  overrides.blockedHosts = (env.BLOCKED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  Object.assign(overrides, loadAccountConfig(env));
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (
    !(config.egressWarnFraction > 0) ||
    !(config.egressWarnFraction < config.egressDegradedFraction) ||
    config.egressDegradedFraction > 1
  ) {
    throw new Error(
      "EGRESS_WARN_FRACTION must be above 0 and below EGRESS_DEGRADED_FRACTION (<= 1)",
    );
  }
  if (!(config.egressBudgetBytes > 0)) throw new Error("EGRESS_BUDGET_BYTES must be > 0");
  return config;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const GITHUB_DEFAULTS = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  apiUrl: "https://api.github.com",
};
const GOOGLE_DEFAULTS = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
};
const APPLE_DEFAULTS = {
  authorizeUrl: "https://appleid.apple.com/auth/authorize",
  tokenUrl: "https://appleid.apple.com/auth/token",
  issuers: ["https://appleid.apple.com"],
  jwksUrl: "https://appleid.apple.com/auth/keys",
};

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

/** All of a provider's variables, or none of them: half a configuration is an error. */
function group(env: RelayEnv, provider: string, names: ReadonlyArray<string>): boolean {
  const set = names.filter((name) => present(env[name]));
  if (set.length === 0) return false;
  if (set.length !== names.length) {
    throw new Error(`${provider} sign-in needs all of ${names.join(", ")} (or none of them)`);
  }
  return true;
}

/**
 * Accounts are off until a provider is configured. A configured provider also needs the public
 * URL (its redirect URI is derived from it), the token seed and the HMAC key; a relay with half of
 * that refuses to start rather than sign people in with a key it would forget on restart.
 */
function loadAccountConfig(env: RelayEnv): Partial<RelayConfig> {
  const providers: AccountProviderConfig[] = [];
  if (group(env, "GitHub", ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"])) {
    providers.push({
      kind: "github",
      clientId: env.GITHUB_CLIENT_ID!.trim(),
      clientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
      appleKey: null,
      issuers: [],
      jwksUrl: null,
      ...GITHUB_DEFAULTS,
    });
  }
  if (group(env, "Google", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])) {
    providers.push({
      kind: "google",
      clientId: env.GOOGLE_CLIENT_ID!.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
      appleKey: null,
      apiUrl: null,
      ...GOOGLE_DEFAULTS,
    });
  }
  if (
    group(env, "Apple", ["APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"])
  ) {
    providers.push({
      kind: "apple",
      clientId: env.APPLE_CLIENT_ID!.trim(),
      clientSecret: null,
      appleKey: {
        teamId: env.APPLE_TEAM_ID!.trim(),
        keyId: env.APPLE_KEY_ID!.trim(),
        // Environment files often carry the PEM on one line with literal \n.
        privateKeyPem: env.APPLE_PRIVATE_KEY!.replace(/\\n/gu, "\n"),
      },
      apiUrl: null,
      ...APPLE_DEFAULTS,
    });
  }
  const webRedirects = (env.ACCOUNT_WEB_REDIRECTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => checkedUrl("ACCOUNT_WEB_REDIRECTS", entry));
  if (providers.length === 0) return { accountWebRedirects: webRedirects };
  if (!present(env.RELAY_PUBLIC_URL)) {
    throw new Error("sign-in needs RELAY_PUBLIC_URL (the relay's own https:// address)");
  }
  if (!present(env.ACCOUNT_TOKEN_SEED) || !isSeed(env.ACCOUNT_TOKEN_SEED.trim())) {
    throw new Error("sign-in needs ACCOUNT_TOKEN_SEED: 32 random bytes, base64url");
  }
  if (!present(env.ACCOUNT_ID_HMAC_KEY) || env.ACCOUNT_ID_HMAC_KEY.trim().length < 32) {
    throw new Error("sign-in needs ACCOUNT_ID_HMAC_KEY: at least 32 random characters");
  }
  const publicUrl = checkedUrl("RELAY_PUBLIC_URL", env.RELAY_PUBLIC_URL.trim()).replace(/\/$/u, "");
  return {
    accountProviders: providers,
    accountWebRedirects: webRedirects,
    publicUrl,
    accountTokenSeed: env.ACCOUNT_TOKEN_SEED.trim(),
    accountHmacKey: env.ACCOUNT_ID_HMAC_KEY.trim(),
  };
}

function isSeed(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

/** https only, so an alert is never sent in the clear. Plain http is for a loopback receiver. */
function checkedUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new Error(`${name} must be an https:// URL`);
  }
  return url.toString();
}

/** The limits published at `/.well-known/k3-relay`. Nothing secret or per-operator. */
export function publicLimits(config: RelayConfig) {
  return {
    preAuthMaxPayload: config.preAuthMaxPayload,
    postAuthMaxPayload: config.postAuthMaxPayload,
    maxSessionsPerHost: config.maxSessionsPerHost,
    maxSessionsPerDevice: config.maxSessionsPerDevice,
    preAuthMaxConcurrentPerIp: config.preAuthMaxConcurrentPerIp,
    preAuthPerMinutePerIp: config.preAuthPerMinutePerIp,
    registrationsPerIpPerDay: config.registrationsPerIpPerDay,
    authTimeoutMs: config.authTimeoutMs,
    sessionSetupMs: config.sessionSetupMs,
    dataTokenTtlMs: config.dataTokenTtlMs,
    pingIntervalMs: config.pingIntervalMs,
    backpressureHighWaterBytes: config.backpressureHighWaterBytes,
    backpressureCloseMs: config.backpressureCloseMs,
    bufferBudgetBytes: config.bufferBudgetBytes,
    globalBandwidthBytesPerSec: config.globalBandwidthBytesPerSec,
    monthlyQuotaBytes: config.monthlyQuotaBytes,
    egressBudgetBytes: config.egressBudgetBytes,
    degradedHostBytesPerSec: config.degradedHostBytesPerSec,
    powBaseDifficulty: config.powBaseDifficulty,
    requireInvite: config.requireInvite,
    maxHostsPerAccount: config.maxHostsPerAccount,
  };
}
