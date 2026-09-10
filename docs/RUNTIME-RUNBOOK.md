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
