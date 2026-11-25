#!/usr/bin/env bash
# Sends an alert: one line on stdout and, when K3_ALERT_WEBHOOK_URL is set, one POST.
# The message is a subject and numbers only, never a host id or an address.
#
#   notify.sh "k3-relay: backup failed" exitCode=1
#
# Each extra argument is name=value. A value that is a number is sent as a number.
set -euo pipefail

subject=${1:?usage: notify.sh <subject> [name=value ...]}
shift

json_escape() {
  local text=$1
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/ }
  printf '%s' "$text"
}

body="{\"subject\":\"$(json_escape "$subject")\",\"text\":\"$(json_escape "$subject")\""
for pair in "$@"; do
  name=${pair%%=*}
  value=${pair#*=}
  [[ $name =~ ^[A-Za-z][A-Za-z0-9_]*$ ]] || continue
  if [[ $value =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
    body+=",\"$name\":$value"
  else
    body+=",\"$name\":\"$(json_escape "$value")\""
  fi
done
body+="}"

printf '%s %s\n' "$subject" "$*"

url=${K3_ALERT_WEBHOOK_URL:-}
[ -n "$url" ] || exit 0
# The URL is a secret: it is never printed, and curl is told not to show it in errors.
if ! curl --silent --show-error --fail --max-time 10 --proto '=https' \
  --header 'Content-Type: application/json' --data "$body" --output /dev/null -- "$url"; then
  echo "notify: the webhook did not accept the message" >&2
  exit 1
fi
