# Connector MCP BOK ↔ MasterLink

Lokalny serwer MCP dla cyfrowego pracownika BOK Paryskich Perfum. Odczyty działają autonomicznie. Po odbiorze produkcyjnym jednoznaczne operacje BOK również wykonuje agent: najpierw `dry_run=true`, potem zapis z unikalnym `idempotency_key`, a na końcu ponowny odczyt. Connector nadal wymusza flagę środowiskową i dozwolony stan zamówienia.

Projekt nie używa OpenAI API ani klucza OpenAI. Jest narzędziem lokalnego Codexa działającego na subskrypcji ChatGPT.

Docelowe połączenie jest dwumaszynowe: agent i MCP działają na VPS1, a prywatny tunel SSH
forwarduje wyłącznie lokalne porty API oraz PostgreSQL z VPS2. Pełna instrukcja, instalatory
obu stron i test odbiorczy są w [docs/DEPLOY-E2E.md](docs/DEPLOY-E2E.md).

## Lokalizacja i uruchomienie

Kod w tym workspace znajduje się w:

```text
/home/oliwer/workspace/paryskie-bok-agent
```

Docelowa ścieżka wskazana dla VPS-a:

```text
/home/oliwer/workspace/paryskie-bok-agent/connectors/masterlink
```

Budowa i bezpośrednia komenda startowa na VPS-ie:

```bash
cd /home/oliwer/workspace/paryskie-bok-agent/connectors/masterlink
npm ci
npm run build
ML_ENV_FILE=/etc/paryskie-bok-agent/masterlink.env \
  node --disable-warning=ExperimentalWarning /home/oliwer/workspace/paryskie-bok-agent/connectors/masterlink/dist/server.js
```

W praktyce Codex uruchamia tę samą komendę przez [bin/start-masterlink-mcp](bin/start-masterlink-mcp). Transport MCP to stdio: nie ma publicznego endpointu connectora. Osobna usługa użytkownika utrzymuje prywatny tunel VPS1 → VPS2 i automatycznie go wznawia.

## Narzędzia

Odczyt, oznaczony w MCP jako `readOnlyHint=true`:

- `ml_get_order(order_number)`
- `ml_search_orders(email?, phone?, tracking_number?, external_id?)` — dokładne kryteria AND
- `ml_get_payment(order_number)`
- `ml_get_fulfillment(order_number)`
- `ml_get_delivery_details(order_number)` — dokładny punkt odbioru/adres tylko dla aktywnej sprawy BOK
- `ml_get_shipments(order_number)`
- `ml_get_returns_and_refunds(order_number)`
- `ml_get_customer_order_history(customer_identifier)` — pełny e-mail albo telefon
- `ml_query(question, identifiers)` — zwraca paczki faktów; nie generuje odpowiedzi i nie przyjmuje SQL-a

Wąskie mutacje, oznaczone `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`:

- `ml_cancel_order`
- `ml_add_internal_note`
- `ml_start_return`
- `ml_correct_delivery_data`

Nie ma ogólnego `write`, dowolnej zmiany statusu, dowolnego patcha ani surowego SQL. Connector wywołuje istniejące endpointy domenowe MasterLinka, więc po lokalnej walidacji nadal obowiązują walidacje i audyt samego ML.

## Konfiguracja env i sekrety

Skopiuj [.env.example](.env.example) poza repo, uzupełnij istniejącym dostępem do MasterLinka i ustaw tryb 600:

```bash
install -d -m 0700 ~/.config/paryskie-bok-agent ~/.local/state/paryskie-bok-agent
install -m 0600 /home/oliwer/workspace/paryskie-bok-agent/connectors/masterlink/.env.example \
  ~/.config/paryskie-bok-agent/masterlink.env
${EDITOR:-vi} ~/.config/paryskie-bok-agent/masterlink.env
```

Wymagane są:

- `ML_API_BASE_URL`, `ML_USERNAME`, `ML_PASSWORD` — istniejące konto BOK/maszynowe w API;
- `ML_READ_DATABASE_URL` — połączenie do tej samej bazy, używane wyłącznie do dokładnego rozwiązywania numerów, e-maili, telefonów, trackingów i external ID;
- `ML_DB_SSL_CA_FILE` — opcjonalny certyfikat CA przy bezpośrednim TLS do DB; przy tunelu SSH `ML_DB_SSL=false`;
- `ML_AUDIT_HASH_KEY` — niezależny losowy sekret HMAC, minimum 32 znaki;
- ścieżki audytu i idempotencji.

