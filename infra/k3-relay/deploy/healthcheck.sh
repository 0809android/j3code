#!/usr/bin/env bash
# Checks the relay from the outside and tells you when it stops answering, and when it is back.
#
# Run it from somewhere that is not the relay (a second machine, a CI schedule): a check that
# runs on the relay's own machine cannot see that machine disappear.
#
#   K3_HEALTH_URL=https://relay.example.com/health ./healthcheck.sh
#
# Settings (environment):
#   K3_HEALTH_URL         what to fetch (default https://relay.k3.kinocode.jp/health)
#   K3_HEALTH_FAILS       failed checks in a row before the alert (default 3)
#   K3_HEALTH_TIMEOUT     seconds to wait for an answer (default 10)
#   K3_HEALTH_STATE_DIR   where the failure count is kept (default /var/tmp/k3-relay-health)
#   K3_ALERT_WEBHOOK_URL  where alerts go (optional; see notify.sh)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
url=${K3_HEALTH_URL:-https://relay.k3.kinocode.jp/health}
threshold=${K3_HEALTH_FAILS:-3}
timeout=${K3_HEALTH_TIMEOUT:-10}
state_dir=${K3_HEALTH_STATE_DIR:-/var/tmp/k3-relay-health}
state_file="$state_dir/state"

mkdir -p "$state_dir"
fails=0
alerted=0
if [ -r "$state_file" ]; then
  read -r fails alerted <"$state_file" || true
fi
[[ $fails =~ ^[0-9]+$ ]] || fails=0
[[ $alerted =~ ^[01]$ ]] || alerted=0

# The relay answers exactly {"ok":true}. Anything else, an error page included, is a failure.
body=$(curl --silent --fail --max-time "$timeout" -- "$url" 2>/dev/null || true)
if [ "$body" = '{"ok":true}' ]; then
  if [ "$alerted" = 1 ]; then
    "$here/notify.sh" "k3-relay: health check recovered" failedChecks="$fails" || true
  fi
  printf '0 0\n' >"$state_file"
  exit 0
fi

fails=$((fails + 1))
if [ "$fails" -ge "$threshold" ] && [ "$alerted" = 0 ]; then
  "$here/notify.sh" "k3-relay: health check failing" failedChecks="$fails" threshold="$threshold" || true
  alerted=1
fi
printf '%s %s\n' "$fails" "$alerted" >"$state_file"
exit 1
