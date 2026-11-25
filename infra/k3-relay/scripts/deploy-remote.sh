#!/bin/sh
# Runs on the OCI VM, fed through `ssh host sh -s -- <dir> <digest>` by the k3-relay-deploy workflow.
# <dir> holds docker-compose.example.yml, Caddyfile, docker-compose.deploy.yml and a `.env` that sets
# RELAY_DOMAIN (the workflow copies the first three; `.env` is the operator's, and is never sent).
set -eu

dir=${1:?usage: deploy-remote.sh <dir> <image digest>}
digest=${2:?usage: deploy-remote.sh <dir> <image digest>}

case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "not an image digest: $digest" >&2; exit 2 ;;
esac

cd "$dir"
export IMAGE_DIGEST="$digest"
compose="docker compose -f docker-compose.example.yml -f docker-compose.deploy.yml"

$compose config --quiet
$compose pull relay
$compose up -d --no-build --remove-orphans
$compose ps
