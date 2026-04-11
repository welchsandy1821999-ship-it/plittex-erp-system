# 📘 ERP PLITTEX — ТЕХНИЧЕСКАЯ ДОКУМЕНТАЦИЯ (Операция «ПАНОПТИКУМ»)

> **Версия:** 1.0.0  
> **Дата:** 01.04.2026  
> **Стек:** Node.js + Express + PostgreSQL + EJS + Socket.IO + Big.js

---

## 1. ОБЗОР СИСТЕМЫ

### 1.1 Назначение
ERP-система для управления производственным предприятием по выпуску тротуарной плитки. Охватывает полный цикл: от закупки сырья до отгрузки готовой продукции клиенту с финансовым учётом.

### 1.2 Архитектура
- **Тип:** Монолитное серверное приложение (SSR + SPA-гибрид)
- **Рендеринг:** EJS-шаблоны на сервере, затем динамическая загрузка данных через `fetch()` на клиенте
- **Реальное время:** Socket.IO для оповещений об обновлении склада
- **Внешние интеграции:** DaData (обогащение контрагентов по ИНН), Telegram Bot API (уведомления)
- **БД:** PostgreSQL 15+ с pg_trgm для fuzzy-поиска

### 1.3 Точка входа (web.js)
```
Конфигурация → Pool (pg) → ERP_CONFIG (vatRate, locale) → COMPANY_CONFIG (реквизиты)
→ withTransaction(pool, cb) — Обёртка для атомарных операций
→ getNextDocNumber(client, prefix) — Генератор уникальных номеров документов
→ getWhId(client, type) — Резолвер ID склада по типу ('materials', 'drying', 'finished', ...)
→ Регистрация маршрутов → Express.listen() + Socket.IO.attach()
```

---

## 2. МОДУЛИ СИСТЕМЫ

### 2.1 📖 Справочники (dictionaries.js)

#### Товары и Сырье (`items`)
- **Типы:** `product` (готовая продукция), `material` (сырье)
- **Ключевые поля:** `current_price`, `dealer_price`, `weight_kg`, `qty_per_cycle`, `piece_rate`, `mold_id`, `mix_main_tpl`, `mix_face_tpl`
- **Soft Delete:** `is_deleted = true` (фильтруется на всех SELECT)
- **Белый список обновления:** PUT использует whitelist-подход из `allowedFields`
- **API:**
  - `GET /api/items` — Пагинация + фильтры (search, item_type, category)
  - `POST /api/items` — Создание
  - `PUT /api/items/:id` — Обновление (whitelist)
  - `DELETE /api/items/:id` → Soft delete
  - `GET /api/products` → Только item_type='product', не удалённые
  - `POST /api/products/update-prices` → Массовое обновление прайса (Big.js)

#### Сотрудники (`employees`)
- **Зарплата:** Двойная система — `salary_cash` (реальная) + `salary_official` (официальная)
- **При создании** автоматически создаётся `counterparty` (Физлицо-Сотрудник) + `account` типа imprest
- **Soft Delete:** `status = 'deleted'` + помечание контрагенти "[УВОЛЕН]"
- **Синхронизация ФИО:** При изменении ФИО обновляются: counterparty.name, account.name

#### Оборудование (`equipment`)
- **Типы:** `machine` (вибропресс), `mold` (форма), `pallets` (поддоны)
- **Амортизация:** `purchase_cost / planned_cycles` → износ за удар
- **ТОиР:** `POST /api/equipment/:id/maintenance` — списание расходов + сброс циклов

---

### 2.2 🏭 Производство (production.js)

#### Жизненный цикл партии
```
[draft] → POST /api/production (status=draft)
    ↓ Черновик: сохраняет состав замесов и цены (production_draft)
    ↓ Дата: принимает `date` из фронтенда (календарь смены) → production_date + movement_date
[draft] → POST /api/production/fixate-shift
    ↓ Фиксация:
    ↓   1. Удаление записей черновика (production_draft)
    ↓   2. Проверка остатков с FOR UPDATE (row-level lock через production_batches)
    ↓   3. Списание сырья (production_expense)
    ↓   4. Приход на сушилку (production_receipt)
    ↓   5. Начисление износа формы/станка/поддонов
    ↓   ⚠️ При нехватке сырья: 400 + JSON {error, details} → UI: красный блок #shift-errors
[in_drying] → POST /api/production/complete (клиентский вызов)
    ↓ Перемещение с сушилки на склад ГП
[completed] → Готово (is_salary_calculated = true после расчёта ЗП)
```

