# Sales Master-Audit · Анализ Регрессии 7–8 мая 2026

> Diff-разбор каждого коммита из регрессионного окна. Для каждого: что изменилось, какие функции/ветки затронуты, связь с разрывами B-XX из `sales_breaks.md`, и точка безопасного отката.

## Регрессионное окно
Последний «здоровый» рубеж: `2be7082` (2026-05-07 утро, до серии правок).

| # | hash | дата | сообщение | файлы | риск |
|---|------|------|-----------|-------|------|
| 1 | `469a76f` | 2026-05-07 | feat: process payment delta and offsets on order edit | `routes/sales.js`, `public/js/sales.js` | HIGH |
| 2 | `a7437e7` | 2026-05-07 | fix: strict inventory locking and DB-level balance protection | `routes/sales.js`, `routes/inventory.js`, `scripts/inventory_balance_trigger.sql` | CRITICAL |
| 3 | `f1dff26` | 2026-05-07 | fix: implement FIFO batch allocation to prevent NULL-batch negative balances. | `routes/sales.js` | CRITICAL |
| 4 | `fc03fa7` | 2026-05-07 | fix: correct reserve amount calculation by batch_id in inventory balances response. | `routes/inventory.js` | LOW |
| 5 | `faf1aa8` | 2026-05-07 | fix: correct reserve calculation by batch_id and prevent zero quantity badges. | `public/js/inventory.js` | LOW |
| 6 | `85929d1` | 2026-05-07 | feat: proactive reserve rebalancing and UI cleanup for warehouse 7. | `routes/inventory.js`, `public/js/inventory.js` | MEDIUM |
| 7 | `c8e9bc9` | 2026-05-07 | fix: sync reserve burn on shipment and clamp negative reserve need. | `routes/sales.js`, `public/js/inventory.js` | HIGH |
| 8 | `9fcd1ad` | 2026-05-08 | fix: устранение дублей во фронтенде | `public/js/inventory.js`, `public/css/modules.css` | LOW |
| 9 | `bcfa5b2` | 2026-05-08 | fix: резервы и utf8 | `web.js`, `routes/inventory.js`, `public/css/modules.css`, `public/js/inventory.js` | LOW |

---

## Детальный разбор ключевых коммитов

### 1. `469a76f` (Редактирование заказа и дельты)
- **Что изменилось:** В `PUT /api/sales/orders/:id` добавлена логика расчета `incomeDelta` и `offsetApplied`. Добавлены проверки на то, что новая сумма заказа не меньше уже оплаченной.
- **Риски:** Блокирует редактирование в меньшую сторону (требует ручного возврата). Усложняет код.
- **Связь с разрывами:** B-04.

### 2. `a7437e7` (Строгие блокировки и триггер)
- **Что изменилось:** Внедрены advisory locks (`lockStockKey`, `lockStockPair`) в `routes/sales.js` (`/checkout`, `/ship`, `/force-close`, edit). Добавлен SQL-триггер `inventory_balance_trigger` для запрета отрицательных остатков.
- **Риски:** Advisory locks могут вызывать deadlocks, если порядок блокировки нарушен (хотя `lockStockPair` сортирует ID складов). SQL-триггер жестко блокирует транзакции при малейшем минусе, что может приводить к откату всей отгрузки (`/ship`). Если отгрузка откатывается, а статус заказа меняется (или пользователь жмет force-close), возникает B-01.
- **Связь с разрывами:** B-01, B-10.

### 3. `f1dff26` (FIFO аллокация батчей)
- **Что изменилось:** Внедрена функция `allocateFifoBatches` в `routes/sales.js`. Теперь при отгрузке (`/ship`), авто-доборе резерва и `force-close` движения разбиваются на несколько записей по `batch_id`.
- **Риски:** Если `allocateFifoBatches` не находит нужного количества (бросает ошибку "Недостаточно товара для FIFO-списания"), транзакция отгрузки прерывается. Это главная причина, почему отгрузки перестали проходить и начали превращаться в "ЗК" (пользователи не могли отгрузить и жали force-close, либо транзакция падала молча).
- **Связь с разрывами:** B-01, B-05.

### 4. `c8e9bc9` (Синхронизация списания резерва)
- **Что изменилось:** В `POST /api/sales/orders/:id/ship` добавлено обновление `qty_reserved = GREATEST(COALESCE(qty_reserved, 0) - $1, 0)` при отгрузке.
- **Риски:** Это было правильное исправление (чтобы резерв уменьшался при отгрузке), но оно наложилось на уже сломанную FIFO-логику.

---

## Выводы и точки отката

**Корень проблемы (B-01):**
Проблема "отгрузки стали ЗК" вызвана комбинацией строгих блокировок (`a7437e7`) и FIFO-аллокации (`f1dff26`). Функция `allocateFifoBatches` требует точного совпадения остатков по `batch_id`. Если в базе есть исторический мусор (NULL-батчи, отрицательные батчи), `allocateFifoBatches` падает с ошибкой. Отгрузка не проходит. Пользователь видит ошибку или зависание, нажимает "Принудительно закрыть" (force-close). Force-close меняет статус на `completed`, но НЕ создает `sales_shipment`. В результате в архиве отгрузок (`/api/sales/history`) заказ попадает в `forcedClosedRes` и отображается как `ЗК-...` без суммы и кнопок печати.

**Точка безопасного отката:**
Наиболее безопасным вариантом для восстановления работоспособности отгрузок является откат коммитов, связанных с FIFO в продажах и жесткими блокировками:
- Откат `f1dff26` (FIFO в `routes/sales.js`).
- Откат `a7437e7` (advisory locks в `routes/sales.js` и триггер).
Это вернет систему к состоянию `469a76f` (или `2be7082`, если откатить и дельты), где отгрузки работали, хотя и могли создавать отрицательные остатки.
