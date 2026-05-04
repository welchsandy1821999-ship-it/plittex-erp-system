-- =============================================================================
-- ЧАСТЬ Б — выполнить один раз, подключившись к базе plittex_db (не к postgres!)
--
--   psql -U postgres -d plittex_db -f scripts\create_plittex_db_grants.sql
-- или в pgAdmin: выберите базу plittex_db → Query Tool → выполнить этот файл.
-- =============================================================================

ALTER SCHEMA public OWNER TO plittex_app;