#### Удаление партии (DELETE /api/production/batch/:id)
- **Черновик (draft):** Hard Delete — физическое удаление inventory_movements + production_batches
- **Завершённые:** Soft Delete (`status = 'deleted'`) + откат циклов оборудования + каскадный пересчёт ЗП
- Проверка `is_salary_calculated` + `closed_periods`
- GET-маршруты (history, search, active-dates) фильтруют `status != 'deleted'`

#### Шаблоны замесов
- Хранятся в `settings` (key = 'mix_templates') как JSON
- Двухслойная архитектура: `mix_main_tpl` + `mix_face_tpl` для каждого продукта

#### MRP-модуль (`GET /api/production/mrp-summary`)
- Агрегирует `planned_production` из заказов со статусом `pending`/`processing`
- Рассчитывает потребность по рецептам
- Сопоставляет с остатками на складе сырья → генерирует дефицитный отчёт

---

### 2.3 📦 Склад (inventory.js)

#### Модель данных
Склад реализован через таблицу `inventory_movements` (журнал движений). Нет таблицы «текущие остатки» — баланс всегда вычисляется через `SUM(quantity)`.

#### Типы движений (`movement_type`)
| Тип | Описание | quantity |
|---|---|---|
| `purchase` | Закупка сырья | + |
| `production_expense` | Списание на производство | - |
| `production_draft` | Черновик состава (не влияет на баланс) | 0/+ |
| `production_receipt` | Приход продукции (из производства) | + |
| `transfer` | Перемещение между складами | ±  |
| `scrap` | Списание (порча, утрата) | - |
| `audit_adjustment` | Корректировка по инвентаризации | ± |
| `sales_shipment` | Отгрузка клиенту | - |
| `sales_reserve` | Резервирование (Склад №7) | + (на WH7) / - (с ГП) |
| `sales_unreserve` | Снятие резерва | обратное |
| `customer_return` | Возврат от клиента | + |
| `disposal` | Утилизация | - |

#### Виртуальные склады
| ID | Тип | Название |
|---|---|---|
| 1 | materials | Склад сырья |
| 2 | drying | Сушилка |
| 3 | finished | Склад ГП |
| 7 | reserve | Резервы (виртуальный) |

#### Закупки
- `POST /api/inventory/purchase` — Приход + автоматическое обновление `current_price` товара + создание транзакции расхода
- `PUT /api/inventory/purchase/:id` — Редактирование (откат старых транзакций, запись новых)
- `DELETE /api/inventory/purchase/:id` — Откат (удаление movement + transaction)

#### Аудит (Инвентаризация)
- Использует двухшаговую блокировку: `SELECT id ... FOR UPDATE` (мьютекс), затем `SUM(quantity)` отдельно
- Принимает `auditDate` из фронтенда → `movement_date = COALESCE(auditDate, CURRENT_TIMESTAMP)`
- Фильтрация остатков по дате: `movement_date::date <= auditDate`

#### Стандарт дат
- **Все SELECT-запросы** используют `movement_date` (не `created_at`) для отображения и сортировки
- **Все INSERT-запросы** с backdating принимают дату из фронтенда в поле `movement_date`
- `created_at` сохраняется как аудитный timestamp, но не используется в UI

---

### 2.4 💼 Продажи (sales.js)

