-- Мягкое отключение учётных записей + ФИО для UI администрирования
-- Применять вручную или через initSystemTables (дубль в utils/db_init.js)

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);

UPDATE users SET is_active = TRUE WHERE is_active IS NULL;
