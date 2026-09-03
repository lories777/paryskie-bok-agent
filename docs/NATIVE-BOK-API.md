# Współdzielone API BOK dla MasterLink

API MasterLink nie jest osobnym agentem ani stateless mirrorem. Uruchamia się wyłącznie wewnątrz
komendy `run`, czyli w tym samym procesie co Discord i monitor Dakteli. Korzysta z tej samej
instancji `AgentStore`, tego samego `bok-agent.sqlite`, workspace, playbooka, modelu oraz
tożsamości uwierzytelnienia i konfiguracji `CODEX_HOME`. Produkcyjny outbound decision korzysta
z dokładnie tego samego `BokCodexAgent` co worker Discorda: tego samego promptu, wątku ticketu,
MCP MasterLink, playbooka, korekt, bramek jakości i niezależnego reviewera. Lokalne endpointy
`generate/judge` pozostają węższym kontraktem diagnostycznym i nie reklamują parity decision.

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
  "decisionCapability": {
    "schemaVersion": 2,
    "pipeline": "daktela-discord-parity-v1",
    "pipelineHash": "7c0c38e7e421ae28918dee136e14d58b02cf9174355233606b4f72e1df43241c",
    "attachmentPolicyVersion": "daktela-cdp-evidence-v1",
    "ready": true,
    "components": {
      "sharedEngine": true,
      "daktelaRead": true,
      "masterlinkRead": true,
      "attachmentEvidence": true,
      "independentJudge": true
    }
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

`decisionCapability.ready` jest koniunkcją wszystkich pięciu komponentów. MasterLink może wydać
decision lease wyłącznie dla dokładnej wersji/pipeline/policy/hash i `ready=true`. Sesja Dakteli
jest weryfikowana cyklicznie; każda awaria authenticated read natychmiast wyłącza komponent,
a odzyskanie zalogowanego Chrome przywraca go bez lease'owania testowego ticketu.

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

Każdy lease request przekazuje pełny exact runtime status, stały identyfikator instalacji i czas
startu bieżącego procesu. MasterLink zwraca najwyżej jeden trwały lease na 300 sekund. Po otrzymaniu joba poller
nie pobiera następnego: co 10 sekund wysyła niezależny heartbeat z tą samą tożsamością i
aktualnym runtime statusem, aż terminalny wynik zostanie potwierdzony. Długie generate/judge nie
oznacza więc fałszywego offline:

- `decision` ma jawne etapy `generate → judge`, ale wykonuje je jeden dokładny shared pipeline
  `BokCodexAgent`; model główny i niezależny reviewer dostają te same zweryfikowane obrazy,
  ten sam ticket/store/playbook, `contextHash`, `sourceRevision` i `operatorGuidanceHash`, a wynik
  `NativeBokDecisionResultV3` trafia do jednego terminalnego CAS;
- `dispatch` ma jeden etap i wywołuje bezpośrednio tę samą instancję
  `NativeOperationalActionDispatcher`; MasterLink nie wydaje go, gdy exact dispatch readiness
  jest fałszywe.

Tożsamość shared SQLite jest częścią protokołu, a nie tylko diagnostyką. Poller przypina
`runtime.store.identity` przy starcie procesu i zatrzymuje się fail-closed, jeśli lokalny Store
zmieni się w trakcie pracy. Odpowiedź na `/lease` musi zawierać top-level `provider`,
`runtimeIdentity`, `storeIdentity`, `processStartedAt` i `statusHash` odpowiadające dokładnie
requestowi; sam lease powtarza exact `runtimeIdentity`, `storeIdentity` i `processStartedAt`.
ACK `/heartbeat` zawiera `provider`, `runtimeIdentity`, `storeIdentity` i `statusHash`. Poller nie
uruchomi modelu przed pełnym ACK. Aktywny heartbeat niesie też exact identyfikatory lease i wymaga
`leaseValid=true`; bezpośrednio przed każdym potencjalnie nieodwracalnym dispatch do Discorda
poller powtarza tę kontrolę. Envelope `/result` zawsze niesie top-level
`poller.{instanceId,processStartedAt}` oraz `storeIdentity`; dla decision wynik schema v3 powtarza
tożsamość Store na root, w `provenance` i — jeśli występuje — w `guidanceReceipt`.

MasterLink musi mieć jawnie skonfigurowaną pełną parę pinów
`BOK_RUNTIME_PINNED_RUNTIME_IDENTITY` (UUID instalacji) i
`BOK_RUNTIME_PINNED_STORE_IDENTITY` (SHA-256 wspólnego SQLite). Brak albo błędna para kończy każde
wejście transportu `503 { "ok": false, "error": "runtime_identity_not_configured" }`; pierwszy
przypadkowy heartbeat nie może sam ustalić tych wartości. Kolejne `/lease`, `/heartbeat` i
`/result` z obcą tożsamością zwracają odpowiednio `409 runtime_identity_mismatch` albo
`409 store_identity_mismatch`, a starszy proces tej samej instalacji —
`409 runtime_process_stale`, bez aktualizacji heartbeat-u, przejęcia lease ani zapisania wyniku.
Nie wolno realizować tego jako bezwarunkowego upsertu ostatniego heartbeat-u. Kontrolowana rotacja
wymaga jednoczesnej, audytowanej pary
`BOK_RUNTIME_PINNED_RUNTIME_IDENTITY_POPRZEDNI` +
`BOK_RUNTIME_PINNED_STORE_IDENTITY_POPRZEDNI` i braku aktywnych lease'ów.
`BOK_NATIVE_RUNTIME_IDENTITY` jest stałą UUID instalacji; restart zmienia wyłącznie
`processStartedAt`, nie UUID. Echo po stronie protokołu TS wykrywa niespójny ACK, ale nie zastępuje
serwerowego pinningu. Nieretryowalny konflikt tożsamości kończy pętlę pollera zamiast wpadać w
reconnect loop.

Poller ponownie wylicza kanoniczne hashe i odrzuca obcy etap, rewizję, kontekst, guidance lub
request przed uruchomieniem modelu/Discorda. Przerywa pracę z marginesem przed końcem lease.
Niepewny `pending` dispatch jest reconciliowany przed kolejną próbą i nigdy nie jest raportowany
jako `completed`; tylko exact `sent` z receiptem może domknąć job. Utracony ACK `/result` ponawia
identyczne body. Strict `409 { error: "lease_lost" }` kończy próbę bez ponownego wykonania akcji,
ale `result_conflict` jest nieretryowalnym błędem spójności, a nie maskowaną utratą lease.
Odpowiedzi sterujące są czytane z twardym limitem rozmiaru. Błędy połączenia mają ograniczony
exponential backoff i nie logują requestu, tokenu ani danych klienta.

## Exact Daktela source i dowody załączników

Decision request zawiera serwerowo zbudowany, kanoniczny `source`: zewnętrzny numer i rewizję
ticketu, exact latest inbound activity, kolejkę oraz posortowany manifest maksymalnie 10
nie-inline JPEG/PNG/PDF. `sourceHash` jest SHA-256 surowych pobranych bajtów, a `snapshotHash`
wiąże cały manifest. Bot ponownie otwiera dokładny ticket przez uwierzytelniony Chrome, porównuje
rewizję/event/kolejkę/metadata, pobiera plik tylko przez allowlistowany GET i ponownie hashuje
bajty. Pominięty obsługiwany plik blokuje całą decyzję; techniczne części MIME `text/plain` nie są
udawane jako dowód wizualny i nie blokują.

JPEG/PNG trafiają jako prywatne `local_image`; PDF jest lokalnie renderowany przez Poppler w 144
DPI, maksymalnie 10 stron. Pliki mają losowe nazwy, prawa 0600, sumaryczne limity rozmiaru i są
usuwane w `finally`. Hash renderu jest sprawdzany bezpośrednio przed każdym wywołaniem modelu.
Treść obrazu/PDF jest jawnie oznaczona jako niezaufane dane klienta, nigdy instrukcja. Native i
Discord są serializowane jednym pipeline mutexem, a read-session pozostaje zablokowana od exact
read aż do końca niezależnego reviewera.

Po exact read native zapisuje w shared SQLite immutable binding operacji ML do rewizji źródła
Dakteli. To osobny marker, nie fikcyjny `job` ani sztuczny `last_job_id`. Skan monitora i jego
enqueue ponownie sprawdzają marker we wspólnej transakcji: identyczna aktywność nie tworzy drugiego
runu ani komunikatu Discord, a nowsza rewizja Dakteli nadal staje się realnym jobem. W drugą stronę
istniejący realny job monitora — także odzyskany po dawnym crash-window między ingestem i linkiem —
jest właścicielem source i blokuje równoległą inferencję native. Retry tej samej operacji jest
idempotentny; nowa operacja może odświeżyć zweryfikowane fakty przy tej samej rewizji ticketu ML,
o ile immutable snapshot/event Dakteli pozostają identyczne. Stare rewizje i remapy ticketów kończą
się fail-closed.

Wynik v3 zawiera wyłącznie reviewed customer reply albo stan `blocked`, internal note, reason
codes, pełne attachment receipts/evidence hash oraz hashe provenance narzędzi/polityki/review i
jawną, zgodną na root i w provenance tożsamość wspólnego Store.
Pozostałe akcje są nieegzekwowalnymi podsumowaniami bez targetu/payloadu/routingu. Wskazówka
managera jest po zweryfikowaniu exact source zapisywana immutable i tylko w rozmowie ticketu;
receipt wiąże jej id/hash/ticket/rewizję/tożsamość Store. Nie tworzy globalnej reguły ani joba
Discord. Brak rozmowy monitora w shared SQLite kończy lease retryable fail-closed.

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
BOK_NATIVE_RUNTIME_IDENTITY=<stała-uuid-tej-instalacji>
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
