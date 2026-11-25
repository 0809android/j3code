#!/usr/bin/env bash
# Puts the relay in service on the machine it runs on. Safe to run again: it is how an update
# is applied. cloud-init runs it once after fetching this directory.
#
#   sudo deploy/install.sh                      deploy, and start the nightly backup
#   sudo deploy/install.sh --with-healthcheck   also run the outside health check from here
#                                               (only useful on a machine other than the relay)
#
# Needs /etc/k3-relay/compose.env, relay.env and backup.env (cloud-init writes them).
set -euo pipefail

with_healthcheck=0
case "${1:-}" in
  --with-healthcheck) with_healthcheck=1 ;;
  "") ;;
  *)
    echo "usage: install.sh [--with-healthcheck]" >&2
    exit 2
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
relay_dir=$(dirname "$here")
config_dir=/etc/k3-relay

for file in compose.env relay.env backup.env; do
  if [ ! -f "$config_dir/$file" ]; then
    echo "missing $config_dir/$file" >&2
    exit 1
  fi
done

# The directory the relay container writes snapshots to. 1000 is the `node` user in the image.
install -d -m 0700 -o 1000 -g 1000 /var/lib/k3-relay/backup

# Record which commit this is, for /.well-known/k3-relay.
if git -C "$relay_dir" rev-parse HEAD >/dev/null 2>&1; then
  commit=$(git -C "$relay_dir" rev-parse HEAD)
  sed -i '/^GIT_COMMIT=/d' "$config_dir/compose.env"
  printf 'GIT_COMMIT=%s\n' "$commit" >>"$config_dir/compose.env"
fi

render_unit() {
  sed "s#@@RELAY_DIR@@#$relay_dir#g" "$here/systemd/$1" >"/etc/systemd/system/$1"
  chmod 0644 "/etc/systemd/system/$1"
}
render_unit k3-relay-backup.service
render_unit k3-relay-backup.timer
if [ "$with_healthcheck" = 1 ]; then
  render_unit k3-relay-healthcheck.service
  render_unit k3-relay-healthcheck.timer
fi
systemctl daemon-reload
systemctl enable --now k3-relay-backup.timer
if [ "$with_healthcheck" = 1 ]; then
  systemctl enable --now k3-relay-healthcheck.timer
fi

# A pulled image when RELAY_IMAGE is set, otherwise built from this source.
if grep -q '^RELAY_IMAGE=.\+' "$config_dir/compose.env"; then
  "$here/compose.sh" pull
  "$here/compose.sh" up -d
else
  "$here/compose.sh" up -d --build
fi
"$here/compose.sh" ps
