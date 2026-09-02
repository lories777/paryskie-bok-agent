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
- `POST /v1/bok/judge` — ten sam kontekst/snapshot oraz draft generatora.

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
    "activeRules": 12
  },
  "playbook": {
    "source": "shared-agent-workspace",
    "revision": "sha256"
  }
}
```

Hashe są sygnałem zmiany i tożsamości źródła, nie zawierają treści pamięci. Sam `/healthz` nie
wystarcza MasterLinkowi do uznania, że połączył się z właściwym agentem.

## Wiedza i bezpieczeństwo

- fakty konkretnego klienta i zamówienia pochodzą wyłącznie z `verifiedFacts` ML;
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

Typed dispatch eskalacji zespołowych przez tę samą tożsamość `DiscordGateway` jest osobnym etapem
cutover. Dopóki nie ma uwierzytelnionego dispatch v2 z serwerowym routingiem i trwałym receiptem w
tym SQLite, sam endpoint inferencji nie oznacza pełnego zastąpienia drugiego bota operacyjnego.

## Uruchomienie

W głównym, chronionym pliku ENV runtime ustaw:

```dotenv
BOK_NATIVE_API_ENABLED=true
BOK_NATIVE_API_HOST=127.0.0.1
BOK_NATIVE_API_PORT=8787
BOK_NATIVE_API_TOKEN=<losowy-sekret-minimum-32-znaki>
BOK_NATIVE_API_MAX_CONCURRENCY=2
BOK_NATIVE_API_TIMEOUT_MS=110000
```

Następnie uruchamiaj wyłącznie istniejącą usługę agenta:

```bash
npm ci
npm run verify
npm start -- run
```

Start API, Discorda i workera jest jednym lifecycle. Błąd bindu portu zatrzymuje start runtime;
SIGTERM zamyka monitor, Discord i API. Wyłączenie `BOK_NATIVE_API_ENABLED` odcina ML bez tworzenia
alternatywnego providera. Dla połączenia między hostami potrzebny jest prywatny tunel HTTPS do
loopbacka; procesu Node nie wystawia się na `0.0.0.0`.

Bezpieczna kolejność: zweryfikować `/healthz` i uwierzytelniony `/v1/bok/runtime`, porównać zmianę
`store.identity` z procesem Discorda oraz zmianę `corrections.revision` po testowej korekcie
Discorda, uruchomić ML w shadow, następnie approval. Live i
outbox pozostają osobnymi bramkami.
