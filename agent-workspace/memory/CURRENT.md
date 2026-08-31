# Stan bieżący

Pierwszy pion działa stale jako usługa użytkownika: rozmowa na dedykowanym kanale Discord,
trwała historia w SQLite i jedna sesja Codex na rozmowę.

- Daktela: aktywna, potwierdzona zalogowana sesja Chrome; odczyt bez zatwierdzenia. Konto admin
  jest typu back-office. Osobny użytkownik Contact Centre nie mógł zostać utworzony, bo tenant ma
  wykorzystane licencje Email/Voice/CRM; próba została odrzucona i nie utworzyła konta.
- Monitor Dakteli: co 2 minuty sprawdza osobną kartę kolejki, bierze najwyżej jeden ticket na skan
  i reaguje na nowe albo rzeczywiście zmienione
  tickety. Automaty, spam i sprawy bez działania obsługuje po cichu. Na Discord trafia tylko gotowa
  odpowiedź, niezbędne pytanie albo konkretny krok operacyjny.
- MasterLink: connector MCP działa live — ma 9 odczytów i 4 wąskie zapisy. API działa bezpośrednio,
  a PostgreSQL przez lokalny relay TLS; rola bazy ma 41 tabel do odczytu i zero do zapisu.
  Chroniony env oraz zaszyfrowana kopia mają prawa 0600. Mutacje są włączone po zielonym smoke teście
  i udanym dry-runie bez zapisu; raporty `ai-raporty` i `ml-bok-adm` są tylko kontekstem pomocniczym.
- Odczyt i research są autonomiczne. Gotowy draft BOK oznacza prostym przyciskiem jako gotowy;
  identyfikatory techniczne są ukryte.
- Po uruchomieniu MCP zwykłe, jednoznaczne operacje w MasterLinku są autonomiczne: dry-run, zapis
  z idempotencją i ponowny odczyt. Agent pyta tylko przy niejednoznaczności, wyjątku lub ryzyku.
- Odpowiedzi BOK na pytania agenta mogą zostać zapisane jako uogólnione reguły przyszłej pracy,
  bez danych klientów i numerów spraw.
- Cała discordowa rola `BOK` jest uprawniona do rozmowy, korekt i decyzji o drafcie. Wiadomości
  skierowane wyłącznie do innych pracowników ani zwykła rozmowa na kanale nie uruchamiają agenta.
  Nowe polecenie wymaga oznaczenia agenta, a dalsza korekta odpowiedzi na jego wiadomość.
- Publiczna wiedza Paryskie jest dostępna lokalnie i odświeżana automatycznie: 743 produkty,
  185 kategorii i 59 stron podczas pierwszego pełnego przebiegu. Agent ma wyszukiwarkę produktów,
  procedur i regulaminów oraz Chrome do bieżącego researchu.
- Zalogowane Arkusze Google są dostępne przez Chrome na VPS. Odczyt jest autonomiczny; zapis ma być
  wąski, wynikać z jasnego zadania lub poznanego procesu i być zweryfikowany ponownym odczytem.
  Test utworzenia, wpisu i odczytu przeszedł; plik testowy został przeniesiony do kosza.
- Discord nie pokazuje wewnętrznych blokad kontrolera jakości. Nowszy wynik ticketu zastępuje
  wszystkie poprzednie karty tej sprawy, również gdy został wywołany naturalną korektą BOK.
- Wysyłka do klienta pozostaje za jawnym zatwierdzeniem i dodatkowym preflightem aktywnej sesji
  Contact Centre/Email. Na obecnej sesji runtime zapisze wynik `failed`, bez zmiany ticketu.
