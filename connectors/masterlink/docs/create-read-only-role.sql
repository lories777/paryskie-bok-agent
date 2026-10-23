-- Rola DB connectora BOK (tylko odczyt). Uruchamia administrator bazy MasterLinka
-- (produkcja od 22.10.2026: rufus, kontener ml-prod-db, baza `masterlink`).
-- Connector ani agent nie mają tego narzędzia. Hasło generuj na serwerze i przekaż poza
-- Discordem i repo; nie zapisuj go w tym pliku.
--
-- Connector czyta z bazy wyłącznie: orders, sources, shipments
-- (connectors/masterlink/src/masterlink/read-repository.ts). Resztę danych bierze z API ML.
--
-- pg_hba.conf (deploy/prod-rufus/db/pg_hba.conf w repo ML), potem `SELECT pg_reload_conf();`:
--   hostssl  masterlink  masterlink_bok_ro  212.127.78.15/32  scram-sha-256  # agent BOK (VPS paryskie-oliwer)

BEGIN;

CREATE ROLE masterlink_bok_ro LOGIN PASSWORD :'bok_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 10;
GRANT CONNECT ON DATABASE masterlink TO masterlink_bok_ro;
GRANT USAGE ON SCHEMA public TO masterlink_bok_ro;
GRANT SELECT ON TABLE public.orders, public.sources, public.shipments TO masterlink_bok_ro;

ALTER ROLE masterlink_bok_ro SET default_transaction_read_only = on;
ALTER ROLE masterlink_bok_ro SET statement_timeout = '5s';
ALTER ROLE masterlink_bok_ro SET lock_timeout = '2s';
ALTER ROLE masterlink_bok_ro SET idle_in_transaction_session_timeout = '30s';

COMMIT;

-- Uruchomienie (psql podstawia hasło ze zmiennej, nie trafia ono do historii shella):
--   BOK_PW="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-40)"
--   docker exec -i ml-prod-db psql -U postgres -d masterlink -v ON_ERROR_STOP=1 \
--     -v bok_password="$BOK_PW" < create-read-only-role.sql
