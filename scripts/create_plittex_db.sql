-- =============================================================================
-- Plittex ERP — роль приложения и пустая база данных
--
-- Перед выполнением замените CHANGE_ME_STRONG_PASSWORD на надёжный пароль
-- и укажите в .env: DB_USER=plittex_app, DB_PASSWORD=…, DB_NAME=plittex_db
--
-- Выполнить, будучи подключены к базе postgres (суперпользователь или роль с правом CREATEDB).
--
-- Пример (Windows):
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -f scripts\create_plittex_db.sql
--
-- Если база plittex_db уже существует — CREATE DATABASE ниже вернёт ошибку; удалите её вручную
-- только если понимаете риск, или временно переименуйте целевую БД в этой команде и в .env.
-- =============================================================================

DO $$
BEGIN
    PERFORM 1 FROM pg_roles WHERE rolname = 'plittex_app';
    IF NOT FOUND THEN
        CREATE ROLE plittex_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
    END IF;
END
$$;

CREATE DATABASE plittex_db
    OWNER plittex_app
    ENCODING 'UTF8'
    TEMPLATE template0;