#### Жизненный цикл заказа
```
[pending] → POST /api/sales/checkout (requireAdmin, Bearer Token)
    ↓ 1. Валидация остатков
    ↓ 2. Резервирование (sales_reserve → WH7)
    ↓ 3. Создание planned_production (если нехватка)
    ↓ 4. Финансовый расчёт (Big.js): себестоимость, налоги, маржа
    ↓ 5. Создание транзакции дохода (если оплата = 'prepaid')
    ↓ 🛡️ user_id: из JWT-токена (req.user.id), НЕ из payload
[processing] → POST /api/sales/orders/:id/ship (requireAdmin, Bearer Token)
    ↓ Отгрузка частями (qty_to_ship ≤ qty_ordered)
    ↓ Перемещение: WH7 (резерв) → списание
    ↓ Автоматическое обновление qty_shipped, статуса
    ↓ 🛡️ user_id: из JWT-токена (req.user.id), НЕ из payload
[completed] → Полностью отгружен
[cancelled] → Отмена: снятие резервов, удаление planned_production
```

> **ВАЖНО (Phase 6.10):** Все write-эндпоинты модуля Продаж (`checkout`, `ship`, `returns`, `transfer-reserve`) используют `req.user.id` из JWT-токена для всех операций записи в БД. Клиент не передаёт `user_id` в payload. Фронтенд использует `API.post()`/`API.delete()` для автоматической передачи Bearer Token.

#### Интеграция со складом №7 (Резервы)
- При `checkout`: товар перемещается с Склада ГП (WH3) на WH7 через парные движения
- При `ship`: товар списывается с WH7 (type = 'sales_shipment')
- При `delete order`: все резервы возвращаются с WH7 на WH3
- `linked_order_item_id` — связь движений с конкретной позицией заказа

#### Финансовый контроллер
- Себестоимость: средневзвешенная по `inventory_movements.unit_price`
- НДС: `ERP_CONFIG.vatRate` (по умолчанию 20%)
- Маржа: `(revenue - cost) / revenue * 100`

#### Бланк-заказы
- Предварительные заказы без финансовых обязательств
- `POST /api/blank-orders` → `DELETE /api/blank-orders/:id`

---

### 2.5 👤 HR и Зарплата (hr.js)

#### Табель учёта рабочего времени
- **Статусы дня:** `present`, `partial`, `weekend`, `absent`, `sick`, `vacation`
- **Мультипликатор:** `multiplier` (0.0 - 1.0) для неполного дня
- UPSERT через `ON CONFLICT (employee_id, record_date) DO UPDATE`

#### Сдельная зарплата (mass-bonus)
1. Запрос фонда: `SUM(actual_good_qty * piece_rate)` за production_date
2. Распределение по КТУ: `fund * (worker_ktu / total_ktu)`
3. Округление: копейки добавляются первому работнику
4. Пометка партий: `is_salary_calculated = true`

#### Выплаты
- Списание с кассы (balance check через `FOR UPDATE`)
- Автоматическое определение `payment_method` по типу счёта
- Связь с контрагентом для акта сверки
- Удержание подотчёта: параллельная транзакция на imprest-счёт

#### Закрытие периода
- `POST /api/salary/close-month` — фиксация балансов, генерация транзакций "Начисление ЗП"
- `POST /api/salary/reopen-month` — математический откат балансов, удаление автотранзакций, разблокировка
- Защита: `isMonthClosed()` блокирует все операции в закрытом периоде

---

### 2.6 💰 Финансы (finance.js)

#### Учётная модель
- **Метод:** Кассовый (по факту движения денег), с элементами метода начисления (ФОТ из табелей)
- **Триггер пересчёта:** При любом INSERT/DELETE/UPDATE в `transactions` автоматически пересчитываются балансы ВСЕХ счетов:
```sql
UPDATE accounts a SET balance = ROUND(COALESCE((
    SELECT SUM(CASE WHEN transaction_type='income' THEN amount ELSE 0 END) - 
           SUM(CASE WHEN transaction_type='expense' THEN amount ELSE 0 END) 
    FROM transactions t WHERE t.account_id = a.id AND COALESCE(t.is_deleted, false) = false
), 0), 2)
```

