# Paryskie BOK Agent

Stały pracownik BOK działający na VPS. Discord jest rozmową i kolejką zadań, SQLite przechowuje
historię i stan, a lokalny Codex prowadzi trwałą sesję dla każdej rozmowy. Model korzysta z
zalogowanej subskrypcji ChatGPT — projekt nie przyjmuje klucza API OpenAI.

To nie jest autoresponder ostatniej wiadomości. Runtime utrzymuje kontekst sprawy, odróżnia
obserwowane kanały od kanału poleceń i zapisuje proponowane działania do osobnej kolejki.

## Kontrola kompletności sprawy klienta — 11 września 2026

Wspólny agent sprawdza również brak odpowiedzi, a nie tylko jakość już napisanego tekstu.
Typowany plan dla uwierzytelnionej sprawy klienta wymaga jednego pełnego szkicu do akceptacji.
Jeśli model go pominie, sam dostaje korektę i uzupełnia wynik w tej samej pętli kontroli jakości.
Szkic opisuje przyszłe działanie; stare reguły dla obietnic bez planu nie usuwają go.
Odczyt ML jest wymagany także przy samym planie i ponownie sprawdzany po korekcie.
Nieudana próba odczytu jest awarią źródła, a nie pominiętym researchem: runtime zgłasza
brak dostępu i nie uruchamia dodatkowej korekty modelu, która powtarzałaby tę samą awarię.
Udany odczyt po wcześniejszej nieudanej próbie nadal pozwala kontynuować analizę.
Po wyczerpaniu korekt niepełna propozycja nie przechodzi do wykonania jako gotowy wynik.
Nie wymusza to odpowiedzi na zadania wewnętrzne ani wiadomości niewymagające działania.

## Stan operacyjny — 10 września 2026

- Gmail jest źródłem poczty w ML; Daktela jest historycznym źródłem, a jej monitor nie
  stanowi aktywnego wejścia produkcyjnej kolejki.
- MasterLink/PostgreSQL przechowuje kanoniczne sprawy, historię, rewizje, drafty,
  wiedzę i outbox. Runtime korzysta ze wspólnego pipeline'u `shared-ml-case-v2`;
  SQLite przechowuje lokalną historię, wskazówki i trwałe potwierdzenia runtime.
- Agent przygotowuje odpowiedź, pytanie do BOK, propozycję operacji albo wynik bez
  potrzeby działania. Generator i niezależny reviewer korzystają z tych samych dowodów.
- Produkcja ML działa w `approval`, z `LIVE_SEND=false`. Po akceptacji pracownika
  odpowiedź może zostać wysłana przez outbox ML/Gmail. `queued` nie oznacza `sent`.
  Wysyłka z panelu i historyczny przycisk feedbacku na Discordzie to różne ścieżki;
  znaczenie decyzji należy potwierdzić w kanonicznym tickecie ML.
- Typowane operacje i eskalacje mają osobne bramki oraz potwierdzenia wykonania.
  Audyt 10.09 wykazał wyłączone workery operacji ML i dispatcher runtime. Gotowy draft
  działania nie oznacza wykonanej zmiany zamówienia ani wysłanego zadania do magazynu.
- Wskazówka dotycząca sprawy pozostaje jej kontekstem. Ogólna wiedza ML ma szkice
  i publikację po sprawdzeniu przez człowieka. Ręczna edycja odpowiedzi w panelu
  zachowuje źródłowy szkic jako materiał do oceny; sama nie publikuje nowej reguły.

Aktualny runtime potwierdzony 10.09: `oliwer@212.127.78.15:22`, katalog
`/home/oliwer/workspace/paryskie-bok-agent`, usługa użytkownika
`paryskie-bok-agent.service`. Odczyt i restart przez `systemctl --user`, logi przez
`journalctl --user -u paryskie-bok-agent.service`. Nie myl tego VPS ze starym hostem.
Procedura wdrożenia: [runbook](docs/RUNTIME-RUNBOOK.md).

## Uruchomienie lokalne

```bash
npm install
npm run check
npm test
codex login status
npm run dev -- local "Kim jesteś i jak będziesz prowadzić sprawy BOK?"
```

Codex powinien zgłosić `Logged in using ChatGPT`. Plik `~/.codex/auth.json`, jeśli jest używany,
jest sekretem: nie kopiuj go do repo ani na Discord.

## Discord

1. Utwórz technicznego bota Discord z intentem `Message Content` i dodaj go tylko do potrzebnych
   kanałów.
2. Skopiuj `.env.example` do chronionego pliku poza repo, np.
   `/home/oliwer/.config/paryskie-bok-agent/env` z prawami `0600`.
3. Ustaw osobno kanały rozmowy, kanały obserwowane oraz allowlistę osób lub roli zespołu BOK.
   Użytkowników uprawnionych do przycisków `Akceptuj draft` i `Do poprawy` wpisz jawnie w
   `BOK_AGENT_APPROVER_USER_IDS`; pusta lista blokuje wszystkie decyzje.
