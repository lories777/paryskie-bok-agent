# Stan bieżący — zweryfikowany 10.09.2026

Źródłem spraw jest MasterLink/PostgreSQL, z pocztą importowaną z Gmail. Daktela jest
źródłem historycznym. Aktywny provider ML to `paryskie-bok-agent`, pipeline
`shared-ml-case-v2`, tryb `approval`, automatyczna wysyłka wyłączona.

Gotowa odpowiedź po akceptacji pracownika jest wysyłana przez ML/Gmail. Stan queued
potwierdza zamiar wysyłki; dopiero sent potwierdza przyjęcie wysyłki przez connector.
Nie przypisuj agentowi odpowiedzi pracownika zaimportowanej ze skrzynki.

Generator i reviewer korzystają z tego samego kontekstu i dowodów załączników.
Własny lokalny SQLite i kanoniczna baza ML pełnią różne role. Rewizja korekt SQLite
równa zero nie oznacza braku opublikowanej wiedzy ML ani wskazówek konkretnej sprawy.
Ręczne poprawki odpowiedzi są przykładami do oceny. Nowa ogólna zasada wymaga
sprawdzenia i publikacji; nie przenoś faktów jednego klienta do zasad globalnych.

Workery operacji ML i dispatcher eskalacji runtime były wyłączone podczas audytu.
Propozycja działania, akceptacja treści, wysłany mail i wykonana operacja to odrębne
stany. Bez potwierdzenia nie twierdź, że magazyn dostał zadanie, wykonano zwrot,
zmieniono adres czy zatrzymano zamówienie.

Adres bieżącego runtime, konto usługi i wdrożony commit wymagają potwierdzenia
w inwentarzu. Stary VPS nie ma już dawnego katalogu ani aktywnej usługi projektu.
Aktualnego commitu procesu nie wolno wywodzić z samego origin/main.
Szczegóły operacyjne: `docs/RUNTIME-RUNBOOK.md` w repo.
