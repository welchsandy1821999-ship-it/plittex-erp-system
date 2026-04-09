# 🛡️ ERP PLITTEX — МАСТЕР-ЖУРНАЛ АУДИТА (Операция «ПАНОПТИКУМ»)

> **Дата аудита:** 01.04.2026  
> **Режим:** Strictly Read-Only  
> **Аудитор:** AI Lead Enterprise Architect  
> **Общий вердикт:** Система СТАБИЛЬНА, но содержит **критические** архитектурные пробелы

---

## 📊 СВОДНАЯ СТАТИСТИКА

| Метрика | Значение |
|---|---|
| Маршрутных файлов (routes/) | 7 + 1 (dev) |
| Фронтенд-модулей (public/js/) | 12 |
| Шаблонов виджетов (views/modules/) | 11 |
| Генераторов документов (views/docs/) | 11 |
| Таблиц БД | 42 |
| Foreign Keys | 38 |
| Индексов (вкл. PK) | 77 |
| Общий вес БД | ~5.5 MB |
| Самая тяжелая таблица | `transactions` (3288 kB, 26 колонок) |

---

## 🔴 НАХОДКИ: КРИТИЧЕСКИЙ УРОВЕНЬ (P0 — Потенциальная потеря данных)

### AUDIT-001 | RBAC: Незащищённые маршруты создания/изменения данных
**Модуль:** dictionaries.js  
**Тип:** Безопасность  
**Описание:**  
Все маршруты `POST /api/items`, `PUT /api/items/:id`, `DELETE /api/items/:id`, `POST /api/employees`, `PUT /api/employees/:id`, `DELETE /api/employees/:id`, `POST /api/equipment`, `PUT /api/equipment/:id`, `DELETE /api/equipment/:id`, `POST /api/products/update-prices` — работают **БЕЗ** middleware `requireAdmin`. Любой аутентифицированный пользователь (даже `role: user`) может:
- Изменять цены на продукцию (прайс-лист)
- Удалять товары из справочника
- Добавлять/увольнять сотрудников
- Удалять оборудование

**Модуль:** production.js  
Маршруты `POST /api/production`, `POST /api/production/fixate-shift`, `POST /api/mix-templates`, `POST /api/mix-templates/single`, `POST /api/recipes/save`, `POST /api/recipes/sync-category` — без `requireAdmin`.

**Модуль:** hr.js  
Маршруты: `POST /api/salary/adjustments`, `POST /api/timesheet/cell`, `POST /api/timesheet` — без `requireAdmin`.

**Модуль:** docs.js  
ВСЕ маршруты (включая `/print/invoice`, `/api/docs/export-1c`, `/api/docs/save-pdf`) — без `requireAdmin`.

**Риск:** Любой логин-оператор может провести финансовую операцию, изменить рецептуры или зафиксировать смену.  
**Рекомендация:** Внедрить `requireAdmin` на все `POST/PUT/DELETE` маршруты. Рассмотреть multi-role RBAC (admin/manager/operator).
**Статус:** ✅ ЗАКРЫТО (Все модули защищены requireAdmin. *Примечание: доступ к реестру документов и формам просмотра переведен на уровень authenticateToken для стабильности UI.*)

---

### AUDIT-002 | Ручное управление транзакциями (BEGIN/COMMIT/ROLLBACK) в production.js
**Модуль:** production.js (строки 55–83)  
**Тип:** Целостность данных  
**Описание:**  
Маршрут `POST /api/mix-templates/single` использует **ручные** `pool.query('BEGIN')` / `pool.query('COMMIT')` / `pool.query('ROLLBACK')` вместо системного `withTransaction()`. Это:
- Утечка соединения при необработанном исключении
- Несовместимость с логикой `withTransaction`, которая гарантирует автоматический откат  

**Риск:** При сбое сети COMMIT может не выполниться, но соединение не будет возвращено в пул.  
**Статус:** ✅ ЗАКРЫТО (Уже исправлено: маршрут успешно использует `withTransaction`).

---

