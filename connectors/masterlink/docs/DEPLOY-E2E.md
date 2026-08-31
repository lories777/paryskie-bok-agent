# Wdrożenie E2E: agent VPS1 ↔ MasterLink VPS2

## Topologia

```text
Codex/agent BOK (VPS1)
  └─ MCP stdio: paryskie-bok-agent
       ├─ 127.0.0.1:18787 ──SSH──> 127.0.0.1:<API_ML> (VPS2)
       └─ 127.0.0.1:15432 ──SSH──> 127.0.0.1:<POSTGRES_ML> (VPS2)
```

Na VPS2 nic nie jest wystawiane publicznie. API realizuje odczyty i wszystkie zapisy.
PostgreSQL służy wyłącznie do dokładnego wyszukiwania i dostaje osobną rolę `SELECT`-only.

## Potrzebne wartości

- publiczny IP/DNS VPS2 i port SSH;
- lokalny port API MasterLinka na VPS2 (w repo ML domyślnie `3000`);
- lokalny port PostgreSQL na VPS2 (zwykle `5432`);
- login i hasło konta MasterLink z rolą BOK;
- nazwa bazy, hasło osobnej roli `masterlink_bok_ro`;
- fingerprint klucza hosta SSH VPS2, potwierdzony poza tym połączeniem.

## 1. Przygotuj VPS1

```bash
cd /home/oliwer/workspace/paryskie-bok-agent/connectors/masterlink
./deploy/vps1/install.sh \
  --vps2-host VPS2_IP_LUB_DNS \
  --ssh-port 22 \
  --api-port 3000 \
  --db-port 5432
```

Instalator tworzy dedykowany klucz `~/.ssh/paryskie_bok_to_masterlink`. Prywatnego klucza
nie kopiuj z VPS1. Na VPS2 przenosisz wyłącznie plik `.pub`.

Przed pierwszym połączeniem pobierz klucz hosta i porównaj fingerprint z wartością uzyskaną
innym kanałem od administratora VPS2:

```bash
ssh-keyscan -p 22 VPS2_IP_LUB_DNS > /tmp/masterlink-vps2.hostkey
ssh-keygen -lf /tmp/masterlink-vps2.hostkey
cat /tmp/masterlink-vps2.hostkey >> ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts
```

Nie dopisuj klucza, dopóki fingerprint nie został potwierdzony.

## 2. Ogranicz dostęp na VPS2

Skopiuj na VPS2 publiczny klucz oraz katalog `deploy/vps2`, a potem:

```bash
sudo ./deploy/vps2/install-tunnel-user.sh \
  --public-key ./paryskie_bok_to_masterlink.pub \
  --api-port 3000 \
  --db-port 5432
```

Skrypt tworzy użytkownika, którego klucz może jedynie forwardować połączenia do tych dwóch
portów loopback. Nie daje mu dostępu do sekretów ani danych przez powłokę.

Administrator PostgreSQL na VPS2 tworzy osobną rolę z [create-read-only-role.sql](create-read-only-role.sql)
i ustawia jej hasło poza repo. Zweryfikuj, że API oraz DB nasłuchują na `127.0.0.1`, a nie
na publicznym interfejsie.

## 3. Uruchom tunel na VPS1

```bash
systemctl --user daemon-reload
systemctl --user enable --now paryskie-masterlink-tunnel.service
systemctl --user status paryskie-masterlink-tunnel.service
./bin/check-masterlink-link
```

Jeśli konto usługi nie ma aktywnego user managera po wylogowaniu, administrator VPS1 wykonuje:

```bash
sudo loginctl enable-linger oliwer
```

## 4. Uzupełnij sekrety na VPS1

Edytuj `~/.config/paryskie-bok-agent/masterlink.env` i pozostaw tryb 600:

```dotenv
ML_API_BASE_URL=http://127.0.0.1:18787
ML_USERNAME=KONTO_BOK_LUB_MASZYNOWE_ML
ML_PASSWORD=HASLO
ML_READ_DATABASE_URL=postgresql://masterlink_bok_ro:HASLO_DB@127.0.0.1:15432/masterlink
ML_DB_SSL=false
ML_AUDIT_PATH=/home/oliwer/.local/state/paryskie-bok-agent/masterlink-audit.jsonl
ML_IDEMPOTENCY_DB_PATH=/home/oliwer/.local/state/paryskie-bok-agent/idempotency.sqlite
ML_AUDIT_HASH_KEY=MINIMUM_32_LOSOWE_ZNAKI
ML_MUTATIONS_ENABLED=false
ML_REQUIRE_ENV_FILE_MODE_600=true
```

```bash
chmod 600 ~/.config/paryskie-bok-agent/masterlink.env
ML_ENV_FILE="$HOME/.config/paryskie-bok-agent/masterlink.env" npm run smoke
```

Smoke loguje się do API i wykonuje `SELECT 1` w transakcji READ ONLY. Nie robi zapisu.

## 5. Podłącz Codexa

Wpis z [codex-masterlink.toml](../config/codex-masterlink.toml) dodaj do `~/.codex/config.toml`.
W głównym agencie konfiguracja MCP jest już tworzona programowo. Plik TOML służy jako
samodzielny przykład dla ręcznego uruchomienia Codexa. Ustaw w nim faktyczną ścieżkę projektu
i pliku env, a następnie:

```bash
codex mcp list
```

Odczyty są autonomiczne. Jednoznaczna mutacja BOK nie wymaga technicznej zgody: agent wykonuje
`dry_run`, zapis z `idempotency_key`, kontrolę stanu oraz ponowny odczyt `before/after`.

## 6. Odbiór zapisu

Najpierw pozostaw `ML_MUTATIONS_ENABLED=false` i uruchom mutację z `dry_run=true` na wybranym
zamówieniu testowym. Po sprawdzeniu `before` i przewidywanego `after` ustaw flagę na `true`,
zrestartuj agenta i wykonaj jedną kontrolowaną akcję testową. Connector nie udostępnia
ogólnego zapisu ani SQL-a.

## Szybka diagnostyka

```bash
systemctl --user status paryskie-masterlink-tunnel.service
ssh -G masterlink-vps2 | sed -n '/^hostname /p;/^user /p;/^port /p;/^localforward /p'
ss -lnt | grep -E '127.0.0.1:(18787|15432)'
./bin/check-masterlink-link
ML_ENV_FILE="$HOME/.config/paryskie-bok-agent/masterlink.env" npm run smoke
```

Żadna z tych komend nie wypisuje haseł connectora.
