# HTTP 500 после миграции PostgreSQL — runbook

> Статус: **на боевом хосте подтверждено по PM2 (`plittex-erp-out-*.log`)** — причина связана с **владельцем объектов БД и правами роли приложения**.

## Симптомы

- UI и статика открываются, авторизация может работать.
- Массовые **500** на API: `/api/categories`, `/api/accounts`, `/api/docs/registry`, `/api/production/mrp-summary`, и т.д.
- В браузере общий текст: «Внутренняя ошибка сервера».

## Где смотреть причину на сервере (обязательно)

1. Логи приложения под PM2:
   - `pm2 logs <имя_процесса> --lines 200`
   - или файлы из `pm2 show` → `out path` / `error path`.
2. Убедиться, что смотрите **тот процесс**, который обслуживает `erp.plittex.ru` (иногда несколько приложений в PM2).

### Подтверждённые выдержки из лога (боевой сервер, 2026-05-10)

При старте после восстановления дампа:

```text
ERROR: ❌ Ошибка создания системных таблиц: must be owner of table report_runs
```

При обращении к API (типично логин/дашборд):

```text
ERROR: permission denied for table users
```

Ранее (до перезапуска) возможны ошибки вида **`column "is_deleted" does not exist`** / **`column o.is_deleted does not exist`** — это уже **несоответствие схемы дампа версии приложения**, решается миграцией/DDL, а не правами.

### Связка с кодом

- При старте вызывается `initSystemTables()` в **`utils/db_init.js`**: `CREATE INDEX … ON report_runs`, `ALTER TABLE …` по существующим таблицам. Если роль из `.env` **не владелец** таблицы `report_runs` (обычно владелец `postgres`), Postgres отвечает **`must be owner of table`**.
- Запросы к **`users`** (и прочим таблицам) при отсутствии **`GRANT`** дают **`permission denied for table users`**.

**Вывод:** роль приложения (`DB_USER`, например `plittex`) должна быть **владельцем** объектов приложения или иметь достаточные **`GRANT`** на `public` и все нужные таблицы/sequence. После `pg_restore`/`psql` из дампа, собранного от имени `postgres`, объектами часто владеет **`postgres`**.

## Связка конфигурации: `.env` ↔ пул БД

Приложение загружает `.env` из корня проекта и создаёт пул `pg` в `web.js`:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — все должны соответствовать **той базе, куда восстановлен дамп**.

Проверки на сервере (вручную, без публикации секретов):

```bash
cd /path/to/plittex-erp
grep -E '^DB_' .env | sed -E 's/^(DB_PASSWORD=).*/\1***/'
PGPASSWORD='...' psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c '\conninfo' -c '\dt' | head
```

Имя базы в приложении и фактическое имя кластера должны совпасть (например, если данные в **`plittex_erp_surgery`**, а в `.env` указано **`plittex_erp`**, приложение подключится к другой/пустой БД).

## Кодовые точки (для сопоставления со stack trace)

| Endpoint | Файл | Суть |
|----------|------|------|
| `GET /api/categories` | `routes/dictionaries.js` | `SELECT DISTINCT category FROM items ...` |
| `GET /api/accounts` | `routes/finance.js` | Кэш `finance:accounts` + `SELECT * FROM accounts` |
| `GET /api/docs/registry` | `routes/docs.js` | `SELECT ... FROM invoices` (после `authenticateToken`) |
| `GET /api/production/mrp-summary` | `routes/production.js` | `getWhId(pool, 'materials')`, затем большие JOIN по `planned_production`, `items`, `recipes`, `inventory_movements` |

Особый случай **`mrp-summary`**: в `web.js` функция `getWhId` бросает исключение, если в таблице `warehouses` **нет** склада с `type = 'materials'`. Это даёт 500 **только для маршрутов, вызывающих `getWhId`**, если остальное уже работает.

## Расшифровка типовых классов проблем (гипотезы до логов)

1. **Неверный `DB_NAME` / пустая база** — часть или все запросы падают на `relation "... " does not exist`.
2. **Неверные учётные данные / порт / `pg_hba`** — ошибки подключения во всех роутах при первом `pool.query` (часто одинаковый текст в логах для каждого запроса).
3. **Неполный или чужой дамп** — нет ключевых таблиц или расширений (реже; тогда конкретное сообщение в логе Postgres).
4. **Только производственные маршруты** — проверить наличие складов с `type = 'materials'` (и связанные типы), сравнить с ожиданиями кода.

## Исправление на сервере (рекомендуемый порядок)

Подключиться к целевой базе как **суперпользователь Postgres** (`sudo -u postgres psql`). Подставьте имя базы и роль приложения из `.env`.

### Вариант A — передать владение всеми объектами `postgres` роли приложения

Подходит, если владельцем схемы и таблиц после дампа является **`postgres`**, а приложение ходит под **`plittex`**:

```sql
\c plittex_erp_surgery   -- или ваше имя базы из DB_NAME

REASSIGN OWNED BY postgres TO plittex;
```

При необходимости повторите для другого старого владельца (посмотреть владельцев):

```sql
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 20;
```

### Вариант B — не менять OWNER, только выдать права

Менее удобно для `initSystemTables` (нужны права на `ALTER`/`CREATE INDEX` на уже существующих таблицах). Если не переезжать OWNER, проще временно включить DDL от суперпользователя вручную или всё-таки отдать владение **как в варианте A**.

Пример только чтение/использование (часто **недостаточно** для текущего `db_init.js`):

```sql
GRANT CONNECT ON DATABASE your_db TO plittex;
GRANT USAGE ON SCHEMA public TO plittex;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plittex;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plittex;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO plittex;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO plittex;
```

### После прав

```bash
pm2 restart plittex-erp
pm2 logs plittex-erp --lines 30
```

В логе не должно остаться **`must be owner of table report_runs`** и **`permission denied for table users`** (для успешной аутентификации достаточно `SELECT` по `users`).

### Если снова всплывает `column is_deleted does not exist`

Схема дампа старее кода. Нужно применить миграции проекта или вручную добавить столбцы, которые ожидает приложение для соответствующих таблиц (в логах указан алиас `o.` — искать заказы/сущность в SQL дашборда). Без DDL по схеме часть экранов останется с 500.

## План действий (кратко)

1. Подтвердить владельцев таблиц и роль из `.env` (`\conninfo` под приложением vs под `postgres`).
2. **`REASSIGN OWNED`** или эквивалент по вашей политике безопасности.
3. **`pm2 restart`**, контроль старта: нет ошибки `initSystemTables` по `report_runs`.
4. Устранить отдельно **`is_deleted`** по логам, если сохранится.

## Что уже перенести в `postgresql-ubuntu-production.md`

- После восстановления дампа выполнить шаг «владелец объектов = роль из `.env`» или см. приложенный блок в этом файле ниже для дубля в основной инструкции.