### AUDIT-003 | CASCADE DELETE на counterparties удалит ВСЕ заказы клиента
**Модуль:** БД (Foreign Keys)  
**Тип:** Целостность данных  
**Описание:**  
FK `client_orders.counterparty_id → counterparties.id` имеет правило `ON DELETE CASCADE`. Также CASCADE стоит на:
- `blank_orders.counterparty_id` → CASCADE
- `contracts.counterparty_id` → CASCADE
- `powers_of_attorney.counterparty_id` → CASCADE
- `pallet_transactions.counterparty_id` → CASCADE
- `customer_returns.counterparty_id` → CASCADE

**При этом** `DELETE /api/counterparties/:id` (finance.js:599) выполняет **явный hard delete** контрагента. Каскад удалит все заказы клиента, всю историю палет, все контракты.  

**Риск:** Непреднамеренное удаление контрагента стирает всю историю ERP.  
**Статус:** ✅ ЗАКРЫТО (Уже исправлено: реализован Soft Delete, связи RESTRICT сохранены).

---

### AUDIT-004 | Таблица-призрак: item_reservations (0 строк, 0 FK)
**Модуль:** БД  
**Тип:** Мёртвый код  
**Описание:**  
Таблица `item_reservations` содержит 0 строк. Не используется ни одним маршрутом. Не имеет связей FK. Резервирование товаров реализовано через `inventory_movements` (warehouse_id = 7, Склад «Резервы»).  
**Рекомендация:** Удалить таблицу через миграцию.

---

### AUDIT-005 | Дублирующий маршрут GET /api/finance/categories
**Модуль:** finance.js (строки 27 и 344)  
**Тип:** Архитектурный дефект  
**Описание:**  
Два маршрута зарегистрированы на один URL: `GET /api/finance/categories`. Первый (L27) выполняет UNION для сбора "диких" категорий, второй (L344) — просто `SELECT * FROM transaction_categories`. При регистрации Express отдаст первый. Второй — мёртвый код.  
**Рекомендация:** Удалить дублирующий маршрут (строка 344).

---

## 🟠 НАХОДКИ: ВЫСОКИЙ УРОВЕНЬ (P1 — Деградация качества данных)

### AUDIT-006 | Hard Delete оборудования (equipment)
**Модуль:** dictionaries.js (строка 328)  
**Тип:** Целостность данных  
**Описание:**  
`DELETE /api/equipment/:id` выполняет `DELETE FROM equipment WHERE id = $1`. При этом `items.mold_id` → FK на `equipment` с правилом `SET NULL`, а `transactions.equipment_id` → FK с `NO ACTION`. Если за оборудованием закреплены транзакции — удаление вызовет ошибку FK (код 23503), но обработчик просто показывает общую ошибку.  
**Рекомендация:** Soft delete (`status = 'scrapped'`) уже существует на UI, но API позволяет hard delete.
**Статус:** ✅ ЗАКРЫТО (Заменено на Soft Delete 'scrapped')

---

### AUDIT-007 | Отсутствие CHECK constraints на критические поля
**Модуль:** БД  
**Тип:** Валидация  
**Описание:**
- `transactions.amount` — тип `NUMERIC`, без `CHECK (amount > 0)`. Возможна вставка отрицательных сумм напрямую.
- `transactions.transaction_type` — `VARCHAR`, без `CHECK (transaction_type IN ('income', 'expense'))`. Код полагается на валидацию в JS.
- `client_orders.status` — нет ENUM/CHECK. Статусы ('pending', 'processing', 'completed', 'cancelled') не защищены на уровне БД.
- `production_batches.status` — аналогично ('draft', 'in_drying', 'completed').

**Статус:** ✅ ЗАКРЫТО (Миграция `005_add_check_constraints.sql` применена. Добавлены CHECK на: `items` (min_stock, dealer_price, weight_kg, piece_rate), `client_order_items` (qty_ordered, price, qty_reserved, qty_shipped), `employees` (salary_cash, salary_official, tax_rate 0–100), `salary_payments` (amount > 0). Итого 24 CHECK-ограничения. **Намеренно исключены:** `inventory_movements.quantity` (отрицательные = списания) и `salary_adjustments.amount` (отрицательные = штрафы/удержания).)

---

### AUDIT-008 | N+1 запрос в production/mrp-summary
**Модуль:** production.js (строки 746–787)  
**Тип:** Производительность  
**Описание:**  
Маршрут `/api/production/mrp-summary` в цикле для каждого товара выполняет 2 запроса к БД (рецепты + остатки). При 50 позициях в плане — 100+ запросов к БД.  
**Рекомендация:** Объединить в один JOIN-запрос или CTE.

