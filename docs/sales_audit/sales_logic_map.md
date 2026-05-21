# Sales Master-Audit · Карта Логики

> Read-only снимок Sales-модуля по состоянию на 2026-05-08 после коммита `bcfa5b2`.
> Источники: `routes/sales.js`, `public/js/sales.js`, `views/modules/sales.ejs`, мосты `routes/inventory.js`, `routes/finance.js`, `routes/docs.js`, `routes/hr.js`, `web.js`, `scripts/*.sql`.

## Оглавление
1. [Жизненный цикл заказа](#1-жизненный-цикл-заказа)
2. [Реестр эндпоинтов routes/sales.js](#2-реестр-эндпоинтов-routessalesjs)
3. [Связанные эндпоинты других модулей](#3-связанные-эндпоинты-других-модулей)
4. [Фронтенд-функции public/js/sales.js](#4-фронтенд-функции-publicjssalesjs)
5. [Схема БД и связки](#5-схема-бд-и-связки)
6. [Карта inventory_movements.movement_type](#6-карта-inventory_movementsmovement_type)
7. [Документ-нумерация (УТ / ЗК / СЧ / РН)](#7-документ-нумерация-ут--зк--сч--рн)
8. [Sequence-диаграммы основных сценариев](#8-sequence-диаграммы)

---

## 1. Жизненный цикл заказа

```
draft (UI) → POST /checkout → client_orders.status='pending'
                              + client_order_items (qty_ordered, qty_reserved=0)
                              + inventory_movements: reserve_expense (со склада ГП)
                                                    + reserve_receipt (на склад резерва)
                              + транзакция (если paid/partial)
                              + invoice (если debt)
                              + spec/contract (если contract_id)

pending ──► partial shipment ──► POST /:id/ship ──► processing
                                  • префикс description УТ: «Полная» / «Частичная» по **проекции** (все COI + дельты `items_to_ship`, ε=0.001)
                                  • +sales_shipment (Reserve, FIFO по batch_id)
                                  • UPD client_order_items: qty_shipped++, qty_reserved-=
                                  • doc_number = УТ-NNN (getNextDocNumber)
                                  • если после отгрузки не осталось строк с (qty_ordered−qty_shipped) > ε → status='completed'

processing ──► full shipment ──► completed (через POST /:id/ship выше)

pending|processing ──► PUT /:id/force-close ──► completed
                       • снимает остаток qty_reserved обратно на ГП
                       • НЕ создаёт sales_shipment
                       • НЕ создаёт transaction
                       • doc_number остаётся ЗК-NNN (исходный заказ)

pending|processing ──► PUT /:id/status (cancelled) ──► cancelled
                       • удаляет reserve_expense/reserve_receipt по linked_order_item_id
                       • обнуляет qty_reserved/qty_production
                       • удаляет planned_production
                       • НЕ трогает sales_shipment (если уже было — данные остаются)

любое ──► PUT /:id (edit) ──► старые позиции/проводки переписываются:
                              • удаляются старые reserve_*
                              • заново создаются reserve_* для новых qty
                              • DELTA-доплата (incomeDelta) → transaction
                              • offset (взаимозачёт сотрудника) → salary_payment + compensating income (double-entry в `transactions`)

completed/cancelled ──► DELETE /:id ──► settlement_mode in
                       (refund_cash, leave_advance, write_off, none)
                       каскадно чистит:
                       client_order_items, inventory_movements,
                       transactions (linked_order_id), invoices, salary_adjustments,
                       salary_payments, planned_production, pallets_shipments
```

Ключевые статусы `client_orders.status`: `pending`, `processing`, `completed`, `cancelled`.

---

## 2. Реестр эндпоинтов routes/sales.js

| Метод | Путь | Назначение | Транзакция | Создаёт записи |
|---|---|---|---|---|
| POST | `/api/sales/checkout` | Оформление нового заказа | `withTransaction` | `client_orders`, `client_order_items`, `inventory_movements`(reserve_*), `transactions`, `invoices`, `specifications`, `contracts` |
| POST | `/api/sales/orders/offset` | Зачёт долгов между заказами | `withTransaction` | `transactions` (mirror income/expense) |
| POST | `/api/sales/returns` | Возврат от клиента | `withTransaction` | `inventory_movements`(return_receipt), `transactions`(refund) |
| POST | `/api/sales/orders/:id/apply-advance` | Зачёт свободного аванса | `withTransaction` | `transactions` |
| POST | `/api/sales/orders/:id/ship` | **Отгрузка (УТ)** | `withTransaction` | `inventory_movements`(sales_shipment, shipment_doc_number=УТ-N), UPD client_order_items, UPD client_orders.status; текст УТ: полная/частичная по проекции |
| DELETE | `/api/sales/shipments/:docNum` | Отмена отгрузки | `withTransaction` | DEL inventory_movements(sales_shipment), UPD client_order_items.qty_shipped--, UPD status='processing' |
| GET | `/api/sales/orders/:id/delete-preview` | Превью каскада удаления | read-only | — |
| DELETE | `/api/sales/orders/:id` | Удаление заказа | `withTransaction` | каскад settlement_mode |
| PUT | `/api/sales/orders/:id/status` | Смена статуса | `withTransaction` | при `cancelled`: DEL reserve_*, UPD qty_reserved=0 |
| PUT | `/api/sales/orders/:id/force-close` | **Принудительное закрытие** | `withTransaction` | reserve_expense/reserve_receipt (возврат на ГП), UPD client_orders.status='completed', total_amount/pending_debt |
| PUT | `/api/sales/orders/:id` | **Редактирование заказа** | `withTransaction` | DEL/INS client_order_items, DEL/INS reserve_*, INS transactions(income delta), INS salary_payments(offset) |
| GET | `/api/sales/orders` | Список активных заказов | read-only | — |
| GET | `/api/sales/orders/:id` | Детали заказа | read-only | — |
| GET | `/api/sales/history` | **Архив отгрузок (UI)** | read-only | — |
| GET | `/api/sales/analytics` | Топ-5 товары/клиенты | read-only | — |
| GET | `/api/sales/pallets-report` | Долг по поддонам | read-only | — |
| POST | `/api/sales/recipe-pallets-estimate` | Оценка поддонов из рецепта | read-only | — |
| GET/POST/PUT/DELETE | `/api/contracts*` | CRUD договоров | mixed | — |
| GET/POST/PUT/DELETE | `/api/specifications*` | CRUD спецификаций | mixed | — |

Хелперы (внутри module.exports):
- `lockStockKey(client, itemId, whId)` — `pg_advisory_xact_lock(itemId, whId)`.
- `lockStockPair(client, itemId, whA, whB)` — два advisory-lock в детерминированном порядке (anti-deadlock).
- `mapDbError(err, fallback)` — нормализует `23514`/`P0001` → пользовательский текст.
- `allocateFifoBatches(client, itemId, whId, qty)` — FIFO по `batch_id` из `inventory_movements`, бросает ошибку при недоборе.
- `recalcAccountBalances(client, accountIds)` — пересчёт `accounts.balance`.
- `getPreferredAdvanceAccountId(client, ...)` — выбор кассы для аванса.
- `getCounterpartyBalance(client, cpId)` — сальдо клиента (использует другие правила, чем Finance — см. C4 в `sales_breaks.md`).
- `getOrderSettlementSnapshot(client, orderId, opts)` — снимок финансов заказа.
- `reconcileOrderSettlement(client, orderId, opts)` — выравнивание `paid_amount`/`pending_debt`.

---

## 3. Связанные эндпоинты других модулей

### routes/inventory.js
- `GET /api/inventory` — главная таблица остатков. Считает `reserve_qty_by_batch` отдельным CTE по `batch_id`.
- `POST /api/inventory/reserve-action` — переводы/коррекции резерва. С `bcfa5b2` создаёт `reserve_expense+reserve_receipt` (раньше было `reserve_transfer_in/out` — деприкейтнуто).
- `POST /api/inventory/rebalance-reserves` — `internalRebalanceReserves` приводит фактические резервы (по сумме `reserve_*`) к плановому `qty_reserved` из `client_order_items`.
- `DELETE /api/inventory/movement/:id` — мягкое удаление движения (только NULL-batch и audit_adjustment).
- `GET /api/inventory/history` — журнал движений по позиции.

### routes/finance.js
- `POST /api/transactions` — основной эндпоинт. Поддерживает `system_type` (whitelist): `salary_payment`, `salary_accrual`, `salary_advance`, `salary_correction`, `imprest_issue_out`, `imprest_return_in`, `instant_expense`, … Без `system_type` — обычная пользовательская проводка.
- `DELETE /api/transactions/:id` / `PUT /api/transactions/:id` — каскад уважает `linked_order_id`/`salary_adjustment_id`.
- `POST /api/invoices/:id/pay` — оплата счёта, привязка к `linked_order_id`.
- `GET /api/counterparties/:id/full` — сальдо/история клиента. **Считает иначе, чем Sales** (расхождение C4).
- `GET /api/counterparties/:id/profile` — таймлайн карточки контрагента. **Расчёт сальдо** — по полному `timeline` (все ветки UNION). **Скрытие технических строк аванса продукцией** (виртуальная «Отгрузка продукции» + sales-`income` без `system_type` при паре `salary_payment` на том же `linked_order_id`) — поле `hide_in_timeline` в SQL (`EXISTS … system_type = 'salary_payment'`), на фронт уходит `transactions: timeline.filter((t) => !t.hide_in_timeline)`. Строка «Выдача аванса» (`salary_payment`, expense) остаётся видимой.

### routes/docs.js
- `getNextDocNumber(client, prefix, table, column)` (определена в `web.js`) — генерирует `УТ-N`, `ЗК-N`, `СЧ-N`, `РН-N` через сканирование max(N) в нужной таблице/колонке.
- `/print/upd?docNum=УТ-N` — формирует УПД + Пропуск; ищет движения по `description LIKE '%УТ-N%'` (НЕ по `shipment_doc_number`).
- `/print/waybill`, `/print/specification`, `/print/invoice` — аналогично, фильтр по описанию.
- `/api/docs/registry` — реестр документов.

### routes/hr.js
- `POST /api/salary/adjustments` — начисления/удержания. Может создавать mirror-`transactions` через `system_type='salary_payment'`.
- `DELETE /api/salary/adjustments/:id` — каскадно удаляет mirror-`transactions`.
- `POST /api/salary/close-month` — закрытие месяца, `salary_advance` → `salary_correction`.
- Когда сотрудник = клиент (counterparty.employee_id), Sales-эндпоинты редактирования и checkout создают записи в `salary_payments` (тип `advance`) и `transactions(category='Зарплата и Авансы', system_type='salary_payment')`.

---

## 4. Фронтенд-функции public/js/sales.js

| Функция | Строки | Назначение |
|---|---|---|
| `loadSalesData(showLoader)` | ~250 | Главная загрузка модуля Sales |
| `loadActiveOrders()` | ~370 | Канбан активных заказов |
| `processCheckout()` | ~1700 | Сборка payload и POST /checkout или PUT /:id |
| `loadSalesHistory()` | ~2300 | Загрузка `/api/sales/history` с пагинацией |
| `renderHistoryTable()` | 2374 | **Рендер архива отгрузок**. Берёт сумму из `h.amount ?? h.calculated_shipment_amount ?? h.total_amount`. Отключает кнопки печати при `h.cancellable === false`. |
| `cancelShipment(docNum)` | 2442 | Модал отмены отгрузки |
| `executeCancelShipment(docNum)` | 2456 | DELETE /api/sales/shipments/:docNum |
| `executePartialShipment()` | ~3210 | Сбор `items_to_ship` + POST /:id/ship |
| `executeForceClose()` | ~4828 | PUT /:id/force-close |
| `openOrderModal(orderId)` | ~3500 | Модал детализации заказа |
| `populateHistoryClientFilter()` | ~2280 | Заполняет dropdown клиентов |

---

## 5. Схема БД и связки

### Основные таблицы Sales-модуля
- `client_orders(id, doc_number, counterparty_id, status, total_amount, pending_debt, paid_amount, payment_method, account_id, discount, logistics_cost, contract_id, specification_id, is_locked, created_at, ...)`
  - `doc_number` для заказов = `ЗК-N`. УТ выдаётся в `inventory_movements` при отгрузке.
- `client_order_items(id, order_id→client_orders, item_id→items, qty_ordered, qty_reserved, qty_production, qty_shipped, price, unit_cost_snapshot, cost_source, ...)`
- `counterparties(id, name, employee_id→employees, pallets_balance, ...)`
- `contracts`, `specifications`.

### Мост к складу
- `inventory_movements(id, item_id, warehouse_id, quantity, batch_id→batches, movement_type, description, linked_order_item_id→client_order_items, shipment_doc_number, user_id, movement_date, created_at)`
- Триггер `inventory_balance_trigger` (см. `scripts/inventory_balance_trigger.sql`): `BEFORE INSERT/UPDATE` запрещает отрицательный SUM(quantity) на пару `(item_id, warehouse_id, batch_id)`.

### Мост к финансам
- `transactions(id, amount, transaction_type{income/expense}, category, system_type, description, account_id→accounts, counterparty_id→counterparties, employee_id, linked_order_id→client_orders, salary_adjustment_id, source_module, transaction_date, payment_method, user_id, is_deleted)`
- CHECK `chk_transactions_system_type` (см. `scripts/apply_phase4_constraints.sql`): whitelist значений `system_type`.
- `invoices(id, invoice_number, counterparty_id, total_amount, paid_amount, ...)` — `invoice_number` совпадает с `client_orders.doc_number` (ЗК).

### Мост к HR
- `salary_adjustments`, `salary_payments(employee_id, amount, payment_date, payment_type{advance|salary|...}, linked_transaction_id→transactions)`.

### Логистика/документы
- `pallets_shipments` (выдача поддонов) — связана с `client_orders` опосредованно через `counterparty_id` и текст в `inventory_movements.description`.
- Поле `pallets_balance` в `counterparties` обновляется напрямую при отгрузке (`/api/sales/orders/:id/ship`).
- POA (доверенность) — не отдельная таблица, а текст в `description` отгрузки (`poa_info`).

---

## 6. Карта inventory_movements.movement_type

| Тип | Знак qty | Где создаётся | Назначение |
|---|---|---|---|
| `production_receipt` | + | production routes | Приход с производства на склад ГП |
| `reserve_expense` | − | sales `/checkout`, `/ship`(авто-добор), `/force-close`, edit; inventory `/reserve-action` | Списание в момент резервирования / возврата резерва |
| `reserve_receipt` | + | парный к reserve_expense | Зеркальная запись |
| `sales_shipment` | − | **только** sales `/ship` | Фактическая отгрузка, несёт `shipment_doc_number=УТ-N` |
| `return_receipt` | + | sales `/returns` | Возврат от клиента на склад |
| `audit_adjustment` | ± | inventory ручная коррекция | Балансировка остатков |
| `scrap` | − | inventory scrap | Списание брака |
| `internal_transfer_out/in` | ∓/± | inventory transfer | Перемещения между складами (кроме резерва) |
| `reserve_transfer_in/out` | ± | **deprecated** (до bcfa5b2) | Старые двойные записи переноса резерва — мусор в данных |

> Правило: каждая пара `reserve_expense + reserve_receipt` должна иметь одинаковый `linked_order_item_id` и противоположные знаки qty. Если этого нет — это «битая» запись (см. категорию C9 в breaks).

---

## 7. Документ-нумерация (УТ / ЗК / СЧ / РН)

| Префикс | Таблица.колонка | Когда выдаётся |
|---|---|---|
| `ЗК-N` | `client_orders.doc_number` | при `POST /api/sales/checkout` |
| `УТ-N` | `inventory_movements.description` (плюс `shipment_doc_number`) | при `POST /api/sales/orders/:id/ship` |
| `СЧ-N` | `invoices.invoice_number` | при создании счёта (paymen_method='debt') |
| `РН-N` | старые накладные | legacy |

Реализация — `getNextDocNumber(client, prefix, table, column)` в `web.js`: ищет `MAX(SUBSTRING(... FROM 'PREFIX-[0-9]+'))` и инкрементит.

> ⚠️ Важно: `/api/sales/history` берёт УТ из двух источников — `m.shipment_doc_number` (новые отгрузки) и `SUBSTRING(m.description FROM 'УТ-[0-9]+')` (legacy). Если ни того, ни другого нет — строка отбрасывается `HAVING ... IS NOT NULL`.

---

## 8. Sequence-диаграммы

### 8.1. Обычная отгрузка (УТ)

```
UI(executePartialShipment)
  │ POST /api/sales/orders/:id/ship  {items_to_ship, driver, auto, poa_info, pallets, ship_date}
  ▼
routes/sales.js (router.post('/api/sales/orders/:id/ship'))
  │ withTransaction:
  │   1. SELECT client_orders FOR UPDATE
  │   2. docNum = getNextDocNumber('УТ', 'inventory_movements', 'description')   ← УТ-N
  │   3. SELECT все client_order_items заказа FOR UPDATE → проекция с дельтами items_to_ship → префикс desc (Полная/Частичная), ε=0.001
  │   4. for item in items_to_ship:
  │        lockStockPair(item_id, reserveWh, finishedWh)
  │        SELECT client_order_items FOR UPDATE
  │        SUM(quantity) on reserveWh — если хватает: ничего; иначе авто-добор из ГП
  │           (allocateFifoBatches на finishedWh → reserve_expense + reserve_receipt)
  │           UPD qty_reserved+=, qty_production-=
  │        allocateFifoBatches на reserveWh для item.qty
  │        INSERT inventory_movements (sales_shipment, description=desc, shipment_doc_number=docNum)  ← УТ
  │        UPD client_order_items: qty_shipped+=, qty_reserved-=
  │   5. if нет ни одной sales_shipment → THROW
  │   6. SELECT COUNT(*) WHERE (qty_ordered - qty_shipped) > ε → allCompleted; UPD client_orders.status
  │ commit
  ▼
Ответ: { success, docNum:'УТ-N', isCompleted }
io.emit('inventory_updated', 'sales_updated')
sendNotify(...)

UI: loadSalesHistory() → GET /api/sales/history
  • первый CTE забирает sales_shipment-движения → строки с УТ-N, cancellable=true, кнопки печати активны
```

### 8.2. Force-close (ЗК остаётся)

```
UI(executeForceClose)
  │ PUT /api/sales/orders/:id/force-close
  ▼
routes/sales.js (router.put('/api/sales/orders/:id/force-close'))
  │ withTransaction:
  │   1. SELECT client_orders FOR UPDATE; docNumber = order.doc_number  ← ЗК-N
  │   2. for coi WHERE qty_reserved>0:
  │        FIFO на reserveWh → reserve_expense + reserve_receipt (возврат на ГП)
  │   3. DELETE planned_production, UPD qty_reserved=0, qty_production=0
  │   4. recalc total_amount = SUM(qty_ordered*price) - discount + logistics
  │      pending_debt = total_amount - paid_amount
  │   5. UPD client_orders.status='completed', total_amount, pending_debt
  │ commit
  ▼
НЕТ sales_shipment, НЕТ transaction.

UI: loadSalesHistory() → GET /api/sales/history
  • второй CTE (forcedClosedRes) подберёт co.doc_number=ЗК-N
  • cancellable=false, кнопки печати disabled
  • payment='🧾 Принудительно закрыт', amount=total_amount или null если total_qty=0
```

### 8.3. Архив `/api/sales/history` (упрощённо)

```
GET /api/sales/history?page&limit&start&end&search&client
  ┌──────────────── result (sales_shipment) ─────────────────┐
  │ SELECT shipment_doc_number ?? regexp 'УТ-N' AS doc_num,  │
  │        SUM(qty), SUM(qty*coi.price) AS calculated_amount │
  │ FROM inventory_movements WHERE movement_type='sales_shipment' │
  │ GROUP BY doc_num HAVING doc_num IS NOT NULL              │
  └──────────────────────────────────────────────────────────┘
  ┌────────────── forcedClosedRes (ЗК без отгрузки) ─────────┐
  │ SELECT co.doc_number AS doc_num, total_amount, ...        │
  │ FROM client_orders co                                     │
  │ WHERE co.status='completed'                               │
  │   AND NOT EXISTS sales_shipment по позициям этого заказа  │
  └──────────────────────────────────────────────────────────┘
  Слияние по doc_num (приоритет — реальная отгрузка),
  фильтры/пагинация,
  обогащение через transactions (LIKE по docNum) и invoices.

Если для нового заказа /ship отработал — он попадёт в первый CTE как УТ.
Если /ship упал, но статус всё-таки стал completed — заказ попадёт во второй CTE как ЗК.
```
