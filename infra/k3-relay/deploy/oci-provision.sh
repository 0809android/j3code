#!/usr/bin/env bash
# Creates the OCI side of a K3 relay with the `oci` CLI: a compartment of its own, a VCN, a
# subnet, a security list, one always-free micro instance, a reserved public IP and a bucket
# for the backups. It makes nothing until you say --apply.
#
#   deploy/oci-provision.sh --tenancy-ocid ocid1.tenancy... --repo-url https://... --repo-ref <sha>
#   deploy/oci-provision.sh --apply ...        the same, for real
#
# What it will not do: delete, terminate or change anything that exists. A resource that is
# already there under the expected name is reused as it is, except the instance and the public
# IP, where it stops instead. It creates no DNS record and no IAM policy; it prints both.
#
# Options (each can also be set in the environment as shown):
#   --apply | --dry-run          dry-run is the default
#   --tenancy-ocid OCID          or OCI_CLI_TENANCY, or the profile's ~/.oci/config
#   --parent-compartment-id OCID where the K3 compartment goes (default: the tenancy)
#   --region REGION              default ap-osaka-1; must be the tenancy's home region
#   --profile NAME               an oci CLI profile
#   --name NAME                  prefix for everything it creates (default k3-relay)
#   --domain NAME                the relay's domain (default relay.k3.kinocode.jp)
#   --ssh-cidr CIDR              IPv4 range allowed to SSH in. Without it port 22 stays closed
#   --ssh-public-key-file PATH   key for the machine's users (needed when --ssh-cidr is given)
#   --repo-url URL               https URL of the repository (the machine fetches infra/k3-relay)
#   --repo-ref REF               commit, tag or branch to deploy. Use a full commit SHA
#   --relay-image IMAGE          a published image to pull; empty builds from source on the machine
#   --bucket-name NAME           backup bucket (default <name>-backup)
#   --availability-domain NAME   default: the first one
#   --self-ping-interval-sec N   idle-reclaim self ping (default 0, off)
#   --user-data-out PATH         only write the cloud-init user data to PATH and stop (for
#                                replacing the instance by hand)
#   K3_ALERT_WEBHOOK_URL         alarm webhook (optional). It ends up in the instance's user data
set -euo pipefail

SHAPE=VM.Standard.E2.1.Micro
FREE_MICRO_LIMIT=2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

apply=0
tenancy=${OCI_CLI_TENANCY:-}
parent=""
region=ap-osaka-1
profile=""
name=k3-relay
domain=relay.k3.kinocode.jp
ssh_cidr=""
ssh_key_file=""
repo_url=""
repo_ref=""
relay_image=""
bucket=""
availability_domain=""
self_ping_seconds=0
user_data_out=""
template="$here/cloud-init.yaml"

die() {
  echo "error: $*" >&2
  exit 1
}
note() { printf '%s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --dry-run) apply=0 ;;
    --tenancy-ocid) tenancy=${2:?}; shift ;;
    --parent-compartment-id) parent=${2:?}; shift ;;
    --region) region=${2:?}; shift ;;
    --profile) profile=${2:?}; shift ;;
    --name) name=${2:?}; shift ;;
    --domain) domain=${2:?}; shift ;;
    --ssh-cidr) ssh_cidr=${2:?}; shift ;;
    --ssh-public-key-file) ssh_key_file=${2:?}; shift ;;
    --repo-url) repo_url=${2:?}; shift ;;
    --repo-ref) repo_ref=${2:?}; shift ;;
    --relay-image) relay_image=${2?}; shift ;;
    --bucket-name) bucket=${2:?}; shift ;;
    --availability-domain) availability_domain=${2:?}; shift ;;
    --self-ping-interval-sec) self_ping_seconds=${2:?}; shift ;;
    --user-data-out) user_data_out=${2:?}; shift ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

bucket=${bucket:-$name-backup}
alert_webhook=${K3_ALERT_WEBHOOK_URL:-}

# --- the oci CLI -------------------------------------------------------------------------------
OCI_GLOBAL=(--region "$region")
if [ -n "$profile" ]; then OCI_GLOBAL+=(--profile "$profile"); fi

# Reads only: list, get. These run in a dry run too, to show what is already there.
oci_read() { oci "${OCI_GLOBAL[@]}" "$@"; }

