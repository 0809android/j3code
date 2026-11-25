const MIB = 1024 * 1024;

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
  readonly globalBandwidthBytesPerSec: number;
  readonly globalBurstBytes: number;
  readonly fairQuantumBytes: number;
  readonly monthlyQuotaBytes: number;
  readonly newHostAgeDays: number;
  readonly newHostWeight: number;
  readonly overQuotaWeight: number;

  readonly hostIdleRetentionDays: number;
  readonly grantRetentionAfterExpiryDays: number;
  readonly revocationRetentionDays: number;
  readonly inviteRetentionAfterUseDays: number;
  readonly inviteTtlDays: number;
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
  globalBandwidthBytesPerSec: (45 * 1_000_000) / 8,
  globalBurstBytes: 256 * 1024,
  fairQuantumBytes: 32 * 1024,
  monthlyQuotaBytes: 200 * 1_000_000_000,
  newHostAgeDays: 7,
  newHostWeight: 0.5,
  overQuotaWeight: 0.25,

  hostIdleRetentionDays: 365,
  grantRetentionAfterExpiryDays: 30,
  revocationRetentionDays: 30,
  inviteRetentionAfterUseDays: 30,
  inviteTtlDays: 30,
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
  ["monthlyQuotaBytes", "MONTHLY_QUOTA_BYTES"],
  ["newHostAgeDays", "NEW_HOST_AGE_DAYS"],
  ["newHostWeight", "NEW_HOST_WEIGHT"],
  ["overQuotaWeight", "OVER_QUOTA_WEIGHT"],
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
  return { ...DEFAULT_CONFIG, ...overrides };
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
    powBaseDifficulty: config.powBaseDifficulty,
    requireInvite: config.requireInvite,
  };
}
