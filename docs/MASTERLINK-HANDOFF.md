# Handoff do agenta MasterLink

## Kontekst

Na VPS1 działa całodobowy agent BOK Paryskich Perfum. Czyta tickety Dakteli, korzysta z
kontekstu rozmów na Discordzie, przygotowuje odpowiedzi i obecnie wymaga prostego ręcznego
zatwierdzenia draftu. Agent nie wysyła jeszcze wiadomości do klientów.

Connector MCP znajduje się w `connectors/masterlink`. Udostępnia dziewięć odczytów oraz cztery wąskie
operacje: anulowanie, notatkę wewnętrzną, rozpoczęcie zwrotu i korektę danych dostawy. Po odbiorze
połączenia jednoznaczne operacje agent wykonuje samodzielnie przez ograniczone API MasterLink:
dry-run, zapis z idempotency key i ponowny odczyt. PostgreSQL connectora pozostaje bezwarunkowo
tylko do odczytu.

## Zadanie po stronie VPS2 / MasterLink

> Stan 2026-08-26: produkcyjny connector działa już przez API `ml.paryskie.pl` i lokalny relay TLS
> do Railway. Poniższy tunel VPS2 jest wariantem docelowym/fallbackiem, a nie blokadą obecnego agenta.

1. Ustal publiczny adres VPS2, port SSH, lokalny port API MasterLink oraz lokalny port
   PostgreSQL i nazwę bazy.
2. Potwierdź fingerprint klucza hosta SSH VPS2 niezależnym kanałem.
3. Dodaj publiczny klucz z VPS1 jako użytkownika `masterlink-tunnel`, któremu wolno wyłącznie
   forwardować połączenia do wskazanych portów API i PostgreSQL na `127.0.0.1`. Bez powłoki.
4. Zapewnij techniczne konto API z zakresem BOK. Na start musi obsługiwać odczyty; uprawnienia
   zapisu mogą istnieć, ale mutacje po stronie agenta pozostaną wyłączone do osobnego testu.
5. Utwórz osobną rolę PostgreSQL `masterlink_bok_ro` z `default_transaction_read_only=on`,
   dostępem wyłącznie `CONNECT`, `USAGE` i `SELECT`, krótkim timeoutem zapytań i blokad.
6. Zweryfikuj, że API i PostgreSQL nie zostały przez tę pracę wystawione publicznie.
7. Zwróć niejawne dane połączenia bez haseł: host, port SSH, fingerprint hosta, port API,
   port DB, nazwę DB i nazwę użytkownika API. Hasła przekaż bezpiecznie, poza Discordem i repo.

Publiczny klucz VPS1 jest w `/home/oliwer/.ssh/paryskie_bok_to_masterlink.pub`. Prywatny klucz
nigdy nie opuszcza VPS1. Jego fingerprint to
`SHA256:5VWsgp9qboMUze9XJ+xGj2Rcm7qtEyZLyT88u5muwko`.

Autoryzuj dokładnie ten aktualny klucz:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA28xqqa5teq/vE3LlgBewaoVD2fBNd5PGUK6uruIVGI paryskie-bok-vps1-to-masterlink-vps2
```

Klucz dołączony historycznie do ZIP-a ma inny fingerprint i nie pasuje do prywatnego klucza na
tym VPS1. Nie należy go autoryzować.

Po zwrocie parametrów VPS1 uruchamia instalator connectora, weryfikuje fingerprint hosta,
wznawia prywatny tunel jako usługę systemd i wykonuje read-only smoke test. Dopiero zielony smoke
test pozwala włączyć narzędzia MasterLink w agencie BOK. Mutacje pozostają wyłączone do osobnego
dry-runu i jednej kontrolowanej weryfikacji zapisu, a następnie działają autonomicznie w zwykłych,
jednoznacznych sprawach BOK.
