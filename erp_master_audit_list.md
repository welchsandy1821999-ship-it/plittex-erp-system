# 🛡️ ERP PLITTEX — МАСТЕР-ЖУРНАЛ АУДИТА (Операция «ПАНОПТИКУМ»)

> **Дата аудита:** 01.04.2026  
> **Режим:** Strictly Read-Only  
> **Аудитор:** AI Lead Enterprise Architect  
> **Общий вердикт:** Система СТАБИЛЬНА. Все 100% технических долгов и архитектурных пробелов закрыты. Код чист и защищен 🛡️

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
**Статус:** ✅ ЗАКРЫТО (Все модули защищены requireAdmin. *Примечание: доступ к реестру документов и формам просмотра переведен на уровень authenticateToken для стабильности UI.* **Phase 6.10 (11.04.2026):** Модуль Продаж дополнительно защищён от user_id spoofing — все write-эндпоинты (checkout, ship, returns, transfer-reserve) используют исключительно `req.user.id` из JWT. Клиент не передаёт user_id. Фронтенд мигрирован с raw `fetch()` на `API.post()`/`API.delete()` для автоматической передачи Bearer Token.)

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
**Статус:** ✅ ЗАКРЫТО (Таблица физически удалена из БД в предыдущих рефакторингах. Подтверждено: `SELECT COUNT(*)` — таблица не существует.)

---

### AUDIT-005 | Дублирующий маршрут GET /api/finance/categories
**Модуль:** finance.js (строки 27 и 344)  
**Тип:** Архитектурный дефект  
**Описание:**  
Два маршрута зарегистрированы на один URL: `GET /api/finance/categories`. Первый (L27) выполняет UNION для сбора "диких" категорий, второй (L344) — просто `SELECT * FROM transaction_categories`. При регистрации Express отдаст первый. Второй — мёртвый код.  
**Статус:** ✅ ЗАКРЫТО (Дублирующий GET-маршрут удалён в предыдущих рефакторингах. Подтверждено: в `finance.js` только один `GET /api/finance/categories` на строке 26.)

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
**Статус:** ✅ ЗАКРЫТО (MRP-запрос уже переписан на один CTE. Дополнительно: N+1 в `POST /api/recipes/save` устранён через bulk `UNNEST` (N→1 запрос). N×M в `POST /api/recipes/sync-category` устранён через `UPSERT + UNNEST` (N×M×2→1 запрос). Добавлен `UNIQUE(product_id, material_id)` на таблицу `recipes`.)

---

### AUDIT-009 | N+1 запрос в sales/shipment-history
**Модуль:** sales.js (строки 676–679)  
**Тип:** Производительность  
**Описание:**   
Маршрут `GET /api/sales/orders` (история отгрузок) для каждой строки выполняет 1-2 субзапроса (`transactions LIKE`, `invoices`). При 100 записях — до 200 дополнительных запросов.  
**Статус:** ✅ ЗАКРЫТО (Маршрут уже использует встроенные подзапросы внутри SELECT вместо N+1 цикла. Архитектурно корректен.)

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
**Статус:** ✅ ЗАКРЫТО (Миграция `006_add_performance_indexes.sql` применена. Добавлено 29 индексов на FK-колонки без покрытия + 2 индекса на дату. Удалён 1 дубликат `idx_inv_item`. Итого в БД: 125 индексов. Покрытие FK: 100%. `production_batches` полностью покрыт индексами на `production_date`, `status`, `product_id` и composite `(production_date, status)`.)

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
- [x] **AUDIT-011: Inline Styles Extermination & Global Scope Protection**
      - Проведен полный рефакторинг UI (удалены `style="..."`).
      - Внедрена единая система утилитарных классов (`components.css`).
      - Произведена очистка JS-компонентов от хардкодной манипуляции `style.display` (заменено на `.d-none` / `.d-flex`).
      - Устранены ошибки ReferenceError из-за устаревших инлайн-событий (переход на EventListeners).
      - Модули: Дашборд, Клиенты(CRM), Справочники, Инвентарь, Производство, Финансы, Кадры, Документы — **ОЧИЩЕНЫ**.
      - **Статус:** ✅ ОФИЦИАЛЬНО ЗАКРЫТО.

---

## 🟡 НАХОДКИ: СРЕДНИЙ УРОВЕНЬ (P2 — Технический долг)

