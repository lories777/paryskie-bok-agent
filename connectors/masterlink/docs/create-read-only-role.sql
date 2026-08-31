-- OPCJONALNY, ZALECANY hardening konta DB connectora.
-- Uruchamia administrator bazy MasterLinka. Connector ani agent nie mają tego narzędzia.
-- Hasło ustaw przez bezpieczny panel/sekret dostawcy; nie zapisuj go w tym pliku.

BEGIN;

CREATE ROLE masterlink_bok_ro LOGIN;
GRANT CONNECT ON DATABASE masterlink TO masterlink_bok_ro;
GRANT USAGE ON SCHEMA public TO masterlink_bok_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO masterlink_bok_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO masterlink_bok_ro;

ALTER ROLE masterlink_bok_ro SET default_transaction_read_only = on;
ALTER ROLE masterlink_bok_ro SET statement_timeout = '5s';
ALTER ROLE masterlink_bok_ro SET lock_timeout = '2s';

COMMIT;

-- Wykonaj osobno jako właściciel tabel, jeśli connector ma automatycznie widzieć nowe tabele:
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO masterlink_bok_ro;
