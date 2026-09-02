# Prywatny port inferencji dla natywnego BOK MasterLink

Ten port łączy istniejący mózg `paryskie-bok-agent` z ticketami zarządzanymi przez MasterLink.
Nie jest drugim systemem ticketowym i nie ma prawa zapisu do MasterLinka ani Dakteli.

Podział odpowiedzialności:

- MasterLink składa aktualny kontekst ticketu, zweryfikowane fakty zamówienia i rewizję;
- `paryskie-bok-agent` generuje publiczną odpowiedź, prywatny brief i działania BOK, a następnie
  wykonuje osobny, niezależny judge publicznej odpowiedzi;
- MasterLink ponownie sprawdza rewizję/fakty, zapisuje sugestię albo outbox i kontroluje wysyłkę;
- API agenta nie korzysta z kolejki Discord/Daktela, nie tworzy akcji i nie zapisuje odpowiedzi w
  swojej bazie SQLite. Czyta z niej wyłącznie trwałe reguły wyuczone od BOK.

## Kontrakt HTTP

Serwer udostępnia tylko:

- `POST /v1/bok/generate` z body `{ "context": TicketAiContext, "knowledgeSnapshot": TicketAiKnowledgeSnapshot }`;
- `POST /v1/bok/judge` z body `{ "context": TicketAiContext, "draft": TicketAiGeneratorOutput, "knowledgeSnapshot": TicketAiKnowledgeSnapshot }`;
- `GET /healthz`, dostępny wyłącznie przez loopback tak jak cały proces.

Sukces ma stałą kopertę:

```json
{
  "ok": true,
  "result": {},
  "provider": "paryskie-bok-agent",
  "model": "codex-subscription-managed"
}
```

Generator zwraca dokładnie:

```json
{
  "body": "gotowa odpowiedź",
  "internalNote": "prywatny, zwięzły brief po polsku dla BOK",
  "nextActions": [],
  "intent": "delivery_status",
  "confidence": "high",
  "usedFactKeys": ["order.status"],
  "unverifiedClaims": [],
  "needsHumanReview": false,
  "escalationCode": null
}
```

Judge zwraca dokładnie:

```json
{
  "verdict": "approve",
  "score": 0.98,
  "grounded": true,
  "policyCompliant": true,
  "reasonCodes": ["grounded"]
}
```

Schematy wejścia i wyjścia są strict. `body` jest wyłącznie treścią wysyłaną klientowi.
`internalNote` jest obowiązkowym, prywatnym briefem po polsku (maks. 1200 znaków), a `nextActions`
zawiera maksymalnie pięć krótkich działań dla BOK (maks. 300 znaków każde); pusta lista oznacza brak
dalszej pracy operatora. Żadnego z tych pól nie wolno kopiować do `body`. `contextTruncated` jest
obowiązkowe, `usedFactKeys` może wskazywać wyłącznie klucze obecne w `verifiedFacts`, a treści
klienta są zawsze oznaczone jako niezaufane. Generator oraz judge działają w osobnych, nowych
wątkach Codexa. Judge nie widzi rozumowania generatora ani treści `internalNote`/`nextActions`:
ocenia wyłącznie publiczne `body` oraz metadane jakościowe.

`knowledgeSnapshot` jest obowiązkowym, wersjonowanym playbookiem zarządzanym przez MasterLink.
Generator i judge dostają dokładnie ten sam snapshot. Native API ponownie sprawdza rynek, kanoniczną
kolejność i zakres intencji, dokumenty i ich zakresy, daty obowiązywania, limity 6 dokumentów / 8 tys.
znaków na dokument / 24 tys. bajtów łącznie, SHA-256 każdego dokumentu oraz kanoniczny SHA-256
całego snapshotu. Pusty `documents` jest autorytatywną informacją o braku opublikowanej procedury,
nie sygnałem do fallbacku na lokalny playbook lub pamięć modelu.

## Granice bezpieczeństwa

- proces może związać port wyłącznie do `127.0.0.1` albo `::1`;
- oba endpointy inferencji wymagają dokładnego `Authorization: Bearer ...`;
- token ma minimum 32 znaki i jest porównywany przez hash oraz `timingSafeEqual`;
- request ma limit 1 MB, kontekst 500 tys. znaków, maksymalnie 100 wiadomości, draft 20 tys. znaków
  oraz zarządzany snapshot wiedzy ograniczony do 24 tys. bajtów treści;