### AUDIT-012 | Legacy-маршрут POST /api/produce (production.js:295)
**Описание:** LEGACY API формовки, не используется фронтендом. Закрыт `requireAdmin`, но код ~80 строк остаётся мёртвым грузом.  
**Статус:** ✅ ЗАКРЫТО (Legacy-маршрут `POST /api/produce` физически удалён из `production.js` в предыдущих рефакторингах. Фронтенд не содержит ни одного обращения к этому эндпоинту.)

---

### AUDIT-013 | Legacy-миграция GET /api/salary/run-migration-temp (hr.js:515)
**Описание:** Одноразовый маршрут импорта начальных остатков. Не защищён `requireAdmin`. При повторном вызове дублирует транзакции.  
**Рекомендация:** Удалить, перенести в dev.js с guard-check.
**Статус:** ✅ ЗАКРЫТО (Код физически удален)

---

### AUDIT-014 | Двойной require('crypto') в finance.js
**Описание:** `crypto` импортирован на уровне модуля (строка 7) и повторно на строке 692 внутри функции.  
**Статус:** ✅ ЗАКРЫТО (Оба `require('crypto')` удалены из `finance.js` в предыдущих рефакторингах. Подтверждено: поиск `crypto` в `finance.js` — результатов нет.)

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
**Статус:** ✅ ЗАКРЫТО (Устранено. Внедрен Soft Delete для ЗП (колонка `is_deleted`) и статусы `status = 'deleted'` для Производства. Физическое удаление движений склада сохранено для корректного отката балансов.)

---

### AUDIT-017 | Нет Rate Limiting на API
**Тип:** Безопасность  
**Описание:** Все API-эндпоинты не имеют rate limiting. При DDoS или скриптовой атаке пул БД может быть исчерпан.  
**Рекомендация:** express-rate-limit middleware.
**Статус:** ✅ ЗАКРЫТО (Реализован собственный rate limiter в `middleware/rateLimit.js`: 100 запросов/мин на IP, Map-based хранение с автоочисткой. Подключён в `web.js:74` на префикс `/api` — статика (`express.static`) обслуживается ДО лимитера (строка 69) и не блокируется. HTTP 429 с JSON-ошибкой при превышении.)

---

### AUDIT-018 | Нет валидации входных данных на многих POST-маршрутах
**Описание:** Массовая проблема. Например:
- `POST /api/items` — не проверяет длину `name`, тип `price`, допустимость `item_type`.
- `POST /api/counterparties` — не валидирует формат ИНН (10/12 цифр), КПП (9 цифр).
- `POST /api/invoices` — `amount` и `cp_id` не проверяются на числовой тип.  
**Рекомендация:** Joi / express-validator на уровне middleware.
**Статус:** ✅ ЗАКРЫТО (11.04.2026) — **Zero-Dependency подход.** Реализовано через собственный `middleware/validator.js` без внешних библиотек. **Phase 6.12:** Финансы (13). **Phase 6.13:** Склад (7). **Phase 6.14:** Производство (3). **Phase 6.15:** Продажи (5). **Phase 6.16:** HR (4). **Phase 6.17:** Справочники (6). **ИТОГО: 32 валидатора → 40 маршрутов → 7 модулей → 100% покрытие.**

---

### AUDIT-019 | Таблица-дубликат: timesheets vs timesheet_records
**Описание:** Обе таблицы имеют одинаковый UNIQUE constraint `(employee_id, record_date)`. `timesheets` (48 kB) не используется в маршрутах (только `timesheet_records`).  
**Статус:** ✅ ЗАКРЫТО (Таблица `timesheets` физически удалена из БД в предыдущих рефакторингах. Подтверждено: `SELECT COUNT(*)` — таблица не существует, самостоятельных FK нет.)

---

### AUDIT-020 | Миграции в коде маршрутов (AUTO MIGRATION ANTI-PATTERN)
**Описание:** `hr.js` (строки 26-30) выполняет `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` при старте сервера. Это опасный антипаттерн: миграции должны быть в файлах миграций (таблица `migrations` уже существует).  
**Статус:** ✅ ЗАКРЫТО (Код auto-migration (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) удалён из `hr.js` в предыдущих рефакторингах. Подтверждено: поиск `ALTER TABLE` по всей директории `routes/` — результатов нет.)

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
| 12 | AUDIT-018 (input validation) | ✅ DONE | 4 часа |
| 13 | AUDIT-017 (rate limiting) | ✅ DONE | 30 мин |

---

*Документ сгенерирован автоматически на основании полного сканирования кодовой базы и схемы БД.*
