# Współdzielone API BOK dla MasterLink

API MasterLink nie jest osobnym agentem ani stateless mirrorem. Uruchamia się wyłącznie wewnątrz
komendy `run`, czyli w tym samym procesie co Discord i monitor Dakteli. Korzysta z tej samej
instancji `AgentStore`, tego samego `bok-agent.sqlite`, workspace, playbooka, modelu oraz
tożsamości uwierzytelnienia i konfiguracji `CODEX_HOME`. Generate, judge i worker uruchamiają
osobne klienty i nowe wątki inferencji; nie współdzielą ukrytej historii rozmowy modelu.

Oba wejścia dostają tę samą instancję `BokAgentCore`. Core jest właścicielem modelu, playbooka,
czytnika wersjonowanych korekt i profili narzędzi. Profil HTTP jest celowo węższy: read-only,
bez shell/web/apps i z jawnym wyłączeniem każdego MCP odkrytego w wspólnym `CODEX_HOME` lub
workspace; nieznany format konfiguracji MCP blokuje start tego profilu.

Autoryzowany reply lub mention zespołu na Discordzie zapisuje wersjonowaną korektę w
`verified_human_corrections`. Generate wiąże jej konkretną rewizję z operacją, a judge musi użyć
tego samego snapshotu lub kończy fail-closed. Zwykłe `learned_rules` pozostają niezaufanym indeksem.
Nie istnieje drugi plik SQLite, drugi `CODEX_HOME`, osobny unit systemd ani override modelu.

## Kontrakt

- `GET /healthz` — minimalna, nieuwierzytelniona żywotność procesu;
- `GET /v1/bok/runtime` — uwierzytelnione potwierdzenie `runtime=discord-shared`, rewizji wspólnej
  pamięci korekt i rewizji wspólnego playbooka; nie zwraca treści reguł ani sekretów;
- `POST /v1/bok/generate` — kontekst ticketu i zarządzany snapshot rynku;
- `POST /v1/bok/judge` — ten sam kontekst/snapshot oraz draft generatora;
- `POST /v1/bok/actions/dispatch` — opcjonalny, lokalny adapter do tego samego typowanego
  dispatchera, którego używa outbound worker; nie jest trasą Railway → VPS.

Endpointy `/v1/bok/*` wymagają `Authorization: Bearer ...`. Schematy wejścia i wyjścia są strict,
body ma limit 1 MB, odpowiedzi są `no-store`, nie ma CORS ani logowania treści klienta lub błędu
modelu. Port może słuchać wyłącznie na `127.0.0.1` albo `::1`.

