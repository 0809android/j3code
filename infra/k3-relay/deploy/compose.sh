#!/usr/bin/env bash
# docker compose for the production layout: the example compose file plus the OCI additions.
# Runs from the relay directory whatever the caller's directory is.
#
#   deploy/compose.sh up -d --build
#   deploy/compose.sh exec -T relay node src/cli.ts block <hostId>
set -euo pipefail

relay_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${K3_COMPOSE_ENV:-/etc/k3-relay/compose.env}

cd "$relay_dir"
exec docker compose --env-file "$env_file" \
  -f docker-compose.example.yml -f deploy/docker-compose.oci.yml "$@"