#### Отчёт P&L
- **Revenue:** `income` + category = 'Продажа продукции'
- **COGS:** `expense` + cost_group = 'direct' (из `transaction_categories` или `cost_group_override`)
- **OPEX:** `expense` + cost_group = 'opex'
- **CAPEX:** `expense` + cost_group NOT IN ('direct', 'opex')
- **ФОТ:** Справочно, из `timesheet_records` (метод начисления)
- **Маржа:** `netProfit / revenue * 100`

#### Контрагенты (CRM 360°)
- Профиль: `/api/counterparties/:id/profile` — агрегация из:
  - `transactions` (платежи в обе стороны)
  - `client_orders` (отгрузки)
  - `inventory_movements` (поставки сырья)
- Универсальная формула сальдо: `(наши_отгрузки + наши_оплаты) - (их_поставки + их_оплаты)`
- DaData: автоподстановка реквизитов по ИНН

#### Счета на оплату
- Нумерация: `document_counters` (prefix = 'СЧ-26-', auto-increment с проверкой уникальности)
- **Нотариальная защита:** SHA-256 хэш от `номер|дата|сумма|клиент_id`
- Удаление: последний — hard delete + откат счётчика, остальные — `status = 'cancelled'`

#### Авансовые отчёты
- Шаблон: `POST /api/finance/imprest-report`
- Чеки: загрузка через multer (файлы в `/public/receipts/`)
- Каскадные транзакции: расход из кассы → приход на imprest-счёт → расходы по чекам

#### Правила автоматизации
- `transaction_rules` — автоматическое назначение категории/группы затрат по контрагенту
- `dashboard_rules` — маппинг категорий для дашборда себестоимости

---

### 2.7 📄 Документы (docs.js)

#### Генерируемые документы  
| Документ | URL | Метод | Запись в БД |
|---|---|---|---|
| Счет на оплату | `/print/invoice` | GET/POST | ✅ `invoices` |
| Расходная накладная | `/print/waybill` | GET | ❌ |
| УПД | `/print/upd` | GET | ❌ |
| Договор | `/print/contract` | GET | ❌ |
| Спецификация | `/print/specification` | GET | ❌ |
| Бланк заказа | `/print/blank_order` | GET | ❌ |
| Бланк-черновик | `/print/blank_order_draft` | POST | ❌ |
| Паспорт партии | `/print/passport` | GET | ❌ |
| Акт сверки | `/print/act` | GET | ❌ |
| КП | `/print/kp` | POST | ❌ |
| Карточка банка | `/print/requisites` | GET | ❌ |

#### Реестр документов
- `GET /api/docs/registry` — Фильтр по клиенту, дате
- `POST /api/docs/export-1c` — Выгрузка в CommerceML 2.0 XML

#### Ротация файлов
- PDF-файлы сохраняются в `public/saved_docs/`
- Автоматическая ротация: максимум 500 файлов, старые удаляются

---

### 2.8 📈 Дашборд (dashboard.ejs + dashboard.js)

#### Триада себестоимости (Cost Triad)
- **COGS (Прямые):** Транзакции с cost_group = 'direct'
- **OPEX (Косвенные):** cost_group = 'opex'
- **CAPEX:** Всё остальные расходы

#### Капитализация склада (Stock Valuation)
- Агрегация `SUM(quantity * current_price)` по всем складам
- Разбивка по товарам, сортировка по стоимости

#### Глобальный поиск
- По товарам (`items`), контрагентам (`counterparties`), транзакциям (`transactions`)
- Используется pg_trgm для нечёткого поиска

---

### 2.9 🛠️ Dev Mode (dev.js)

**Защита:** `process.env.DEV_MODE !== 'true'` → пустой router + middleware-guard.

| Команда | Описание |
|---|---|
| `POST /unlock-order/:id` | Принудительный unlock заказа |
| `DELETE /transactions/:id` | Hard delete транзакции с откатом оплат и счетов |
| `DELETE /production/:id` | Hard delete партии с откатом циклов и зарплаты |

---

## 3. БЕЗОПАСНОСТЬ

### 3.1 Аутентификация
- JWT (jsonwebtoken) через cookie `token`
- Альтернативно: `Authorization: Bearer <token>` или `?token=<token>`
- Middleware: `authenticateToken` в `middleware/auth.js`

