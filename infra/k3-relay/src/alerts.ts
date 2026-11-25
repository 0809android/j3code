import type { Logger } from "./server.ts";
import type { TrafficAlert } from "./traffic.ts";

const WEBHOOK_TIMEOUT_MS = 5_000;

/** The one body an alarm webhook receives: a subject and numbers, never an id or an address. */
export function alertPayload(alert: TrafficAlert): Record<string, string | number> {
  const subject = `k3-relay: monthly transfer reached ${alert.thresholdPercent}% of the budget`;
  return {
    subject,
    text: `${subject} (${alert.percent}% used, month ${alert.month})`,
    level: alert.level,
    thresholdPercent: alert.thresholdPercent,
    percent: alert.percent,
    usedBytes: alert.usedBytes,
    budgetBytes: alert.budgetBytes,
    month: alert.month,
  };
}

export interface AlertNotifierOptions {
  readonly logger: Logger;
  readonly webhookUrl: string | null;
  readonly fetch: typeof fetch;
}

/** Prints one line, and posts the payload to the webhook when one is configured. */
export function createAlertNotifier(
  options: AlertNotifierOptions,
): (alert: TrafficAlert) => Promise<void> {
  return (alert) => {
    options.logger.info("alert", {
      level: alert.level,
      thresholdPercent: alert.thresholdPercent,
      percent: alert.percent,
      usedBytes: alert.usedBytes,
      budgetBytes: alert.budgetBytes,
      month: alert.month,
    });
    const url = options.webhookUrl;
    if (!url) return Promise.resolve();
    return options
      .fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertPayload(alert)),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      .then(
        (response) => {
          if (!response.ok)
            options.logger.error("alert-webhook-failed", { status: response.status });
          return response.body?.cancel().catch(() => undefined);
        },
        (error: unknown) => {
          const code = (error as { name?: unknown } | null)?.name;
          options.logger.error("alert-webhook-failed", {
            code: typeof code === "string" ? code : "unknown",
          });
        },
      );
  };
}
