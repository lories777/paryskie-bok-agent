# Decyzje trwałe

- 2026-08-26: Agent powstaje od zera jako stały pracownik BOK, nie jako poprawka starego
  `AIEMPLOYEE`.
- 2026-08-26: Model działa przez lokalnie zalogowany Codex i subskrypcję ChatGPT, nie przez
  klucz API modelu.
- 2026-08-26: Discord jest miejscem rozmowy i koordynacji. Daktela oraz MasterLink pozostają
  systemami źródłowymi.
- 2026-08-26: Social media są poza pierwszym zakresem.
- 2026-08-26: Discord jest miejscem pracy, nie logiem. Brak potrzebnej reakcji oznacza ciszę.
- 2026-08-26: Agent działa autonomicznie w zakresie zweryfikowanych odczytów i zwykłego prowadzenia
  sprawy. Pyta BOK dopiero przy prawdziwej blokadzie, a odpowiedź może utrwalić jako regułę.
- 2026-08-26: W obecnym teście tylko gotowa wiadomość do klienta ma prostą decyzję „Gotowe/Do
  poprawy”; kliknięcie nie wysyła jej jeszcze do Dakteli.
- 2026-08-26: Connector MasterLink nie używa technicznych identyfikatorów zgody. Po odbiorze live
  jednoznaczne zapisy BOK wykonuje autonomicznie z dry-runem, idempotencją i weryfikacją odczytem.
- 2026-08-26: Numer zamówienia zobowiązuje agenta do użycia właściwego odczytu MasterLink. Nie wolno
  prosić klienta o dane zapisane w zamówieniu ani przerzucać na niego wewnętrznego researchu.
- 2026-08-26: Prośba o sprawdzenie punktu odbioru nie jest prośbą o zmianę. Jeśli ML potwierdza jeden
  ważny punkt i poprawną walidację, agent potwierdza go klientowi i nie zadaje kolejnego pytania.
- 2026-08-26: Korekta draftu od BOK ma w tej samej turze dać nowy kompletny draft. Agent najpierw
  sam sprawdza dostępne źródła; nie utrwala braku wiedzy jako reguły „pytaj BOK”.
- 2026-08-26: Katalog produktów i publiczne procedury Paryskie są lokalną, automatycznie odświeżaną
  bazą agenta. Chrome służy do danych zmiennych, researchu oraz kontrolowanej pracy w Arkuszach Google.
- 2026-08-26: Rola Discord `BOK` może uczyć agenta zwykłą rozmową i oznaczać drafty. Wzmianka
  skierowana wyłącznie do innych pracowników nie jest poleceniem dla agenta.
- 2026-08-27: Wspólny kanał BOK nie jest kolejką poleceń. Agent odpowiada człowiekowi tylko po
  bezpośrednim oznaczeniu albo w odpowiedzi do własnej karty; każde nowe oznaczenie ma osobny kontekst.
- 2026-08-27: Automatyczny ticket trafia na Discord tylko jako gotowy draft albo jedno jawne pytanie
  wymagające decyzji BOK. Puste komunikaty „trzeba sprawdzić” pozostają wewnętrzne.
- 2026-08-26: Komunikat techniczny kontrolera jakości nigdy nie trafia na kanał. Korekta ticketu
  usuwa jego wcześniejsze karty i publikuje wyłącznie aktualny draft albo prawdziwą eskalację.
