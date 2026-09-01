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
- MasterLink: connector MCP działa live w zakresie 9 odczytów. API działa bezpośrednio, a PostgreSQL
  przez lokalny relay TLS; rola bazy ma 41 tabel do odczytu i zero do zapisu. Kod connectora zawiera
  4 wąskie operacje zapisu, ale główny runtime ich nie udostępnia, a mutacje pozostają wyłączone do
  osobnego kontrolowanego preflightu. Raporty `ai-raporty` i `ml-bok-adm` są tylko kontekstem
  pomocniczym.
- Odczyt i research są autonomiczne. Gotowy draft może oznaczyć wyłącznie użytkownik wpisany jawnie
  w `BOK_AGENT_APPROVER_USER_IDS`; pusta lista blokuje decyzje. `Akceptuj draft` zapisuje wyłącznie
  feedback managerski, nie approval wykonania, i nie kolejkuje ani nie wysyła wiadomości do klienta.
  Identyfikatory techniczne są ukryte.
- Gdy zapis MasterLink zostanie kiedyś osobno odebrany i włączony, każda operacja będzie wymagała
  dry-runu, idempotencji i ponownego odczytu. Obecnie agent przekazuje BOK konkretny krok operacyjny.
- Odpowiedzi BOK na pytania agenta mogą zostać zapisane jako uogólnione reguły przyszłej pracy,
  bez danych klientów i numerów spraw.
- Cała discordowa rola `BOK` może rozmawiać z agentem i przekazywać korekty. Decyzje o drafcie są
  odrębnym uprawnieniem tylko dla jawnej listy approverów. Wiadomości skierowane wyłącznie do innych
  pracowników ani zwykła rozmowa na kanale nie uruchamiają agenta. Nowe polecenie wymaga oznaczenia
  agenta, a dalsza korekta odpowiedzi na jego wiadomość.
- Publiczna wiedza Paryskie jest dostępna lokalnie i odświeżana automatycznie: 743 produkty,
  185 kategorii i 59 stron podczas pierwszego pełnego przebiegu. Agent ma wyszukiwarkę produktów,
  procedur i regulaminów oraz Chrome do bieżącego researchu.
- Zalogowane Arkusze Google są dostępne przez już otwarte strony Chrome na VPS. Bieżąca brama
  browser research wystawia tylko listowanie, wybór, snapshot, screenshot i oczekiwanie. Nawigacja,
  kliknięcia, formularze, JS, sieć, konsola i wszystkie zapisy pozostają technicznie wyłączone.
- Discord nie pokazuje wewnętrznych blokad kontrolera jakości. Nowszy wynik ticketu zastępuje
  poprzednie karty dopiero po potwierdzeniu nowej publikacji. Wyniki i alerty terminalne są trwałym
  outboxem SQLite, więc błąd Discorda nie uruchamia ponownie analizy ani nie gubi karty po restarcie.
- Wysyłka do klienta nie jest podłączona. `BOK_AGENT_EXTERNAL_ACTIONS=false` blokuje wykonanie
  server-side, ale nie blokuje zapisu managerskiej akceptacji. Read-only Chrome ma osobną flagę
  `BOK_AGENT_BROWSER_RESEARCH`, więc research nie wymaga włączania mutacji. Nawet po włączeniu
  flagi zewnętrznych akcji `reply_customer` pozostaje
  fail-closed: sterownik Chrome nie ma klucza idempotencji ani readbacku, więc crash po wysyłce mógłby
  spowodować double-send. Przyszły sender wymaga idempotentnego connectora, ponownego odczytu wyniku,
  osobnego wdrożenia i kontrolowanego testu.
- Osobny legacy bridge nie jest sterowany powyższą flagą. Odczyt statusu 2026-09-01 pokazał w nim
  `agentEnabled=true` i `writebackEnabled=true`, gdy outbox/live-send głównego MasterLinka były OFF.
  Do czasu jawnego wyłączenia lub izolacji tej ścieżki i potwierdzenia readbackiem nie wdrażaj zmian
  ani nie uruchamiaj pilota; nie zmieniaj jego flag z poziomu tego repozytorium.
