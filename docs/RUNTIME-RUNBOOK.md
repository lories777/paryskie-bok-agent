# Runtime BOK — odczyt stanu i naprawa incydentu

Snapshot audytu: 10.09.2026. ML/Gmail działa, native heartbeat jest aktywny, lecz dostęp
SSH do aktualnego procesu nie został potwierdzony. Adres wyjściowy połączeń runtime
z logów ML nie jest wystarczającym dowodem adresu SSH ani konta usługi.

1. Sprawdź `/api/health` ML i commit wdrożenia. Heartbeat native musi być świeży,
   z zgodnymi runtimeIdentity, storeIdentity i pipelineHash. Rewizje i czasy zadań
   odczytuj z `ticket_ai_native_jobs`, nie z samej karty Discorda.
2. W inwentarzu uzupełnij host, login SSH, nazwę usługi, katalog instalacji i ścieżkę
   do chronionego pliku konfiguracji. Nie zapisuj tu tokenów ani kluczy. Dopiero
   potwierdzony dostęp pozwala sprawdzić wersję procesu i jego journal.
3. Błędy `mail_source_*` pochodzą z kanonicznego odczytu ML: unauthorized wskazuje
   uwierzytelnienie/uprawnienie; stale oznacza zmienioną rewizję; binding_invalid
   niezgodność źródła; unavailable problem dostępności. Nie resetuj stale do ponowienia
   dla starej rewizji. Do logu trafia tylko kod, bez treści maila, promptu i tokenu.
4. `native_execution_failed` jest nadal kodem nieznanego wyjątku. Sam kod nie dowodzi
   wyczerpania limitu modelu ani błędnego logowania. Sprawdź proces i etap wykonania.
5. Ponawiaj wyłącznie nadal otwarte sprawy z aktualnym inboundem, bez późniejszej
   odpowiedzi BOK i bez aktualnego gotowego szkicu. Użyj kanonicznego żądania ponownej
   analizy w approval; zachowaj wcześniejsze wyniki dla audytu. Nie resetuj hurtowo
   attempts i nie wysyłaj testowych odpowiedzi do rzeczywistych klientów.
6. Limit manifestu załączników jest częścią pipelineHash. Zmiana z 10 na 20 wymaga
   zgodnej zmiany producenta ML, schematów runtime, kontraktu i pinningu ML oraz
   skoordynowanego wdrożenia. Nie zwiększaj samej tablicy ani nie obcinaj dowodów.
   Całość nadal musi mieścić się w 50 MiB i przejść kontrolę dowodów 1:1.
7. Po wdrożeniu potwierdź wersję działającego procesu, heartbeat, pobranie zadania,
   wynik i kontrolę dowodów. Gotowa propozycja nie jest dowodem wykonania operacji.

Historia: aktualizacja 10.09 usuwa nieaktualne założenia o aktywnym monitorze Dakteli,
braku wysyłki z ML i blokadzie pilota wynikającej ze snapshotu legacy bridge'a z 1.09.

## Wdrożenie limitu 20 plików (przygotowane, jeszcze niewdrożone)

Nowy pipelineHash: `42cc1247ebf440a60d03a236d378ee195035802a5b513d96eda94cd56d9c86ab`.
1. Potwierdź dostęp do aktualnego hosta i wersję usługi. Przygotuj oba artefakty.
2. Wstrzymaj pobieranie nowych zadań native, odczekaj zakończenie aktywnych lease.
3. Wdróż runtime i odpowiadający mu pin oraz producenta źródła w ML w jednym oknie.
4. Potwierdź identyczny hash obu stron i świeży heartbeat, następnie wznów kolejkę.
5. W trybie approval zweryfikuj aktualne źródło sprawy z 13 plikami, pełne pokrycie
   dowodów i wynik zapisany w ML. Nie wysyłaj wiadomości testowych do klienta.
6. W razie wycofania przywróć obie strony do wspólnego poprzedniego hasha.

Walidacja przygotowania: pełne npm run verify, 286 testów PASS. Nadal obowiązują
limity 25 MiB na plik, 50 MiB łącznie i 10 stron PDF na plik.
