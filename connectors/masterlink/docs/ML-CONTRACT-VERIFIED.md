# Zweryfikowany kontrakt MasterLinka

Implementację connectora porównano 2026-08-26 ze źródłami MasterLinka w commicie
`59feb8ee5c48952b33d3d69b32846ff6934d9364`.

Używane istniejące trasy domenowe:

- `POST /api/auth/login`, `GET /api/auth/me` — sesja `masterlink_session`;
- `GET /api/orders/:id` — szczegóły zamówienia;
- `GET /api/shipments/:id/tracking-events` — skany kurierskie;
- `POST /api/orders/:id/action` z `action=cancel` — anulowanie przez maszynę stanów ML;
- `POST /api/orders/:id/internal-notes` — notatka wewnętrzna;
- `POST /api/returns` — rejestracja zwrotu i uruchomienie istniejącego procesu korekty;
- `PUT /api/orders/:id` — wąska korekta danych dostawy przed pakowaniem.

Dokładne rozwiązywanie numeru zamówienia, e-maila, telefonu, numeru listu i external ID
korzysta z tabel `orders`, `sources` oraz `shipments`. Connector wykonuje tylko stałe,
parametryzowane `SELECT` w `BEGIN READ ONLY`; rola DB nie dostaje żadnych uprawnień zapisu.

Connector celowo nie implementuje własnej ogólnej zmiany statusu. Anulowanie i zwrot idą
przez istniejące serwisy domenowe ML, dzięki czemu nadal działają jego walidacje przejść,
transakcje, obsługa przesyłki/ERP oraz audyt.