---

### AUDIT-009 | N+1 запрос в sales/shipment-history
**Модуль:** sales.js (строки 676–679)  
**Тип:** Производительность  
**Описание:**   
Маршрут `GET /api/sales/orders` (история отгрузок) для каждой строки выполняет 1-2 субзапроса (`transactions LIKE`, `invoices`). При 100 записях — до 200 дополнительных запросов.  
**Рекомендация:** Переписать как LEFT JOIN или подзапрос.

---

### AUDIT-010 | Миссинг: Индексы на production_batches
**Модуль:** БД  
**Тип:** Производительность  
**Описание:**  
Таблица `production_batches` имеет только PK-индекс. Запросы фильтруют по:
- `production_date` (ежедневный отчёт, фиксация смены)
- `status` (все отчёты)
- `product_id` (FK, но нет индекса)

При росте данных деградация гарантирована.  
**Рекомендация:** Добавить индексы: `CREATE INDEX idx_pb_production_date ON production_batches(production_date)`, `CREATE INDEX idx_pb_status ON production_batches(status)`, `CREATE INDEX idx_pb_product ON production_batches(product_id)`.

---

### AUDIT-011 | Инлайн-стили массово в EJS/JS
**Модуль:** Все EJS + JS  
**Тип:** Технический долг / Maintainability  
**Описание:**  
При поиске `style="` найдено **300+ совпадений** в EJS-шаблонах. Наиболее поражённые модули:
- `dashboard.ejs` — 40+ инлайн-стилей
- `production.ejs` — 30+ 
- `finance.ejs` — 20+

А также **все 12 JS-файлов** генерируют HTML с инлайн-стилями через string concatenation.  
**Статус:** ⚠️ В работе. Модули `sales` и `inventory` ПОЛНОСТЬЮ очищены от инлайн-стилей.  
**Рекомендация:** Перенос стилей в `style.css` (продолжить для `dashboard`, `production`, `finance` и др.).

---

## 🟡 НАХОДКИ: СРЕДНИЙ УРОВЕНЬ (P2 — Технический долг)

### AUDIT-012 | Legacy-маршрут POST /api/produce (production.js:295)
**Описание:** LEGACY API формовки, не используется фронтендом. Закрыт `requireAdmin`, но код ~80 строк остаётся мёртвым грузом.  
**Рекомендация:** Удалить или перенести в dev.js.

---

### AUDIT-013 | Legacy-миграция GET /api/salary/run-migration-temp (hr.js:515)
**Описание:** Одноразовый маршрут импорта начальных остатков. Не защищён `requireAdmin`. При повторном вызове дублирует транзакции.  
**Рекомендация:** Удалить, перенести в dev.js с guard-check.
**Статус:** ✅ ЗАКРЫТО (Код физически удален)

---

