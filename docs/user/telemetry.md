# Usage data and diagnostics

K3 Code does not send product usage data. There is no analytics service, no anonymous
installation ID, and no crash reporter in the server, desktop app, web app, or mobile app. Your code
and prompts go to the providers you set up, not to K3 Code.

## Agent feedback

**Agent feedback** in **Settings > Labs** lets an agent write down a problem it hit with a K3 tool
or command. Nothing is sent anywhere: reports are saved on your machine, and
`t3 feedback list` shows them. The setting stays off unless you turn it on.

## Relay connection traces

Relay connection traces for T3 Connect are off. They start only when you set
`K3CODE_TELEMETRY_ENABLED=true` in the server's environment **and** your build has a trace endpoint
configured. Without both, nothing is exported. An administrator can still switch them off with a
[managed policy](./managed-policy.md#other-capabilities).

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). It is off unless you use
that feature.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`K3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `K3CODE_OTLP_*_URL`, set `K3CODE_OTLP_HEADERS` for
receivers that need authentication and `K3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