Status współdzielonego runtime ma postać:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "provider": "paryskie-bok-agent",
  "runtime": "discord-shared",
  "store": {
    "source": "shared-agent-store",
    "identity": "sha256"
  },
  "corrections": {
    "source": "verified-discord-corrections",
    "revision": 12,
    "activeRules": 12,
    "total": 12,
    "truncated": false
  },
  "playbook": {
    "source": "shared-agent-workspace",
    "revision": "sha256"
  },
  "operationalActionCatalog": {
    "schemaVersion": 2,
    "hash": "sha256"
  },
  "operationalActionDispatch": {
    "schemaVersion": 2,
    "provider": "paryskie-bok-agent",
    "enabled": true,
    "configurationReady": true,
    "identityVerified": true,
    "ready": true,
    "kinds": ["team_escalation"],
    "actionTypes": [
      "finance.verify_payment", "finance.refund", "finance.reconcile",
      "allegro.reply_discussion", "allegro.protect_deadline",
      "complaint.resolve_missing", "complaint.resolve_damaged", "fulfillment.locate",
      "returns.handle_unclaimed", "erp.correct", "wholesale.review", "upsell.add_item",
      "promo.freebie", "catalog.originals", "privacy.unsubscribe",
      "marketing.creator_partnership", "policy.gap", "runtime.bad_draft"
    ],
    "routeKeys": [
      "payments", "allegro", "complaints", "current_affairs", "returns_unreceived",
      "cancelled", "wholesalers", "upsell", "promo", "bok", "originals",
      "unsubscribe", "rufus_bok", "bok_marketing"
    ],
    "delivery": "discord-gateway",
    "receipt": "shared-agent-store"
  }
}
```

`actionTypes` i `routeKeys` zawierają zawsze dokładne, pełne zbiory wynikające z katalogu. Status
nie ujawnia identyfikatorów serwera, kategorii ani kanałów. `ready` jest prawdziwe wyłącznie
wtedy, gdy bramka jest włączona, konfiguracja jest kompletna, Discord jest połączony, a dokładna
tożsamość wszystkich tras została zweryfikowana.

Endpoint nie zwraca statusu gotowości, jeśli snapshot korekt jest ucięty albo wewnętrznie
niespójny. `revision` identyfikuje mutację pełnego snapshotu, a `total` musi być zgodne z
`activeRules`; treści korekt nie opuszczają runtime. Hashe są sygnałem zmiany i tożsamości źródła,
nie zawierają treści pamięci. Sam `/healthz` nie
wystarcza MasterLinkowi do uznania, że połączył się z właściwym agentem.
MasterLink musi również porównać `operationalActionCatalog` z własnym, przypiętym kontraktem;
inna wersja lub hash oznacza brak gotowości do bezpiecznej obsługi akcji.

## Typowane propozycje działań

Generator może zwrócić najwyżej jedną jawną propozycję `operationalActionRequest` schema v2:

```json
{
  "schemaVersion": 2,
  "actionType": "order.stop",
  "factKeys": ["order.id", "order.status"]
}
```

Niezależny judge może zwrócić osobną decyzję tylko dla dokładnie tego samego typu akcji:

```json
{
  "schemaVersion": 2,
  "actionType": "order.stop",
  "verdict": "approve",
  "reasonCodes": ["facts_verified", "intent_match"]
}
```

Każdy `factKey` musi występować w `verifiedFacts` oraz `usedFactKeys`. Brak requestu lub decyzji,
różnica typu, niezgodna intencja albo brak faktu oznacza brak zatwierdzonej akcji. Model nie zwraca
`factsHash`, `handling`, `logicalDestination`, `orderRequired`, routingu, kanału, odbiorcy ani treści
zadania. Akcji nie wolno rekonstruować z `body`, `internalNote` ani `nextActions`. MasterLink
wylicza hash aktualnych faktów i rozstrzyga wykonawcę według własnego, przypiętego katalogu; akcje
MasterLink, w tym `order.stop`, nigdy nie są zamieniane na wiadomości Discord.

## Wiedza i bezpieczeństwo

- fakty konkretnego klienta i zamówienia pochodzą wyłącznie z `verifiedFacts` ML;
- opcjonalne `context.operatorGuidance` jest wiązane hashem z dokładną rewizją ticketu i trafia
  identycznie do generate oraz judge; to decyzja tylko tej sprawy, nie fakt, globalna reguła ani
  dowód wykonania;
- wspólny `BOK_PLAYBOOK.md` jest główną polityką procesu Discord + ML;
- `knowledgeSnapshot` ML jest wersjonowanym dodatkiem rynku; konflikt ze wspólnym playbookiem
  kończy się decyzją człowieka, nie zgadywaniem;
- wyłącznie korekty z autoryzowanego reply/mention na Discordzie trafiają do
  `verified_human_corrections` i wpływają na następne generacje; zwykłe `learned_bok_rules`
  pozostają niezaufaną pamięcią pomocniczą;
- kontekst katalogowy i wiadomości klienta pozostają niezaufanymi danymi;
- generator nie ma portów zapisu; shell, unified exec, multi-agent, web, obrazy i apps są
  wyłączone, sandbox jest read-only, sieć narzędzi modelu wyłączona;
- zapis, idempotencja i wysyłka odpowiedzi pozostają po stronie MasterLinka.

## Typowany dispatch eskalacji zespołowych

Dispatcher przyjmuje wyłącznie strict envelope schema v2: UUID idempotencji, przypięty
`requestHash`, typ akcji, źródłową rewizję i ustrukturyzowane fakty ticketu/zamówienia. Nie
przyjmuje `destination`, `channelId`, odbiorcy, treści wiadomości, `internalNote` ani
`nextActions`. Typ akcji wyznacza logiczną trasę w zamkniętym katalogu, a konfiguracja procesu
mapuje ją na konkretny kanał. Akcje obsługiwane w MasterLinku są odrzucane.

Wiadomość Discord jest renderowana deterministycznie z etykiety katalogu i typed facts. Ten sam
`DiscordGateway` weryfikuje serwer, kategorię, typ kanału i uprawnienia. Przed wysyłką SQLite
rezerwuje klucz oraz hash całego envelope. Po błędzie transportu dispatcher najpierw szuka
dokładnego proof w docelowym kanale; zgodny proof domyka receipt, a konflikt lub niepewny readback
blokuje resend. Ten zapis przeżywa restart procesu i ten sam klucz z innym payloadem kończy się
fail-closed.

Lokalny `POST /v1/bok/actions/dispatch` jest adapterem testowym/loopback. W topologii produkcyjnej
Railway nie ma trasy przychodzącej do VPS-a. Produkcyjny transport działa więc outbound: ten
proces pobiera trwałe joby z MasterLinka i przekazuje ich exact typed envelope bezpośrednio do
tej samej instancji dispatchera. Samo wystawienie portu loopback nie jest dowodem połączenia E2E.

## Outbound lease/result

Poller korzysta z dedykowanych endpointów `POST /api/bok-runtime/v1/lease`,
`POST /api/bok-runtime/v1/heartbeat` i `POST /api/bok-runtime/v1/result`. Nie używa
credentiali raportu: bot ma osobny `BOK_NATIVE_OUTBOUND_TOKEN`, a MasterLink osobny
`BOK_RUNTIME_PULL_TOKEN`.

Każdy lease przekazuje pełny exact runtime status, losowy identyfikator procesu i czas jego
startu. MasterLink zwraca najwyżej jeden trwały lease na 300 sekund. Po otrzymaniu joba poller
nie pobiera następnego: co 10 sekund wysyła niezależny heartbeat z tą samą tożsamością i
aktualnym runtime statusem, aż terminalny wynik zostanie potwierdzony. Długie generate/judge nie
oznacza więc fałszywego offline:

- `decision` ma jawne etapy `generate → judge`; oba przebiegi używają tej samej instancji
  `NativeBokInference`, tego samego requestu, snapshotu, `contextHash`, `sourceRevision` i
  `operatorGuidanceHash`, a wynik trafia do jednego terminalnego CAS;
- `dispatch` ma jeden etap i wywołuje bezpośrednio tę samą instancję
  `NativeOperationalActionDispatcher`; MasterLink nie wydaje go, gdy exact dispatch readiness
  jest fałszywe.

Poller ponownie wylicza kanoniczne hashe i odrzuca obcy etap, rewizję, kontekst, guidance lub
request przed uruchomieniem modelu/Discorda. Przerywa pracę z marginesem przed końcem lease.
Niepewny `pending` dispatch jest reconciliowany przed kolejną próbą i nigdy nie jest raportowany
jako `completed`; tylko exact `sent` z receiptem może domknąć job. Utracony ACK `/result` ponawia
identyczne body. Strict `409 { error: "lease_lost" }` kończy próbę bez ponownego wykonania akcji,
ale `result_conflict` jest nieretryowalnym błędem spójności, a nie maskowaną utratą lease.
Odpowiedzi sterujące są czytane z twardym limitem rozmiaru. Błędy połączenia mają ograniczony
exponential backoff i nie logują requestu, tokenu ani danych klienta.

## Uruchomienie

W głównym, chronionym pliku ENV runtime ustaw:

```dotenv
BOK_NATIVE_API_ENABLED=true
BOK_NATIVE_API_HOST=127.0.0.1
BOK_NATIVE_API_PORT=8787
BOK_NATIVE_API_TOKEN=<losowy-sekret-minimum-32-znaki>
BOK_NATIVE_API_MAX_CONCURRENCY=2
BOK_NATIVE_API_TIMEOUT_MS=110000