- odpowiedzi mają `Cache-Control: no-store`; nie ma CORS ani logowania body/błędów modelu;
- rozłączenie klienta i timeout przerywają trwający przebieg Codexa;
- zwykłe reguły modelu i dane katalogowe pozostają niezaufaną pamięcią pomocniczą; wyłącznie
  autoryzowana odpowiedź do BOK Agenta albo jawny mention w kanale poleceń może utworzyć
  wersjonowaną korektę proceduralną. Taka korekta może w swoim wąskim zakresie poprawić starszą
  procedurę, ale nigdy nie jest faktem klienta, dowodem wykonania operacji ani podstawą mutacji;
- dedykowany `BOK_NATIVE_CODEX_HOME` nie zawiera konfiguracji MCP; shell, unified exec,
  multi-agent, web, obrazy i aplikacje są wyłączone, środowisko hosta nie jest dziedziczone, sandbox
  jest read-only, a sieć narzędzi modelu wyłączona;
- SDK uruchamia proces Codexa z minimalną allowlistą środowiska; token bridge'a oraz sekrety
  Discord/Daktela/MasterLink nie są przekazywane nawet do procesu potomnego;
- native API wymaga osobnego `BOK_NATIVE_CODEX_HOME`, więc nie wczytuje głównego
  `~/.codex/config.toml` ani jego obecnych lub przyszłych MCP;
- API nie wysyła wiadomości i nie wykonuje mutacji nawet wtedy, gdy główny runtime ma włączone
  działania zewnętrzne.

## Konfiguracja i uruchomienie

Najpierw utwórz osobny katalog Codexa i zaloguj w nim subskrypcję. Nie kopiuj do niego głównego
`~/.codex/config.toml` ani całego katalogu `~/.codex`:

```bash
install -d -m 0700 "$HOME/.codex-native-bok"
CODEX_HOME="$HOME/.codex-native-bok" codex login
```

Następnie utwórz osobny, minimalny plik `%h/.config/paryskie-bok-agent/native-api.env` (`0600`). Nie używaj
pliku głównego runtime, bo zawiera token Discorda i dane innych integracji, których ten proces nie
potrzebuje. Ustaw co najmniej:

```dotenv
BOK_NATIVE_API_HOST=127.0.0.1
BOK_NATIVE_API_PORT=8787
BOK_NATIVE_API_TOKEN=<osobny-losowy-sekret-minimum-32-znaki>
BOK_NATIVE_API_MAX_CONCURRENCY=2
BOK_NATIVE_API_TIMEOUT_MS=110000
BOK_AGENT_WORKSPACE=/home/oliwer/workspace/paryskie-bok-agent/agent-workspace
BOK_AGENT_STATE_DIR=/home/oliwer/workspace/paryskie-bok-agent/state
BOK_NATIVE_CODEX_HOME=/home/oliwer/.codex-native-bok
```

Opcjonalne `BOK_NATIVE_API_GENERATOR_MODEL` i `BOK_NATIVE_API_JUDGE_MODEL` pozwalają jawnie
przypiąć dwa modele. Bez nich używany jest `BOK_AGENT_MODEL`, a przy pustej wartości model
zarządzany przez zalogowaną subskrypcję Codex. Stabilna nazwa koperty to wtedy
`codex-subscription-managed`.

Budowa i lokalny start:

```bash
npm ci
npm run verify
npm run start:native-api
```

Unit do instalacji, ale nie do automatycznego włączenia przed testem integracyjnym, znajduje się w
`deploy/paryskie-bok-native-api.service`.

Na wspólnym hoście adapter MasterLink dopuszcza wyłącznie loopback `http://127.0.0.1`,
`http://localhost` albo `http://[::1]`. Dla połączenia między hostami wymagany jest origin HTTPS za
prywatnym reverse proxy lub tunelem. Nie należy wystawiać procesu Node na `0.0.0.0`; proxy ma
przekazywać wyłącznie te dwa endpointy na loopback VPS-a. Token po stronie MasterLinka musi być
przekazany przez wskaźnik nazwy sekretu ENV, nie wpisany do konfiguracji repozytorium.

## Kolejność bezpiecznego uruchomienia

1. Zbudować i uruchomić unit tylko na loopback.
2. Sprawdzić `/healthz`, autoryzację, błędny kontrakt i syntetyczne `generate`/`judge`.
3. Skonfigurować loopback HTTP na wspólnym hoście albo prywatny HTTPS origin między hostami.
4. Włączyć worker MasterLink wyłącznie w `shadow`; wysyłka i mutacje pozostają wyłączone.
5. Po ocenie jakości przejść do `approval`.
6. `live` i outbox włączać osobno, tylko dla jawnej allowlisty intencji i po odbiorze transportu.

Rollback jest niezależny od głównego agenta: wyłączenie `paryskie-bok-native-api.service` zatrzymuje
nowe wywołania, a MasterLink ma pozostać fail-closed bez fallbacku na nieaudytowany provider.