### 3.2 Авторизация (RBAC)
- Два уровня: `user` и `admin`
- `requireAdmin` — middleware проверяющий `req.user.role === 'admin'`
- **Проблема (AUDIT-001):** ЗАКРЫТО — все мутирующие маршруты защищены `requireAdmin`. Модуль Продаж дополнительно защищён от user_id spoofing (Phase 6.10)

### 3.3 Целостность данных
- `withTransaction()` — обёртка над `BEGIN/COMMIT/ROLLBACK` с автоматическим release
- `FOR UPDATE` — row-level locking на критических операциях (баланс счетов, остатки)
- `Big.js` — точная финансовая арифметика (избежание IEEE 754 ошибок)

### 3.4 Входная валидация (AUDIT-018)
- **Архитектура:** Zero-dependency middleware (`middleware/validator.js`), без Joi/express-validator
- **Стандарт ответа ошибки:** `{ error: "Ошибка валидации", details: ["..."] }` — HTTP 400
- **Покрытие:**
  - `validateItem` → `POST /api/items` (name обязательно, price ≥ 0)
  - `validateSalaryAdjustment` → `POST /api/salary/adjustments` (employee_id, amount)
  - `validateTransaction` → `POST /api/transactions` (amount > 0, type, account_id, category)
  - `validateTransactionEdit` → `PUT /api/transactions/:id` (amount > 0, category не пустая)
  - `validateTransfer` → `POST /api/transactions/transfer` (amount > 0, from ≠ to, оба ID)
  - `validateCounterparty` → `POST/PUT /api/counterparties` (name ≥ 2, ИНН 10/12 цифр, КПП 9 цифр, email формат)
  - `validateInvoice` → `POST /api/invoices` (cp_id число, amount > 0)
  - `validateAccount` / `validateAccountEdit` → `POST/PUT /api/accounts` (name непустое, balance ≥ 0)
  - `validateCategory` → `POST /api/finance/categories` (name непустое)
  - `validateCostGroup` → `PUT /api/finance/categories/:id/group` (∈ direct/opex/capex/overhead)
  - `validateCorrection` → `POST /api/counterparties/:id/correction` (amount > 0, type, date)
  - `validatePayment` → `POST .../pay` (account_id обязателен)
  - `validatePurchase` → `POST/PUT /api/inventory/purchase` (itemId, counterparty_id, quantity > 0, price ≥ 0)
  - `validateSifting` → `POST /api/inventory/sifting` (sourceId, sourceQty > 0, outputs массив)
  - `validateScrap` → `POST /api/inventory/scrap, /dispose` (itemId, warehouseId, qty > 0)
  - `validateAudit` → `POST /api/inventory/audit` (warehouseId, adjustments массив с itemId и actualQty ≥ 0)
  - `validateReserveAction` → `POST /api/inventory/reserve-action` (action ∈ release/transfer, itemId, qty > 0)
  - `validateProductionDraft` → `POST /api/production` (date ≤ сегодня, products массив с id и quantity > 0)
  - `validateRecipeSave` → `POST /api/recipes/save` (productId, ingredients массив с materialId и qty > 0)
  - `validateRecipeSync` → `POST /api/recipes/sync-category` (targetProductIds и materials массивы)
  - `validateCheckout` → `POST /api/sales/checkout` (counterparty_id, items массив с id/qty > 0/price ≥ 0)
  - `validateReturn` → `POST /api/sales/returns` (order_id, items массив с id/qty > 0)
  - `validateShipment` → `POST /api/sales/orders/:id/ship` (items_to_ship массив с coi_id/qty > 0)
  - `validateTransferReserve` → `POST /api/sales/transfer-reserve` (donor_coi_id, recipient_coi_id, transfer_qty > 0)
  - `validateOrderStatus` → `PUT /api/sales/orders/:id/status` (status ∈ pending/processing/completed/cancelled)
  - `validateTimesheetCell` → `POST /api/timesheet/cell` (employee_id, date, status whitelist, bonus/penalty ≥ 0, multiplier 0–1)
  - `validateMassBonus` → `POST /api/timesheet/mass-bonus` (date, workersData массив с employee_id и ktu 0–5)
  - `validateSalaryPay` → `POST /api/salary/pay` (employee_id, amount ≥ 0, date, account_id)
