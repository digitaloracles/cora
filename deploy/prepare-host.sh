#!/bin/sh
# Prepare a fresh Ubuntu or Debian machine for a Cora space, in one go, as root.
# Afterwards deploy/linux.sh, run from your own checkout, installs Cora itself without root.
#
#   curl -fsSL https://raw.githubusercontent.com/digitaloracles/cora/main/deploy/prepare-host.sh \
#     | sudo sh -s -- --domain cora.example.com
#
# Options:
#   --user NAME        the account Cora runs as (default cora)
#   --domain HOST      publish https://HOST with Caddy (automatic certificate); opens 80 and 443
#   --ssh-key KEY      public key allowed to log in as that user (default: root's and the sudo user's keys)
#   --cli LIST         official agent CLIs to install, comma separated: claude, codex
#   --swap SIZE        add a swap file when the machine has none, e.g. 4G
#   --hush-version V   hush release to install (default v0.8.1)
#   --no-firewall      leave the firewall alone
# Running it again is safe: it only adds what is missing.
set -eu

USER_NAME=cora
DOMAIN=
SSH_KEY=
CLIS=
SWAP=
HUSH_VERSION=v0.8.1
FIREWALL=1

fail() { echo "prepare-host: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="${2:?--user needs a name}"; shift 2 ;;
    --domain) DOMAIN="${2:?--domain needs a host name}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:?--ssh-key needs a public key}"; shift 2 ;;
    --cli) CLIS="${2:?--cli needs a list}"; shift 2 ;;
    --swap) SWAP="${2:?--swap needs a size}"; shift 2 ;;
    --hush-version) HUSH_VERSION="${2:?--hush-version needs a tag}"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) echo "usage: prepare-host.sh [--user NAME] [--domain HOST] [--ssh-key KEY] [--cli claude,codex] [--swap 4G] [--hush-version V] [--no-firewall]"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run it as root (sudo sh prepare-host.sh ...)"
command -v apt-get >/dev/null 2>&1 || fail "this script knows Ubuntu and Debian (apt); on other systems follow the manual steps in the docs"
echo "$USER_NAME" | grep -Eq '^[a-z_][a-z0-9_-]*$' || fail "invalid user name: $USER_NAME"
case "$CLIS" in *[!a-z,]*) fail "invalid --cli list: $CLIS" ;; esac
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

step "system packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync git ufw >/dev/null

if [ -n "$SWAP" ] && [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  step "swap file ($SWAP)"
  fallocate -l "$SWAP" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "user $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$USER_NAME"
fi
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$HOME_DIR/.ssh"
KEYS="$HOME_DIR/.ssh/authorized_keys"
touch "$KEYS"
# Only plain keys: cloud images put a "please log in as ubuntu" command in front of root's.
add_keys() { [ -f "$1" ] && grep -E '^(ssh-|ecdsa-|sk-)' "$1" | while IFS= read -r line; do grep -qxF "$line" "$KEYS" || echo "$line" >> "$KEYS"; done; return 0; }
if [ -n "$SSH_KEY" ]; then
  grep -qxF "$SSH_KEY" "$KEYS" || echo "$SSH_KEY" >> "$KEYS"
else
  add_keys /root/.ssh/authorized_keys
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && add_keys "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"
fi
chown "$USER_NAME:$USER_NAME" "$KEYS"
chmod 600 "$KEYS"
[ -s "$KEYS" ] || echo "warning: $KEYS is empty; pass --ssh-key or deploy/linux.sh cannot log in"
# Without lingering the user's services stop at logout, and an agent is meant to stay on.
loginctl enable-linger "$USER_NAME"

step "docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
usermod -aG docker "$USER_NAME"

step "node 22"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

if [ -n "$CLIS" ]; then
  step "agent CLIs ($CLIS)"
  for cli in $(echo "$CLIS" | tr ',' ' '); do
    case "$cli" in
      claude) npm install -g --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code >/dev/null ;;
      codex) npm install -g --no-audit --no-fund --loglevel=error @openai/codex >/dev/null ;;
      *) echo "unknown CLI $cli: install it by hand" ;;
    esac
  done
fi

step "hush $HUSH_VERSION"
if ! command -v hush >/dev/null 2>&1; then
  curl -fsSL "https://raw.githubusercontent.com/turinglabsorg/hush/$HUSH_VERSION/install.sh" \
    | HUSH_INSTALL_DIR=/usr/local/bin sh -s -- --version "$HUSH_VERSION" >/dev/null
fi
# The vault belongs to the user: every secret of this space is generated and kept there.
runuser -l "$USER_NAME" -c 'hush list >/dev/null 2>&1 || hush init >/dev/null; [ -f "$HOME/.hush/box.pub" ] || hush box init >/dev/null; hush doctor >/dev/null 2>&1 || true'
runuser -l "$USER_NAME" -c 'hush list >/dev/null' || fail "the hush vault of $USER_NAME is not ready"

if [ -n "$DOMAIN" ]; then
  step "https://$DOMAIN (Caddy)"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:4370
}
CADDY
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

if [ "$FIREWALL" = 1 ]; then
  step "firewall"
  ufw allow OpenSSH >/dev/null
  if [ -n "$DOMAIN" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
  ufw --force enable >/dev/null
  ufw status | sed -n '1,12p'
fi

ADDRESS=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<DONE

Ready. From a checkout of Cora on your own computer:

  CORA_DEPLOY_HOST=$USER_NAME@${ADDRESS:-<this machine>} deploy/linux.sh

DONE
[ -n "$DOMAIN" ] && echo "Point $DOMAIN (A record) at this machine's public address; Caddy gets the certificate on its own."
exit 0
