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
- draft jest pokazany w całości w czytelnej karcie i ma proste przyciski `Gotowe`
  oraz `Do poprawy`; decyzję może zapisać wyłącznie użytkownik wpisany jawnie w
  `BOK_AGENT_APPROVER_USER_IDS`, a kliknięcie niczego nie wysyła;
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
- Chrome DevTools jest aktywne dla bieżącego researchu i zalogowanych Arkuszy Google; odczyty są
  autonomiczne, a zapis w arkuszu ma być wąski i weryfikowany ponownym odczytem;
- przyszłe uruchomienie operacji zapisu MasterLink wymaga osobnego kontrolowanego preflightu,
  dry-runu, idempotencji i weryfikacji ponownym odczytem; nie jest częścią bieżącego runtime;
- obecny etap obejmuje analizę, drafty i ręczne zatwierdzanie. Wysyłka z Dakteli czeka na konto
  Contact Centre z licencją Email.

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
   Użytkowników uprawnionych do przycisków `Gotowe` i `Do poprawy` wpisz jawnie w
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
nadal są draftami: zatwierdzenie na Discordzie zapisuje wyłącznie decyzję i nie kolejkuje ani nie
wysyła wiadomości. Wysyłkę podłączymy dopiero po dostarczeniu stanowiska Daktela Contact Centre i
osobnym teście bezpiecznego wykonania.

## Connector MasterLink

Kod connectora oraz pełny zestaw testów znajduje się w `connectors/masterlink`. Produkcyjny odczyt
działa przez chronione konto API oraz osobną rolę PostgreSQL z 41 tabelami tylko do odczytu. Lokalna
usługa utrzymuje wymagany relay TLS do Railway. Raporty ML na Discordzie pozostają wyłącznie
pomocniczym kontekstem; źródłem faktów o konkretnym zamówieniu jest connector.