# Every change goes through here. In a dry run it prints the command and answers with the
# placeholder it was given, so the plan can be followed to the end.
oci_write() {
  local placeholder=$1
  shift
  if [ "$apply" = 1 ]; then
    oci "${OCI_GLOBAL[@]}" "$@"
  else
    printf '+ oci' >&2
    printf ' %q' "${OCI_GLOBAL[@]}" "$@" >&2
    printf '\n' >&2
    printf '%s\n' "$placeholder"
  fi
}

can_read=0
if command -v oci >/dev/null 2>&1; then
  if [ -z "$tenancy" ]; then
    config=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
    section="[${profile:-DEFAULT}]"
    if [ -r "$config" ]; then
      tenancy=$(awk -v p="$section" '$0==p{f=1;next} /^\[/{f=0} f&&/^tenancy[ \t]*=/{sub(/^[^=]*=[ \t]*/,""); print; exit}' "$config")
    fi
  fi
  if [ -n "$tenancy" ] && oci_read os ns get >/dev/null 2>&1; then can_read=1; fi
fi
if [ "$apply" = 1 ] && [ "$can_read" = 0 ]; then
  die "cannot reach OCI with the oci CLI (is it installed and configured, and is --tenancy-ocid known?)"
fi
tenancy=${tenancy:-<tenancy-ocid>}
parent=${parent:-$tenancy}

# --- input checks ------------------------------------------------------------------------------
check() {
  local label=$1 value=$2 pattern=$3
  [[ $value =~ $pattern ]] || die "$label looks wrong: '$value'"
}
check "--name" "$name" '^[a-z][a-z0-9-]{1,30}$'
check "--region" "$region" '^[a-z]{2}-[a-z]+-[0-9]+$'
check "--domain" "$domain" '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
check "--bucket-name" "$bucket" '^[A-Za-z0-9._-]{1,63}$'
check "--self-ping-interval-sec" "$self_ping_seconds" '^[0-9]+$'
if [ -n "$ssh_cidr" ]; then
  check "--ssh-cidr" "$ssh_cidr" '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
  [ "$ssh_cidr" != "0.0.0.0/0" ] || die "--ssh-cidr 0.0.0.0/0 would open SSH to everyone; name your own range"
  [ -n "$ssh_key_file" ] || die "--ssh-cidr needs --ssh-public-key-file"
fi
[ -z "$relay_image" ] || check "--relay-image" "$relay_image" '^[A-Za-z0-9._/:@-]+$'
[ -z "$alert_webhook" ] || check "K3_ALERT_WEBHOOK_URL" "$alert_webhook" '^https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'
if [ "$apply" = 1 ]; then
  [ -n "$repo_url" ] || die "--repo-url is required with --apply"
  [ -n "$repo_ref" ] || die "--repo-ref is required with --apply"
fi
[ -z "$repo_url" ] || check "--repo-url" "$repo_url" '^https://[A-Za-z0-9._~:/%-]+$'
[ -z "$repo_ref" ] || check "--repo-ref" "$repo_ref" '^[A-Za-z0-9._/-]+$'
if [ -n "$repo_ref" ] && ! [[ $repo_ref =~ ^[0-9a-f]{40}$ ]]; then
  note "warning: --repo-ref is not a full commit SHA, so the machine will deploy whatever it points to when it boots"
fi

ssh_key=''
ssh_rule_v4='# ssh: closed (no --ssh-cidr)'
if [ -n "$ssh_cidr" ]; then
  [ -r "$ssh_key_file" ] || die "cannot read $ssh_key_file"
  ssh_key=$(head -n 1 "$ssh_key_file")
  [[ $ssh_key =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9._@-]+)?$ ]] || die "$ssh_key_file does not look like one public key line"
  ssh_rule_v4="-A INPUT -p tcp -s $ssh_cidr --dport 22 -m conntrack --ctstate NEW -j ACCEPT"
fi

# --- the user data -----------------------------------------------------------------------------
tmp_dir=$(mktemp -d)
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
chmod 700 "$tmp_dir"
user_data="$tmp_dir/user-data.yaml"