4. Uruchom `npm run start -- run` albo zainstaluj unit z `deploy/` jako usługę użytkownika.

Na kanale używa się zwykłego języka. Jedyna pomocnicza komenda techniczna to:

```text
!bok status
```

Nową zasadę dla przyszłych spraw można przekazać naturalnie, oznaczając bota w kanale poleceń,
np. `@BOK Agent od teraz przy pytaniu o konkretną próbkę od razu wyjaśnij, że próbki są losowe`.
Takie polecenie oraz korekta będąca odpowiedzią do karty bota zapisują pochodzenie i rewizję w tej
samej pamięci, z której korzysta natywne generowanie MasterLink. Zwykła wiadomość bez oznaczenia,
wiadomość z kanału wyłącznie obserwowanego albo autor spoza allowlisty nie może utworzyć zaufanej
reguły. Dokładna treść polecenia jest zapisywana z niezmienną rewizją źródła już przy ingest, niezależnie od
wyniku albo awarii joba modelowego, i jest proceduralnym źródłem dla natywnego BOK. Modelowe
streszczenie może zostać dodane później, ale pozostaje opcjonalnym, niezaufanym indeksem i nie może
zmienić kolejności ludzkich źródeł. Do promptu
nie trafia nazwa ani identyfikator autora. Polecenie nie powinno zawierać danych klienta ani
jednorazowych faktów konkretnego zamówienia. Źródła nie są automatycznie usuwane ani zastępowane:
nowsze może zastąpić starsze wyłącznie wtedy, gdy jego dokładna treść jawnie koryguje ten sam temat;
modelowy indeks nie może ustanowić takiego zastąpienia. Runtime odtwarza po restarcie także kanały
poleceń i odpowiedzi do kart bota, korzystając z tej samej autoryzacji i deduplikacji co ruch live.
Jeżeli pełny zbiór źródeł nie mieści się w bezpiecznym limicie snapshotu, generowanie zatrzymuje się
jawnie zamiast cicho pominąć starszą zasadę.

Bot Discord korzysta z API Discorda, a późniejsze narzędzia będą korzystały z systemów
źródłowych. Ograniczenie „bez API” dotyczy modelu: rozumowanie wykonuje zalogowany Codex w ramach
subskrypcji, nie wywołania rozliczane kluczem OpenAI API.

## Granice

Odczyt faktów ML, przygotowanie draftu, akceptacja odpowiedzi i wykonanie operacji są
oddzielnymi zdarzeniami. Wysyłkę potwierdza outbox ML/Gmail, a operację jej dowód
wykonania. Flaga historycznych zewnętrznych akcji runtime nie zastępuje bramek ML.
Przy diagnozie sprawdzaj bieżący heartbeat, konfigurację aktywnego providera i kanału,
rewizję sprawy oraz potwierdzenia. Snapshot starego bridge'a z 1.09 nie opisuje stanu
po przejściu na Gmail 7.09. Raporty Discorda są kontekstem pomocniczym; źródłem faktów
o zamówieniu pozostaje ML.

## Załączniki w natywnym API BOK

Consumer przyjmuje stary kontrakt bez pól załącznikowych wyłącznie wtedy, gdy każdy
`attachmentCount` wynosi zero. Równolegle obsługuje ścisły `verified-text-v1`: maksymalnie 20
załączników, z czego najwyżej 4 odczytane pliki TXT/CSV, 64 KiB na plik, 12 tys. znaków na plik i
24 tys. znaków łącznie. Tekst musi być NFC, bez znaków sterujących i po redakcji e-maila,
telefonu, IBAN/NRB oraz numeru karty. Pozostaje niezaufaną treścią klienta.

`sourceHash` i `textHash` są wewnętrznym audytem MasterLinka i nie należą do kontraktu promptu.
Każdy obraz, PDF, niepełne pokrycie albo status `unsupported`, `failed` lub `truncated` kończy
request fail-closed przed uruchomieniem Codexa. Ta gałąź jest consumer-first: należy wdrożyć ją
przed producentem MasterLink wysyłającym `verified-text-v1`.

Powyższy `verified-text-v1` dotyczy wyłącznie lokalnych, diagnostycznych endpointów
`/v1/bok/generate` i `/v1/bok/judge`. Produkcyjny outbound decision przyjmuje bieżący carrier
MasterLinka `verified-content-v2` i używa kontraktu `daktela-discord-parity-v1`: exact source z
ML/Gmail (lub historycznej Dakteli), byte/render hash, lokalnych obrazów JPEG/PNG i stron PDF oraz tego samego `BokCodexAgent`
i reviewera co Discord. Szczegóły i readiness są w
[`docs/NATIVE-BOK-API.md`](docs/NATIVE-BOK-API.md).