- **Утилиты:** `_isValidInn(inn)`, `_isValidKpp(kpp)`, `_isValidEmail(email)` — приватные функции
- **Покрыто модулей:** Справочники, Кадры, Финансы, Склад, Производство, Продажи, HR

---

## 4. КЛЮЧЕВЫЕ ПАТТЕРНЫ КОДА

### 4.1 withTransaction(pool, callback)
```javascript
async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await callback(client);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
```

### 4.2 getWhId(clientOrPool, type)
```javascript
// Динамический резолвер ID склада по типу
const res = await clientOrPool.query(
    "SELECT id FROM warehouses WHERE warehouse_type = $1", [type]
);
return res.rows[0]?.id;
```

### 4.3 getNextDocNumber(client, prefix)
```javascript
// Атомарный генератор номеров: UPDATE ... RETURNING + uniqueness check
const res = await client.query(
    "UPDATE document_sequences SET last_number = last_number + 1 WHERE doc_type = $1 RETURNING last_number",
    [prefix]
);
```

### 4.4 Soft Delete vs Hard Delete
| Сущность | Стратегия | Механизм |
|---|---|---|
| Товары (items) | Soft | `is_deleted = true` |
| Транзакции (transactions) | Soft | `is_deleted = true` + триггер пересчёта |
| Сотрудники (employees) | Soft | `status = 'deleted'` |
| Счета (invoices) | Soft/Hard | Последний = hard delete, остальные = `status = 'cancelled'` |
| Заказы (client_orders) | Hard | `DELETE FROM` с откатом резервов |
| Партии (production_batches) | **Draft → Hard** / **Completed → Soft** | Черновик: `DELETE FROM` (физическое). Завершённые: `status = 'deleted'` + откат циклов и зарплаты |
| Контрагенты | Soft | `is_deleted = true` (AUDIT-003 закрыт, CASCADE заменён на RESTRICT) |

---

## 5. ЗАВИСИМОСТИ (package.json)

| Пакет | Назначение |
|---|---|
| express | HTTP-сервер |
| pg | PostgreSQL-клиент |
| ejs | Шаблонизатор |
| socket.io | WebSocket (реальное время) |
| big.js | Точная финансовая математика |
| jsonwebtoken | JWT аутентификация |
| bcrypt | Хэширование паролей |
| multer | Загрузка файлов (чеки) |
| dotenv | Переменные окружения |
| node-telegram-bot-api | Telegram нотификации |
| cors | CORS middleware |

---

## 6. РЕКОМЕНДАЦИИ ПО РАЗВИТИЮ

### 6.1 Краткосрочные (1-2 недели)
1. Закрыть RBAC-дыры (AUDIT-001)
2. Заменить CASCADE на RESTRICT для counterparties (AUDIT-003)
3. Добавить CHECK constraints на критические поля (AUDIT-007)
4. Добавить индексы на production_batches (AUDIT-010)
5. Удалить мёртвый код: DROP TABLE, legacy маршруты, дубликаты

### 6.2 Среднесрочные (1-2 месяца)
1. Внедрить express-validator на все POST-маршруты
2. Перенести инлайн-стили в CSS (AUDIT-011)
3. Оптимизировать N+1 запросы в production и sales
4. Внедрить rate-limiting (express-rate-limit)
5. Multi-role RBAC (admin → manager → operator → viewer)

### 6.3 Долгосрочные (3-6 месяцев)
1. Миграция на REST API + SPA (React/Vue) для улучшения UX
2. Полноценный аудит-лог (who/what/when на каждое изменение)
3. Автоматические бекапы БД с ротацией
4. Docker-контейнеризация для CI/CD
5. Unit/Integration тесты (Jest + Supertest)

---

*Документ является частью операции «ПАНОПТИКУМ» — полного аудита ERP-системы.*