render() {
  K3_TPL_RELAY_DOMAIN=$domain \
    K3_TPL_REPO_URL=${repo_url:-<repo-url>} \
    K3_TPL_REPO_REF=${repo_ref:-<repo-ref>} \
    K3_TPL_RELAY_IMAGE=$relay_image \
    K3_TPL_SSH_KEY=$ssh_key \
    K3_TPL_SSH_RULE_V4=$ssh_rule_v4 \
    K3_TPL_ALERT_WEBHOOK_URL=$alert_webhook \
    K3_TPL_SELF_PING_URL=$([ "$self_ping_seconds" -gt 0 ] && printf 'https://%s/health' "$domain" || true) \
    K3_TPL_SELF_PING_INTERVAL_SEC=$self_ping_seconds \
    K3_TPL_BACKUP_BUCKET=$bucket \
    awk '
      BEGIN {
        n = split("RELAY_DOMAIN REPO_URL REPO_REF RELAY_IMAGE SSH_KEY SSH_RULE_V4 ALERT_WEBHOOK_URL SELF_PING_URL SELF_PING_INTERVAL_SEC BACKUP_BUCKET", keys, " ")
      }
      {
        line = $0
        for (i = 1; i <= n; i++) {
          placeholder = "@@" keys[i] "@@"
          value = ENVIRON["K3_TPL_" keys[i]]
          out = ""
          while ((at = index(line, placeholder)) > 0) {
            out = out substr(line, 1, at - 1) value
            line = substr(line, at + length(placeholder))
          }
          line = out line
        }
        print line
      }' "$template" >"$user_data"
  if grep -q '@@[A-Z_]*@@' "$user_data"; then
    die "the template still has an unfilled placeholder: $(grep -o '@@[A-Z_]*@@' "$user_data" | sort -u | tr '\n' ' ')"
  fi
}
render
chmod 600 "$user_data"
if [ -n "$user_data_out" ]; then
  [ -n "$repo_url" ] && [ -n "$repo_ref" ] || die "--user-data-out needs --repo-url and --repo-ref"
  install -m 600 "$user_data" "$user_data_out"
  echo "wrote $user_data_out"
  exit 0
fi

# --- looking things up (read only) -------------------------------------------------------------
is_placeholder() { [[ ${1:-} == \<* ]]; }

# Prints the first id of a listing, or nothing. A dry run with no OCI access finds nothing.
first_id() {
  [ "$can_read" = 1 ] || return 0
  local id
  id=$(oci_read "$@" --query 'data[0].id' --raw-output 2>/dev/null || true)
  if [ -n "$id" ] && [ "$id" != null ]; then printf '%s\n' "$id"; fi
}

echo "== K3 relay on OCI: $([ "$apply" = 1 ] && echo APPLY || echo 'DRY RUN, nothing will be created') =="
echo "region $region   name $name   domain $domain   shape $SHAPE"
echo

# --- 1. checks before anything is made ---------------------------------------------------------
echo "-- checks"
if [ "$can_read" = 1 ]; then
  home=$(oci_read iam region-subscription list --tenancy-id "$tenancy" \
    --query 'data[?"is-home-region"]."region-name" | [0]' --raw-output 2>/dev/null || true)
  if [ -n "$home" ] && [ "$home" != "$region" ]; then
    msg="the tenancy's home region is $home, and always-free resources must be there (--region is $region)"
    if [ "$apply" = 1 ]; then die "$msg"; else echo "WARNING: $msg"; fi
  else
    echo "home region: ${home:-unknown}"
  fi

  # The always-free allowance is two micro instances for the whole tenancy.
  in_use=0
  while IFS= read -r compartment_id; do
    [ -n "$compartment_id" ] || continue
    count=$(oci_read compute instance list --compartment-id "$compartment_id" --all \
      --query "length(data[?shape=='$SHAPE' && \"lifecycle-state\"!='TERMINATED'])" --raw-output 2>/dev/null || echo 0)
    [[ $count =~ ^[0-9]+$ ]] || count=0
    in_use=$((in_use + count))
  done < <({
    printf '%s\n' "$tenancy"
    oci_read iam compartment list --compartment-id "$tenancy" --compartment-id-in-subtree true \
      --access-level ACCESSIBLE --lifecycle-state ACTIVE --all --query 'data[].id' 2>/dev/null | jq -r '.[]?'
  })
  remaining=$((FREE_MICRO_LIMIT - in_use))
  echo "always-free micro instances ($SHAPE): $in_use of $FREE_MICRO_LIMIT in use, $remaining left"
  if [ "$remaining" -le 0 ]; then
    msg="no always-free micro instance is left in this tenancy; a new one would not be free"
    if [ "$apply" = 1 ]; then die "$msg"; else echo "WARNING: $msg"; fi
  fi

  if [ -z "$availability_domain" ]; then
    availability_domain=$(oci_read iam availability-domain list --compartment-id "$tenancy" \
      --query 'data[0].name' --raw-output 2>/dev/null || true)
  fi
  fits=$(oci_read compute shape list --compartment-id "$tenancy" --availability-domain "${availability_domain:-none}" \
    --query "length(data[?shape=='$SHAPE'])" --raw-output 2>/dev/null || echo 0)
  if [ "${fits:-0}" = 0 ]; then
    msg="$SHAPE is not offered in availability domain '${availability_domain:-none}'"
    if [ "$apply" = 1 ]; then die "$msg"; else echo "WARNING: $msg"; fi
  fi
  image_id=$(oci_read compute image list --compartment-id "$tenancy" \
    --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape "$SHAPE" \
    --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output 2>/dev/null || true)
  [ -n "$image_id" ] && [ "$image_id" != null ] || { [ "$apply" = 0 ] || die "no Ubuntu 24.04 image for $SHAPE"; image_id="<ubuntu-24.04-image-id>"; }
  echo "availability domain: ${availability_domain:-?}"
  echo "image: $image_id"
  namespace=$(oci_read os ns get --query data --raw-output)
