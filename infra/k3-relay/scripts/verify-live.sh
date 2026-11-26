#!/bin/sh
# Compares what a running relay reports at /.well-known/k3-relay with an expected image digest and git
# commit. Used by the deploy workflow after a deploy, and by anyone checking a relay (docs/VERIFY.md).
#
#   scripts/verify-live.sh https://relay.k3.kinocode.jp sha256:... <40-hex commit> [attempts]
#
# Retries (5 s apart) so that a container that is still starting does not count as a mismatch.
set -eu

base=${1:?usage: verify-live.sh <base url> <image digest> <git commit> [attempts]}
want_digest=${2:?usage: verify-live.sh <base url> <image digest> <git commit> [attempts]}
want_commit=${3:?usage: verify-live.sh <base url> <image digest> <git commit> [attempts]}
attempts=${4:-24}

url="${base%/}/.well-known/k3-relay"
n=0
while :; do
  n=$((n + 1))
  body=$(curl --silent --show-error --fail --location --max-time 10 "$url" 2>/dev/null || true)
  if [ -n "$body" ]; then
    got_digest=$(printf '%s' "$body" | jq -r '.imageDigest // empty' 2>/dev/null || true)
    got_commit=$(printf '%s' "$body" | jq -r '.gitCommit // empty' 2>/dev/null || true)
    if [ "$got_digest" = "$want_digest" ] && [ "$got_commit" = "$want_commit" ]; then
      echo "ok: $url reports imageDigest=$got_digest gitCommit=$got_commit"
      printf '%s\n' "$body" | jq .
      exit 0
    fi
  fi
  if [ "$n" -ge "$attempts" ]; then
    echo "MISMATCH or no answer from $url after $n tries" >&2
    echo "  expected imageDigest=$want_digest gitCommit=$want_commit" >&2
    echo "  reported imageDigest=${got_digest:-<none>} gitCommit=${got_commit:-<none>}" >&2
    exit 1
  fi
  sleep 5
done
