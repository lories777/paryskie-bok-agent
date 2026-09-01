# Paryskie BOK Agent

Stały pracownik BOK działający na VPS. Discord jest rozmową i kolejką zadań, SQLite przechowuje
historię i stan, a lokalny Codex prowadzi trwałą sesję dla każdej rozmowy. Model korzysta z
zalogowanej subskrypcji ChatGPT — projekt nie przyjmuje klucza API OpenAI.

To nie jest autoresponder ostatniej wiadomości. Runtime utrzymuje kontekst sprawy, odróżnia
obserwowane kanały od kanału poleceń i zapisuje proponowane działania do osobnej kolejki.

## Stan v0.1

- agent działa 24/7 jako zwykły uczestnik jednego kanału Discorda;
- można pisać do niego normalnym językiem, bez numerów akcji i komend operacyjnych;
- monitor Dakteli co dwie minuty wykrywa nowe lub zmienione otwarte sprawy i przekazuje je agentowi;
- agent najpierw sam czyta historię, dopasowuje raporty i szuka dostępnych informacji; pyta zespół
  dopiero wtedy, gdy brakuje decyzji, której nie da się uczciwie wywnioskować;
- analiza, pytanie lub gotowy draft pojawiają się bezpośrednio na wspólnym kanale;
- draft jest pokazany w całości w czytelnej karcie i ma proste przyciski `Akceptuj draft`
  oraz `Do poprawy`; decyzję może zapisać wyłącznie użytkownik wpisany jawnie w
  `BOK_AGENT_APPROVER_USER_IDS`; akceptacja managerska jest zapisywana jako feedback, ale nie zmienia
  akcji w zatwierdzone wykonanie i nie tworzy zadania wysyłki, dopóki bezpieczny sender nie jest
  faktycznie dostępny;
- każdy draft przechodzi osobny, read-only przebieg kontroli jakości; niepotwierdzony fakt blokuje
  draft, a błąd czysto redakcyjny może zostać poprawiony automatycznie;
- poprawki przekazuje się zwykłym zdaniem, np. „napisz to krócej” albo „zmień ton na cieplejszy”;
- raporty publikowane przez inne boty na obserwowanych kanałach są częścią wspólnego kontekstu;
- SQLite zachowuje rozmowę, stan i pamięć po restartach;
- bezpośredni connector MasterLink znajduje się w `connectors/masterlink`; główny runtime udostępnia
  wyłącznie dziewięć narzędzi odczytu. Kod connectora zawiera cztery wąskie operacje zapisu, ale nie są
  one obecnie wystawione agentowi, a `ML_MUTATIONS_ENABLED` pozostaje wyłączone. PostgreSQL jest
  bezwarunkowo read-only;
- lokalna baza wiedzy jest budowana z aktualnej strony i WooCommerce (`npm run knowledge:refresh`):
  agent może wyszukiwać produkty, odpowiedniki, nuty, ceny, dostępność, regulamin i procedury;
- Chrome DevTools może być aktywowane niezależną flagą `BOK_AGENT_BROWSER_RESEARCH` wyłącznie
  do inspekcji już otwartych stron i zalogowanych Arkuszy Google. Runtime wystawia tylko listowanie,
  wybór, snapshot, screenshot i oczekiwanie; blokuje nawigację, kliknięcia, formularze, dowolny JS,
  sieć i konsolę. Ogólny dostęp sieciowy Codexa pozostaje wyłączony;
- przyszłe uruchomienie operacji zapisu MasterLink wymaga osobnego kontrolowanego preflightu,
  dry-runu, idempotencji i weryfikacji ponownym odczytem; nie jest częścią bieżącego runtime;
- obecny etap obejmuje analizę i drafty. Wysyłka z Dakteli czeka na idempotentny connector,
  potwierdzony readback oraz osobny kontrolowany test konta Contact Centre z licencją Email.

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

Bot Discord korzysta z API Discorda, a późniejsze narzędzia będą korzystały z systemów
źródłowych. Ograniczenie „bez API” dotyczy modelu: rozumowanie wykonuje zalogowany Codex w ramach
subskrypcji, nie wywołania rozliczane kluczem OpenAI API.

## Granice

Odczyt MasterLink jest aktywny, natomiast narzędzia zapisu pozostają wyłączone. Odpowiedzi Daktela
nadal są draftami. `BOK_AGENT_EXTERNAL_ACTIONS` ma pozostać `false`. Przycisk `Akceptuj draft`
zapisuje wtedy wyłącznie ocenę managera do dalszego uczenia i ręcznego użycia: nie ustawia statusu
wykonania i nie tworzy joba wysyłki. Niezależna flaga `BOK_AGENT_BROWSER_RESEARCH=true` może w tym
samym czasie pozostawić agentowi autonomiczne odczyty Chrome.

Ten runtime i jego flaga nie sterują starszym bridge'em BOK działającym obok. Audyt z
2026-09-01 potwierdził, że legacy bridge raportował jednocześnie `agentEnabled=true` oraz
`writebackEnabled=true`, mimo że outbox/live-send głównego MasterLinka były wyłączone. Traktuj go
jako osobną ścieżkę zapisu: nie wdrażaj tej gałęzi, nie zmieniaj jego flag i nie uruchamiaj pilota,
dopóki operator nie wyłączy lub nie odizoluje legacy writebacku i nie potwierdzi tego ponownym
odczytem statusu. Stan bezpieczny jednego komponentu nie jest dowodem stanu całego systemu.

Samo ustawienie flagi na `true` nie odblokowuje wysyłki `reply_customer` ani `discord_notify`.
Obecny sterownik Chrome
nie ma stabilnego klucza idempotencji ani wiarygodnego readbacku wysłanej treści. Awaria po kliknięciu
„Wyślij”, ale przed zapisem wyniku w SQLite, mogłaby po restarcie spowodować double-send. Dlatego
executor Dakteli kończy taką akcję fail-closed bez otwierania strony wysyłki. Wysyłkę można odblokować
dopiero po wdrożeniu idempotentnego connectora i weryfikacji wyniku ponownym odczytem.

Wyniki pracy i alerty terminalne trafiają najpierw do trwałego outboxa SQLite. Chwilowy błąd
Discorda zapisuje termin kolejnej próby i nie ma limitu, po którym alert zostaje porzucony. Runtime
nie uruchamia ponownie analizy, nie usuwa receipt starej karty bez potwierdzonego delete/404 i wznawia
dostawę po restarcie. Nie zastępuje to idempotencji wysyłki odpowiedzi do klienta.

## Connector MasterLink

Kod connectora oraz pełny zestaw testów znajduje się w `connectors/masterlink`. Produkcyjny odczyt
działa przez chronione konto API oraz osobną rolę PostgreSQL z 41 tabelami tylko do odczytu. Lokalna
usługa utrzymuje wymagany relay TLS do Railway. Raporty ML na Discordzie pozostają wyłącznie
pomocniczym kontekstem; źródłem faktów o konkretnym zamówieniu jest connector.