else
  echo "oci is not usable here (not installed, not configured, or no --tenancy-ocid): the checks"
  echo "below were skipped. They run on --apply, and --apply stops if they fail."
  availability_domain=${availability_domain:-<availability-domain>}
  image_id="<ubuntu-24.04-image-id>"
  namespace="<object-storage-namespace>"
fi
echo

# --- 2. the resources --------------------------------------------------------------------------
# Each step reuses what already carries its name (inside the K3 compartment) and creates the rest.
reuse_or() {
  # reuse_or <label> <existing-id> -> prints "reuse" when there is one
  if [ -n "$2" ]; then
    echo "reusing $1: $2" >&2
    return 0
  fi
  return 1
}

echo "-- compartment"
compartment=$(first_id iam compartment list --compartment-id "$parent" --name "$name" --lifecycle-state ACTIVE)
if ! reuse_or "compartment $name" "$compartment"; then
  compartment=$(oci_write "<compartment-id>" iam compartment create --compartment-id "$parent" \
    --name "$name" --description "K3 relay" --wait-for-state ACTIVE --query 'data.id' --raw-output)
fi

lookup() {
  # lookup <list command...>: only when the compartment is a real one
  is_placeholder "$compartment" && return 0
  first_id "$@"
}

echo "-- network"
vcn=$(lookup network vcn list --compartment-id "$compartment" --display-name "$name-vcn" --lifecycle-state AVAILABLE)
if ! reuse_or "VCN" "$vcn"; then
  vcn=$(oci_write "<vcn-id>" network vcn create --compartment-id "$compartment" --display-name "$name-vcn" \
    --cidr-blocks '["10.30.0.0/16"]' --dns-label k3relay --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
igw=""
rt=""
sl=""
subnet=""
if ! is_placeholder "$vcn"; then
  igw=$(first_id network internet-gateway list --compartment-id "$compartment" --vcn-id "$vcn" --display-name "$name-igw")
  rt=$(first_id network route-table list --compartment-id "$compartment" --vcn-id "$vcn" --display-name "$name-routes")
  sl=$(first_id network security-list list --compartment-id "$compartment" --vcn-id "$vcn" --display-name "$name-security")
  subnet=$(first_id network subnet list --compartment-id "$compartment" --vcn-id "$vcn" --display-name "$name-subnet")
fi
if ! reuse_or "internet gateway" "$igw"; then
  igw=$(oci_write "<igw-id>" network internet-gateway create --compartment-id "$compartment" --vcn-id "$vcn" \
    --is-enabled true --display-name "$name-igw" --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
if ! reuse_or "route table" "$rt"; then
  rt=$(oci_write "<route-table-id>" network route-table create --compartment-id "$compartment" --vcn-id "$vcn" \
    --display-name "$name-routes" \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$igw\"}]" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
if ! reuse_or "security list" "$sl"; then
  ingress='[
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}}'
  if [ -n "$ssh_cidr" ]; then
    ingress="$ingress,
    {\"source\":\"$ssh_cidr\",\"protocol\":\"6\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":22,\"max\":22}}}"
  fi
  ingress="$ingress
  ]"
  sl=$(oci_write "<security-list-id>" network security-list create --compartment-id "$compartment" --vcn-id "$vcn" \
    --display-name "$name-security" --ingress-security-rules "$ingress" \
    --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
if ! reuse_or "subnet" "$subnet"; then
  subnet=$(oci_write "<subnet-id>" network subnet create --compartment-id "$compartment" --vcn-id "$vcn" \
    --display-name "$name-subnet" --cidr-block 10.30.1.0/24 --dns-label relay \
    --route-table-id "$rt" --security-list-ids "[\"$sl\"]" --prohibit-public-ip-on-vnic false \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi

echo "-- backup bucket"
bucket_exists=""
if [ "$can_read" = 1 ] && oci_read os bucket get --bucket-name "$bucket" --namespace-name "$namespace" >/dev/null 2>&1; then
  bucket_exists=$bucket
fi
if ! reuse_or "bucket" "$bucket_exists"; then
  oci_write "" os bucket create --compartment-id "$compartment" --name "$bucket" --namespace-name "$namespace" \
    --public-access-type NoPublicAccess --storage-tier Standard >/dev/null
fi

echo "-- instance and public IP"
if [ "$can_read" = 1 ] && ! is_placeholder "$compartment"; then
  existing_instance=$(oci_read compute instance list --compartment-id "$compartment" --display-name "$name" --all \
    --query "data[?\"lifecycle-state\"!='TERMINATED'] | [0].id" --raw-output 2>/dev/null || true)
  if [ -n "$existing_instance" ] && [ "$existing_instance" != null ]; then
    die "an instance named $name already exists in this compartment ($existing_instance). Not touching it."
  fi
  existing_ip=$(oci_read network public-ip list --compartment-id "$compartment" --scope REGION --lifetime RESERVED --all \
    --query "data[?\"display-name\"=='$name-ip'] | [0].id" --raw-output 2>/dev/null || true)
  if [ -n "$existing_ip" ] && [ "$existing_ip" != null ]; then
    die "a reserved public IP named $name-ip already exists ($existing_ip). Not touching it."
  fi
fi

launch_args=(compute instance launch --compartment-id "$compartment" --availability-domain "$availability_domain"
  --shape "$SHAPE" --display-name "$name" --image-id "$image_id" --subnet-id "$subnet"
  --assign-public-ip false --boot-volume-size-in-gbs 50 --user-data-file "$user_data")
if [ -n "$ssh_key_file" ]; then launch_args+=(--ssh-authorized-keys-file "$ssh_key_file"); fi
instance=$(oci_write "<instance-id>" "${launch_args[@]}" --wait-for-state RUNNING --query 'data.id' --raw-output)

if is_placeholder "$instance"; then
  vnic="<vnic-id>"
  private_ip="<private-ip-id>"
else
  vnic=$(oci_read compute instance list-vnics --instance-id "$instance" --query 'data[0].id' --raw-output)
  private_ip=$(oci_read network private-ip list --vnic-id "$vnic" --query 'data[0].id' --raw-output)
fi
public_ip=$(oci_write "<public-ip-address>" network public-ip create --compartment-id "$compartment" \
  --lifetime RESERVED --display-name "$name-ip" --private-ip-id "$private_ip" \
  --query 'data."ip-address"' --raw-output)

# --- 3. what is left for you -------------------------------------------------------------------
cat <<DONE

== $([ "$apply" = 1 ] && echo "done" || echo "end of the plan; nothing was created") ==

Public IP:  $public_ip

1. DNS (nothing was changed): in the kinocode.jp zone add an A record, DNS only, no proxy:
     $domain  ->  $public_ip
   Caddy gets its certificate once the name resolves; check https://$domain/health afterwards.

2. Backups sign in as the instance. Create this once, in the identity domain and a policy
   (nothing was created):
     dynamic group $name-instances, matching rule:
       ALL {instance.compartment.id = '$compartment'}
     policy statements:
       Allow dynamic-group $name-instances to manage objects in compartment $name where target.bucket.name = '$bucket'
       Allow dynamic-group $name-instances to read buckets in compartment $name
       Allow dynamic-group $name-instances to read objectstorage-namespaces in tenancy

3. Watch it from outside: run deploy/healthcheck.sh somewhere else, with
     K3_HEALTH_URL=https://$domain/health

The first boot takes several minutes (updates, Docker, building or pulling the image).
DONE
