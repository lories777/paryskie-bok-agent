#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Użycie: sudo $0 --public-key FILE --api-port PORT --db-port PORT [--api-host 127.0.0.1] [--db-host 127.0.0.1]" >&2
  exit 2
}

public_key_file=''
api_host='127.0.0.1'
api_port=''
db_host='127.0.0.1'
db_port=''

while (($#)); do
  case "$1" in
    --public-key) public_key_file="${2:-}"; shift 2 ;;
    --api-host) api_host="${2:-}"; shift 2 ;;
    --api-port) api_port="${2:-}"; shift 2 ;;
    --db-host) db_host="${2:-}"; shift 2 ;;
    --db-port) db_port="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Uruchom jako root przez sudo.' >&2; exit 1; }
[[ -f "$public_key_file" ]] || usage
[[ "$api_host" == '127.0.0.1' && "$db_host" == '127.0.0.1' ]] || {
  echo 'Instalator celowo zezwala tylko na usługi loopback VPS2.' >&2
  exit 1
}
[[ "$api_port" =~ ^[0-9]+$ && "$db_port" =~ ^[0-9]+$ ]] || usage
((api_port >= 1 && api_port <= 65535 && db_port >= 1 && db_port <= 65535)) || usage

public_key=$(tr -d '\r\n' < "$public_key_file")
[[ "$public_key" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh.com)[[:space:]] ]] || {
  echo 'Wymagany publiczny klucz Ed25519.' >&2
  exit 1
}

account='masterlink-tunnel'
account_home='/var/lib/masterlink-tunnel'
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$account_home" --shell /bin/sh "$account"
fi

install -d -o "$account" -g "$account" -m 0700 "$account_home/.ssh"
authorized="$account_home/.ssh/authorized_keys"
touch "$authorized"
chown "$account:$account" "$authorized"
chmod 0600 "$authorized"

managed="restrict,port-forwarding,command=\"/usr/sbin/nologin\",permitopen=\"$api_host:$api_port\",permitopen=\"$db_host:$db_port\" $public_key"
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
grep -Fv -- "$public_key" "$authorized" > "$temporary" || true
printf '%s\n' "$managed" >> "$temporary"
install -o "$account" -g "$account" -m 0600 "$temporary" "$authorized"

echo 'OK: konto tunelowe ma wyłącznie forwarding do wskazanego API i PostgreSQL.'
echo 'Nie zmieniono żadnych danych MasterLinka.'