BOK_NATIVE_OUTBOUND_ENABLED=true
BOK_NATIVE_OUTBOUND_URL=https://ml.paryskie.pl
BOK_NATIVE_OUTBOUND_TOKEN=<osobny-sekret-minimum-32-znaki>
BOK_NATIVE_OUTBOUND_POLL_INTERVAL_MS=5000

BOK_AGENT_EXTERNAL_ACTIONS=true
BOK_NATIVE_OPERATIONAL_DISPATCH_ENABLED=true
BOK_NATIVE_DISCORD_GUILD_ID=<id-serwera>
BOK_NATIVE_DISCORD_CATEGORY_ID=<id-kategorii-BOK>
# Uzupełnij komplet BOK_NATIVE_DISCORD_*_CHANNEL_ID z .env.example.
```

Następnie uruchamiaj wyłącznie istniejącą usługę agenta:

```bash
npm ci
npm run verify
npm start -- run
```

Start API, Discorda i workera jest jednym lifecycle. Błąd bindu portu zatrzymuje start runtime;
SIGTERM zamyka monitor, Discord i API. Lokalnego procesu Node nie wystawia się na `0.0.0.0`.
Brama dispatch i outbound connector są niezależne od włączenia lokalnego API. Decision jobs mogą
działać przy wyłączonych akcjach zewnętrznych; dispatch jobs są lease'owane dopiero po pełnym
readiness serwerowych tras Discord.

Bezpieczna kolejność: zweryfikować `/healthz` i uwierzytelniony `/v1/bok/runtime`, porównać zmianę
`store.identity` z procesem Discorda oraz zmianę `corrections.revision` po testowej korekcie
Discorda, uruchomić ML w shadow, następnie approval. Live i
outbox pozostają osobnymi bramkami.