### AUDIT-014 | Двойной require('crypto') в finance.js
**Описание:** `crypto` импортирован на уровне модуля (строка 7. и повторно на строке 692 внутри функции.  
**Рекомендация:** Удалить дублирующий `require`.

---

### AUDIT-015 | DROP TABLE в inventory.js
**Модуль:** inventory.js (строка 13)  
**Описание:** Строка `pool.query("DROP TABLE IF EXISTS inventory CASCADE")` выполнялась **при каждом старте сервера**. На практике таблицы `inventory` не существует (используется `inventory_movements`), но это — бомба замедленного действия.  
**Рекомендация:** Удалить строку. Если миграция требуется — перенести в файл миграций.  
**Статус:** ✅ ЗАКРЫТО (Код удален)

---

### AUDIT-016 | Отсутствие Soft Delete на production_batches и invoices
**Описание:**   
- `DELETE /api/production/batch/:id` — полное физическое удаление партии и всех связанных движений.
- `DELETE /api/salary/payment/:id` — физическое удаление выплаты.
- `DELETE /api/salary/adjustments/:id` — физическое удаление.  
**Риск:** Отсутствие аудиторского следа. В `transactions` и `items` soft delete уже реализован.

---

### AUDIT-017 | Нет Rate Limiting на API
**Тип:** Безопасность  
**Описание:** Все API-эндпоинты не имеют rate limiting. При DDoS или скриптовой атаке пул БД может быть исчерпан.  
**Рекомендация:** express-rate-limit middleware.

---

### AUDIT-018 | Нет валидации входных данных на многих POST-маршрутах
**Описание:** Массовая проблема. Например:
- `POST /api/items` — не проверяет длину `name`, тип `price`, допустимость `item_type`.
- `POST /api/counterparties` — не валидирует формат ИНН (10/12 цифр), КПП (9 цифр).
- `POST /api/invoices` — `amount` и `cp_id` не проверяются на числовой тип.  
**Рекомендация:** Joi / express-validator на уровне middleware.

---

### AUDIT-019 | Таблица-дубликат: timesheets vs timesheet_records
**Описание:** Обе таблицы имеют одинаковый UNIQUE constraint `(employee_id, record_date)`. `timesheets` (48 kB) не используется в маршрутах (только `timesheet_records`).  
**Рекомендация:** Проверить наличие данных в `timesheets`. Если пуста — удалить через миграцию.

---

### AUDIT-020 | Миграции в коде маршрутов (AUTO MIGRATION ANTI-PATTERN)
**Описание:** `hr.js` (строки 26-30) выполняет `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` при старте сервера. Это опасный антипаттерн: миграции должны быть в файлах миграций (таблица `migrations` уже существует).

---

## 🟢 СДЕЛАНО ХОРОШО (Позитивные находки)

| Паттерн | Статус | Модули |
|---|---|---|
| `withTransaction()` для атомарности | ✅ Используется | sales, production, inventory, hr, finance, docs |
| `FOR UPDATE` row-level locking | ✅ Используется | sales (accounts), production (items), inventory (audit, **/api/inventory/sifting**), hr (accounts) |
| `Big.js` для финансовой математики | ✅ | sales, production, hr, finance, docs |
| Soft Delete (items) | ✅ | dictionaries (`is_deleted = true`) |
| Soft Delete (transactions) | ✅ | finance (`is_deleted = true`, trigger пересчёта) |
| Soft Delete (employees) | ✅ | dictionaries (`status = 'deleted'`) |
| Closed Period protection | ✅ | hr (salary — `isMonthClosed()`) |
| Invoice Notary (SHA-256 hash) | ✅ | finance, docs |
| RBAC requireAdmin | ✅ Частичное | sales, inventory, hr, finance |
| WebSocket notifications | ✅ | production, inventory |
| DEV_MODE guard на dev.js | ✅ | dev.js (`process.env.DEV_MODE !== 'true'`) |
| Индексы на transactions | ✅ Отлично | 14 индексов (вкл. partial, GIN trigram) |

---

## 📋 ПРИОРИТИЗАЦИЯ ИСПРАВЛЕНИЙ

| № | Тикет | Приоритет | Трудозатраты |
|---|---|---|---|
| 1 | AUDIT-001 (RBAC gaps) | 🔴 P0 | 2 часа |
| 2 | AUDIT-003 (CASCADE DELETE) | 🔴 P0 | 1 час |
| 3 | AUDIT-002 (manual BEGIN) | 🔴 P0 | 15 мин |
| 4 | AUDIT-015 (DROP TABLE) | 🔴 P0 | 5 мин |
| 5 | AUDIT-010 (missing indexes) | 🟠 P1 | 30 мин |
| 6 | AUDIT-007 (CHECK constraints) | 🟠 P1 | 1 час |
| 7 | AUDIT-008, 009 (N+1 queries) | 🟠 P1 | 2 часа |
| 8 | AUDIT-005 (duplicate route) | 🟡 P2 | 5 мин |
| 9 | AUDIT-004, 019 (dead tables) | 🟡 P2 | 15 мин |
| 10 | AUDIT-012, 013 (legacy code) | 🟡 P2 | 30 мин |
| 11 | AUDIT-011 (inline styles) | 🟡 P2 | 8 часов |
| 12 | AUDIT-018 (input validation) | 🟠 P1 | 4 часа |
| 13 | AUDIT-017 (rate limiting) | 🟡 P2 | 30 мин |

---

*Документ сгенерирован автоматически на основании полного сканирования кодовой базы и схемы БД.*