Connector wymusza na każdym połączeniu `default_transaction_read_only=on`, a każde zapytanie wykonuje w `BEGIN READ ONLY` z `statement_timeout`. Zapytania są stałe i parametryzowane. Najmocniejszą barierą jest osobna rola DB z samym `SELECT`; opcjonalny skrypt dla administratora jest w [docs/create-read-only-role.sql](docs/create-read-only-role.sql). Skrypt nie jest dostępny jako narzędzie MCP.

Plik env nie trafia do stdout, odpowiedzi MCP, audytu ani komunikatów błędów. Gdy `ML_ENV_FILE` ma prawa szersze niż 600, proces odmawia startu.

## Konfiguracja Codexa

Gotowy wpis znajduje się w [config/codex-masterlink.toml](config/codex-masterlink.toml). Wklej go do `~/.codex/config.toml` użytkownika usługi agenta, a następnie zrestartuj usługę Codexa/agenta.

Konfiguracja ustawia `default_tools_approval_mode = "approve"` i nie zatrzymuje jednoznacznych operacji na technicznym promptcie Codexa. Serwery stdio mają `command`, `cwd` i env, a politykę można ustawić globalnie dla serwera i per narzędzie.

Weryfikacja po restarcie:

```bash
codex mcp list
```

## Bezpieczne uruchomienie i aktywacja mutacji

Pierwsze wdrożenie zostaw z:

```dotenv
ML_MUTATIONS_ENABLED=false
```

Test połączeń nie wykonuje zapisów:

```bash
cd /home/oliwer/workspace/paryskie-bok-agent
ML_ENV_FILE="$HOME/.config/paryskie-bok-agent/masterlink.env" npm run smoke
```

Przed zmianą flagi na `true`:

1. wykonaj każdą planowaną akcję z `dry_run=true`;
2. sprawdź `before` i przewidywane `after`;
3. sprawdź, że agent nadaje stabilny i unikalny `idempotency_key` z ticketu i intencji;
4. dopiero wtedy ustaw `ML_MUTATIONS_ENABLED=true` i zrestartuj usługę agenta.

Agent nie pyta o zgodę na zwykłe, jednoznaczne działania BOK. Pyta człowieka tylko przy niejednoznacznym zamiarze, wyjątku od zasad albo istotnym ryzyku. Jeśli zapis zwróci timeout/5xx i nie wiadomo, czy doszedł, klucz przechodzi w stan niepewny: automatyczne ponowienie jest blokowane do czasu odczytu i ustalenia rzeczywistego stanu.

## Kontrakt odpowiedzi

Każde narzędzie zwraca JSON z polami:

```json
{
  "found": true,
  "market": "PL",
  "facts": {},
  "timestamps": {},
  "source": {},
  "checked_at": "2026-08-26T12:00:00.000Z",
  "error": null
}
```

- `found=true` — rekord istnieje; puste pole w `facts` ma wartość `null`, a krytyczne braki trafiają też do `missing_fields`;
- `found=false` + `error.code=NOT_FOUND` — pewny brak pasującego rekordu;
- `found=null` — nie da się rozstrzygnąć z powodu walidacji, timeoutu, autoryzacji albo błędu technicznego.

Connector nie zwraca nazwiska, pełnego e-maila, telefonu ani treści notatek. Wyjątkiem jest
`ml_get_delivery_details`, które zwraca dokładny zapisany punkt lub adres wyłącznie po dokładnym
numerze zamówienia, aby agent mógł rozwiązać aktywny ticket. Dane dostawy nie trafiają do audytu.
Identyfikatory wejściowe nie są echowane. Przykłady kontraktu (syntetyczne, bez danych produkcyjnych)
są w [examples/existing-order.json](examples/existing-order.json) i
[examples/not-found-order.json](examples/not-found-order.json).

## Audyt

Audyt JSONL ma tryb 600. Dla każdego poprawnie zwalidowanego wywołania zapisuje czas, nazwę narzędzia, tryb read/dry-run/mutation, wynik, czas trwania, nazwy pól, HMAC identyfikatorów, HMAC pytania/powodu/notatki oraz bezpieczny stan przed/po mutacji. Nie zapisuje wartości identyfikatorów, pytań, powodów, notatek, adresów ani sekretów.

MasterLink prowadzi dodatkowo własny audyt domenowy dla rzeczywistych mutacji. Rejestr SQLite connectora przechowuje wynik idempotencji między restartami.

## Testy

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Testy używają atrap repozytorium i API. Sprawdzają kontrakt MCP, brak PII, rozróżnienie `NOT_FOUND`, skany przesyłek, dry-run, wyłącznik mutacji, autonomiczny zapis bez technicznego identyfikatora zgody, przejścia statusów, idempotencję oraz audyt bez danych osobowych. Nie łączą się z produkcją i nie zmieniają danych ML.
