#!/usr/bin/env bash
# The nightly backup: a consistent snapshot of the relay's SQLite database, compressed, put in
# an OCI Object Storage bucket, with the newest 14 kept.
#
#   backup.sh             take a backup now
#   backup.sh --dry-run   print what would happen and change nothing
#
# Settings come from the environment (the systemd unit reads /etc/k3-relay/backup.env):
#   BACKUP_BUCKET       the bucket (required)
#   BACKUP_PREFIX       object name prefix (default relay/)
#   BACKUP_KEEP         generations to keep (default 14)
#   K3_BACKUP_DIR       the host directory the container writes to (default /var/lib/k3-relay/backup)
#   OCI_CLI_AUTH        how the oci CLI signs in (default instance_principal)
#   K3_ALERT_WEBHOOK_URL  gets a message when the backup fails (optional)
set -euo pipefail
umask 077

dry_run=0
case "${1:-}" in
  --dry-run) dry_run=1 ;;
  "") ;;
  *)
    echo "usage: backup.sh [--dry-run]" >&2
    exit 2
    ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bucket=${BACKUP_BUCKET:?BACKUP_BUCKET is not set}
prefix=${BACKUP_PREFIX:-relay/}
keep=${BACKUP_KEEP:-14}
backup_dir=${K3_BACKUP_DIR:-/var/lib/k3-relay/backup}
export OCI_CLI_AUTH=${OCI_CLI_AUTH:-instance_principal}

if ! [[ $keep =~ ^[0-9]+$ ]] || [ "$keep" -lt 1 ]; then
  echo "BACKUP_KEEP must be a whole number, 1 or more" >&2
  exit 2
fi

run() {
  if [ "$dry_run" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

failed() {
  "$here/notify.sh" "k3-relay: backup failed" exitCode="$1" || true
}
trap 'failed $?' ERR

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="relay-$stamp.sqlite"
object="$prefix$name.gz"

# The snapshot is written by the relay's own container (VACUUM INTO), so it is consistent
# while the relay keeps serving. The file is owned by the container's user, root reads it.
run "$here/compose.sh" exec -T relay node src/cli.ts backup "/backup/$name"
run gzip -9 "$backup_dir/$name"
run gzip -t "$backup_dir/$name.gz"

if [ "$dry_run" = 1 ]; then
  namespace='<namespace>'
else
  namespace=$(oci os ns get --query data --raw-output)
fi
run oci os object put --bucket-name "$bucket" --namespace-name "$namespace" \
  --name "$object" --file "$backup_dir/$name.gz" --force
run rm -f -- "$backup_dir/$name.gz"

# Retention: only names this script makes, newest $keep stay. Runs after a successful upload,
# so a failed night never costs an older copy.
if [ "$dry_run" = 1 ]; then
  echo "+ keep the newest $keep objects named ${prefix}relay-<UTC time>.sqlite.gz, delete the rest"
  exit 0
fi
pattern="^${prefix}relay-[0-9]{8}T[0-9]{6}Z\.sqlite\.gz\$"
names=$(oci os object list --bucket-name "$bucket" --namespace-name "$namespace" \
  --prefix "$prefix" --all --query 'data[].name' | jq -r '.[]?' | grep -E "$pattern" | sort || true)
total=$(printf '%s\n' "$names" | grep -c . || true)
excess=$((total - keep))
if [ "$excess" -gt 0 ]; then
  printf '%s\n' "$names" | head -n "$excess" | while IFS= read -r old; do
    oci os object delete --bucket-name "$bucket" --namespace-name "$namespace" \
      --object-name "$old" --force
  done
fi
echo "backup done: $object (kept the newest $keep)"
