#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Użycie: $0 --vps2-host HOST --api-port PORT --db-port PORT [--ssh-port 22] [--ssh-user masterlink-tunnel]" >&2
  exit 2
}

vps2_host=''
ssh_port='22'
ssh_user='masterlink-tunnel'
api_port=''
db_port=''
while (($#)); do
  case "$1" in
    --vps2-host) vps2_host="${2:-}"; shift 2 ;;
    --ssh-port) ssh_port="${2:-}"; shift 2 ;;
    --ssh-user) ssh_user="${2:-}"; shift 2 ;;
    --api-port) api_port="${2:-}"; shift 2 ;;
    --db-port) db_port="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$vps2_host" && -n "$ssh_user" ]] || usage
[[ "$ssh_port" =~ ^[0-9]+$ && "$api_port" =~ ^[0-9]+$ && "$db_port" =~ ^[0-9]+$ ]] || usage
((ssh_port >= 1 && ssh_port <= 65535 && api_port >= 1 && api_port <= 65535 && db_port >= 1 && db_port <= 65535)) || usage

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
config_dir="$HOME/.config/paryskie-bok-agent"
state_dir="$HOME/.local/state/paryskie-bok-agent"
ssh_include_dir="$HOME/.ssh/config.d"
identity="$HOME/.ssh/paryskie_bok_to_masterlink"

install -d -m 0700 "$config_dir" "$state_dir" "$HOME/.ssh" "$ssh_include_dir" "$HOME/.config/systemd/user"
if [[ ! -f "$identity" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'paryskie-bok-vps1-to-masterlink-vps2' -f "$identity"
fi
chmod 0600 "$identity"
chmod 0644 "$identity.pub"

ssh_config="$ssh_include_dir/masterlink-vps2"
umask 077
{
  echo 'Host masterlink-vps2'
  echo "  HostName $vps2_host"
  echo "  User $ssh_user"
  echo "  Port $ssh_port"
  echo "  IdentityFile $identity"
  echo '  IdentitiesOnly yes'
  echo '  StrictHostKeyChecking yes'
  echo "  UserKnownHostsFile $HOME/.ssh/known_hosts"
  echo '  ExitOnForwardFailure yes'
  echo '  ServerAliveInterval 30'
  echo '  ServerAliveCountMax 3'
  echo '  TCPKeepAlive yes'
  echo "  LocalForward 127.0.0.1:18787 127.0.0.1:$api_port"
  echo "  LocalForward 127.0.0.1:15432 127.0.0.1:$db_port"
} > "$ssh_config"

if [[ ! -f "$HOME/.ssh/config" ]]; then
  printf 'Include ~/.ssh/config.d/*\n' > "$HOME/.ssh/config"
elif ! grep -Eq '^[[:space:]]*Include[[:space:]]+~/.ssh/config\.d/\*' "$HOME/.ssh/config"; then
  echo 'Dodaj na początku ~/.ssh/config: Include ~/.ssh/config.d/*' >&2
fi
chmod 0600 "$HOME/.ssh/config" "$ssh_config"

env_file="$config_dir/masterlink.env"
if [[ ! -f "$env_file" ]]; then
  install -m 0600 "$project_dir/.env.example" "$env_file"
  sed -i "s|/home/oliwer|$HOME|g" "$env_file"
fi

install -m 0644 "$project_dir/deploy/systemd/paryskie-masterlink-tunnel.service" \
  "$HOME/.config/systemd/user/paryskie-masterlink-tunnel.service"

cd "$project_dir"
npm ci
npm run build

echo "OK: przygotowano VPS1. Klucz publiczny do wgrania na VPS2: $identity.pub"
echo "Następnie zweryfikuj fingerprint VPS2, dodaj go do known_hosts i uruchom usługę tunelu."
echo "Sekrety ML wpisz wyłącznie do: $env_file (tryb 600)."
