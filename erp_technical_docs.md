# PLITTEX ERP — техническая документация

**Версия:** 2026-05-02  

Стабильные контракты, стек и правила. Историю внедрения по фазам сюда не дублировать.

---

## 1. Стек

| Слой | Технология |
|------|------------|
| Runtime | Node.js, Express 5.x |
| БД | PostgreSQL, драйвер `pg` (пул в `web.js`) |
| UI | EJS (SSR) + крупные клиентские модули в `public/js` |
| Realtime | Socket.io (тот же HTTP-сервер, что и Express) |
| Деньги (критично) | **Big.js** в серверном коде финансов/продаж/инвентаря и в `web.js` (отгрузки, налоги, cashflow-forecast, P&L); на клиенте — по месту |
| Мониторинг | Sentry (опционально, `SENTRY_DSN`) |
| Тесты | Jest (`npm test`, каталог `test/`) |

---

## 2. Вход, конфиг, инфра

- **Точка входа:** `web.js` — пул БД, `app.set('io', io)`, лимит `express.json` до 50mb, `multer` для загрузок в `public/uploads/`.
- **Порт:** `process.env.PORT || 3000`.
- **ERP_CONFIG** (в `web.js`): НДС и список категорий «без НДС» — передаётся в `routes/finance.js` и `routes/sales.js`.
- **Health:** `GET /api/health` — до JWT, для мониторинга.
- **Печать по URL с токеном:** `POST /api/generate-print-token` (основной JWT) → краткоживущий JWT с `type: 'print'` в query (`middleware/auth.js`).

---

## 3. API и безопасность

- **Глобально:** `app.use('/api', authenticateToken)` — кроме заранее выведенных наружу путей. В `middleware/auth.js` для `POST /api/login` пропуск задан по `req.path` смонтированного обработчика (`'/login'`), плюс дублирующая проверка `'/api/login'`. `GET /api/health` объявлен **до** `app.use('/api', authenticateToken)` в `web.js`. `POST /api/generate-print-token` идёт **перед** глобальным JWT-этапом, но сам требует обычный JWT в `Authorization` (см. `web.js`).
- **Роль admin:** `requireAdmin` на выбранных эндпоинтах (часть финансов, админка, ряд удалений). Точка входа **всегда** в коде маршрута, не по одному лишь скрытыю кнопки.
- **Лимит:** `middleware/rateLimit.js` на префикс `/api`; блокировки пишутся через `logger.warn`.
- **Валидация:** `middleware/validator.js` + ad-hoc проверки в роутерах.
- **CORS:** `CORS_ORIGIN` (через запятую) или fallback localhost; не `*`.

---

## 4. Клиент: HTTP и UI

- **`public/js/core.js`:** `window.API` — `get/post/put/patch/delete` с заголовком `Authorization: Bearer` и разбором JSON; при 401/403 — `handleLogout` где применимо.
- **`views/partials/scripts.ejs`:** обёртка над `window.fetch` подставляет Bearer для URL с `/api` (кроме login) — **дополняет** `API`, предпочтительно писать новый код через **`API.*`**.
- **Модули:** `views/index.ejs` подключает все `views/modules/*`; навигация `switchModule` + `activeModuleId` в `localStorage`.
- **Стили:** `public/css/theme.css`, `layout.css`, `components.css`, `modules.css`. Инлайн-стили в шаблонах в основном убраны; новые блоки — только через CSS-классы по **`styles_and_ui.md`**. В JS вместо `.style.display` используется `classList.add/remove/toggle('d-none')`.

---

## 5. Realtime (Socket.io)

- Клиент: `io({ auth: { token } })` в `core.js` после появления JWT.
- События (пример): `inventory_updated`, `finance_updated`, `production_updated`, `sales_updated` — дебаунс ~500ms, обновление таблиц/дашборд-виджетов.
- Каждый `emit` в роуте: `const io = req.app.get('io')`.

---

## 6. Финансы: две разные «дебиторные» логики

Системно разделять метрики (путаница = ошибки в отчётах):

1. **Дашборд «Ожидаемые поступления»**  
   - Источник: `GET /api/analytics/dashboard-widgets` в **`routes/finance.js`**.  
   - Смысл: **контрактный** долг по заказам: \(\sum \max(0, \text{total\_amount} - \text{paid\_amount})\) по `client_orders`, **без** отменённых.  
   - Не смешивать с пунктом 2.

2. **Финансы: блок «Ожидаемые платежи (Счета и Заказы)»**  
   - Источник: `GET /api/invoices` в **`routes/finance.js`**.  
   - **Счета (invoices):** невыставленные/ожидающие счета.  
   - **Заказы:** **фактическая** дебиторка по **отгрузкам** (оценка по позициям `qty_shipped * price` с пропорцией скидки/логистики) минус **эффективная оплата**  
     \(\max(\texttt{paid\_amount}, \sum \texttt{income} \text{ с } \texttt{linked\_order\_id})\) — чтобы согласовать с проводками и актом сверки.

3. **Сальдо в карточке контрагента / акт**  
   - Считается по **таймлайну** (отгрузки из движений + денежные транзакции) в логике `GET /api/counterparties/:id/profile` в **`routes/finance.js`**.  
   - Это третий «слой» отображения; сходимость с п.1–2 достигается корректными `paid_amount`, привязкой `linked_order_id` и аллокацией авансов.

- **Автораспределение авансов:** `utils/allocateClientAdvance.js` + `POST /api/finance/reconcile-advances/:counterpartyId` (admin) — уменьшает **контрактный** `pending_debt` на заказах, связывает `transactions` с `linked_order_id`. После ручного «Распределить авансы» в UI цифры п.1–2 чаще совпадают.

---

## 6.1 Импорт 1С: дедупликация платежей (стабильный ключ)

- Для `POST /api/transactions/import` дедупликация при импорте 1С выполняется по стабильному ключу:
  - `account_id`
  - `transaction_type`
  - `reg_document_date`
  - `round(amount, 2)`
  - `btrim(reg_document_no)`
- Источник ключевых полей:
  - фронтенд-парсер 1С (`public/js/finance.js`) передаёт `bank_doc_no`, `bank_doc_date` (и `bank_account_no` как служебное поле);
  - бэкенд (`routes/finance.js`) маппит их в `transactions.reg_document_no`, `transactions.reg_document_date`, `transactions.reg_source_tag='1c_import'`;
  - fallback для старого payload: `reg_document_no` извлекается regexp’ом из `description` по шаблону `(№...)`, `reg_document_date` берётся из даты операции.
- Хранилище в БД:
  - `transactions.reg_document_no` — номер документа/референс из 1С;
  - `transactions.reg_document_date` — дата документа (`date`);
  - `transactions.reg_source_tag` — источник регистрационной записи (`'1c_import'` для импорта выписки 1С).
- Защита от дублей на уровне БД:
  - частичный уникальный индекс `ux_transactions_1c_dedupe_key` на ключ выше;
  - в импорте используется `INSERT ... ON CONFLICT (...) WHERE ... DO NOTHING`;
  - повторная загрузка той же выписки не создаёт новых строк: дубли пропускаются атомарно на уровне PostgreSQL.

## 6.2 ID-First: финпотоки сотрудников (Зарплата <-> Касса)

- Базовый принцип: employee-финансы связываются по ID, не по тексту (`name`, `description`, `LIKE/ILIKE`).
- Мост между зарплатой и кассой: `salary_adjustments` (доп. операции) <-> `transactions`.
  - `salary_adjustments.linked_transaction_id` указывает на зеркальную проводку кассы (если операция проведена по деньгам).
  - `transactions.salary_adjustment_id` указывает на запись доп. операции.
- Новые поля ID-first:
  - `salary_adjustments`: `counterparty_id`, `linked_transaction_id`, `cash_posting_mode`, `cash_account_id`, `operation_kind`, `source_module`.
  - `transactions`: `employee_id`, `salary_adjustment_id`, `system_type`, `generation_batch_id`.
  - `accounts`: `employee_id`, `account_role` (для подотчета используется роль `imprest`).
- Роуты `hr.js` и `finance.js` переведены на ID-first адресацию:
  - employee-mode операции подотчета берут счет по `accounts.employee_id`, а не по строке `Подотчет: ФИО`.
  - зарплатные проводки записывают `transactions.employee_id` и `system_type`.
- Закрытие месяца зарплаты маркирует автосгенерированные проводки через `system_type` и `generation_batch_id`; переоткрытие месяца больше не зависит от `description LIKE`.
- Обратная совместимость: в расчетах сохранен fallback на старые категории/связи, но приоритет у `employee_id` и системных типов.
- Скрипты миграции и rescue:
  - `scripts/migrate_id_first_bridge.sql` — расширение схемы (Phase 0).
  - `scripts/backfill_history.js` — первый безопасный бэкфилл.
  - `scripts/backfill_history_v2.js` — усиленный бэкфилл ambiguous-cases.

---

## 7. Склад и движения

- «Истина» — таблица движений (напр. `inventory_movements` и согласованные типы: закупка, отгрузка, резерв, сушилка и т.д.).
- Правило: **не** хардкодить ID складов — использовать `getWhId(type)` из `web.js` (резолвит по столбцу `type` таблицы `warehouses`). На клиенте константы `WAREHOUSE_IDS` (из API `/api/warehouses/ids`) с фолбэками.
- Сложные операции — **транзакции** `withTransaction` (`web.js`).

---

## 7.1 Редактирование заказа (Sales)

- **API и транзакционность:** редактирование выполняется в `PUT /api/sales/orders/:id` (`routes/sales.js`) внутри одной SQL-транзакции (`withTransaction`) с блокировками `FOR UPDATE` для `client_orders` и `client_order_items`.
- **Rollback склада перед применением новой версии:**
  - удаляются старые резервные движения `inventory_movements` с `movement_type IN ('reserve_expense', 'reserve_receipt')` по `linked_order_item_id` текущего заказа;
  - у позиций заказа обнуляются `qty_reserved` и `qty_production`.
- **Reapply склада (новая версия заказа):**
  - пересчитывается состав `client_order_items` (update/add/delete);
  - действует защита от регресса: `qty_ordered` нельзя уменьшить ниже `qty_shipped`;
  - резерв пересчитывается заново на основе доступного остатка, `qty_production` = недостающий хвост после резерва;
  - резервные движения создаются заново как пары `reserve_expense` + `reserve_receipt`;
  - `planned_production` пересобирается от фактического `qty_production`.
- **Финансы при смене контрагента (`counterparty_id`):**
  - при изменении контрагента перепривязываются только связанные проводки заказа в `transactions`;
  - ограничение строгое: `WHERE linked_order_id = :orderId AND COALESCE(is_deleted,false)=false AND (counterparty_id = :oldCounterpartyId OR counterparty_id IS NULL)`;
  - это исключает массовое затрагивание чужих платежей контрагента;
  - дополнительно обновляется связность отгрузочных движений (`inventory_movements.order_id`) для движений `sales_shipment` / `shipment_reversal`, связанных с позициями заказа.
- **Баланс заказа после редактирования:**
  - `paid_amount` пересчитывается от живых связанных приходов: `SUM(transactions.amount)` по `linked_order_id`, `transaction_type='income'`, `is_deleted=false`;
  - `pending_debt = max(total_amount - paid_amount, 0)` пересчитывается и сохраняется в `client_orders`.
- **Фронтенд-особенность (`public/js/sales.js`):**
  - в режиме редактирования (`editingOrderId != null`) смена клиента **не очищает корзину**;
  - для нового заказа поведение очистки сохраняется (защита от смешивания цен/контрагента);
  - дата заказа при открытии редактирования нормализуется в локальный формат `YYYY-MM-DD` без TZ-сдвига на «вчера».

---

## 8. Администрирование и Резервное копирование (Backups)

### 8.1 Механизм создания бэкапов

Создание резервных копий базы данных реализовано через вызов системной утилиты PostgreSQL `pg_dump` с использованием модуля `child_process.spawn`.
- **Формат:** бэкапы создаются в формате Custom (флаг `-Fc`).
- **Расширение:** для совместимости с интерфейсами восстановления используется расширение `.backup`.
- **Отказоустойчивость:** сервер ожидает полного завершения процесса (Promise). Если утилита завершается с ошибкой (например, не найдена или нет доступа), поврежденный файл удаляется, а API возвращает статус `500` с детальным текстом ошибки.

### 8.2 Инструкция по развертыванию на новом сервере (КРИТИЧЕСКИ ВАЖНО)

При переносе системы на новый сервер (особенно на Windows Server 2016 или локальные среды вроде OpenServer) **система резервного копирования не будет работать "из коробки"**, если путь к бинарникам PostgreSQL не прописан в глобальных переменных ОС.

**Обязательное требование для файла `.env`: для корректной работы модуля администрирования необходимо явно указать абсолютный путь к утилите `pg_dump.exe` в переменной `PG_DUMP_PATH`.**
- Пример для Windows: `PG_DUMP_PATH="C:\Program Files\PostgreSQL\15\bin\pg_dump.exe"`
- Пример для Linux: `PG_DUMP_PATH="/usr/bin/pg_dump"` (или можно оставить пустым, если утилита есть в `$PATH`).
- Если переменная не задана или путь неверный, при попытке создать бэкап фронтенд выдаст ошибку `500`.

### 8.3 Восстановление базы данных (Restore)

Поскольку файлы сохраняются в формате Custom (`.backup`), их нельзя восстановить простым копированием SQL-кода.

Восстановление производится двумя способами:
1. Через консоль (утилита `pg_restore`): `pg_restore -U username -d plittex_erp -1 файл_бэкапа.backup`
2. Через интерфейс pgAdmin: правая кнопка на базе данных -> `Restore...` -> формат `Custom or tar` -> выбрать скачанный файл `.backup` -> `Restore`.

### 8.4 Обслуживание БД (VACUUM ANALYZE)

- Ручной запуск: `POST /api/admin/cron/vacuum` (модуль `routes/admin.js`).
- Фоновый запуск: еженедельно по cron (воскресенье, 03:00) в `utils/cron.js`.
- Процедура выполняет `VACUUM ANALYZE` последовательно по таблицам:
  - `inventory_movements`
  - `transactions`
  - `client_orders`
  - `client_order_items`
  - `production_batches`
  - `invoices`
- API ручного запуска возвращает структурированный результат выполнения: `startedAt`, `finishedAt`, `durationMs`, `tables[]` (по каждой таблице статус/длительность, при ошибке — текст ошибки).

**Защита от параллельных запусков:** в `routes/admin.js` используется in-memory мьютекс `isVacuumRunning`. Если новый запрос приходит во время активного запуска, API возвращает `409 Conflict` с пояснением, что обслуживание уже выполняется. Это штатное поведение и защита от наложения двух VACUUM-процедур.

- Логика ручного запуска и фонового cron-сценария синхронизирована по целевому набору таблиц (один и тот же охват 6 таблиц).

---

## 9. Согласованность данных

- Многошаговые записи в БД — в одной SQL-транзакции.
- Где в модели предусмотрено — **soft delete** (`is_deleted` в транзакциях и т.п.).
- Схема БД: **`.antigravity/db_protocol.md`**.

---

## 10. Тесты

- `npm test` — Jest, `--detectOpenHandles --forceExit` в `package.json`.  
- Покрытие по мере развития; новая критичная бизнес-логика — по возможности сценарий в `test/`.

---

## 11. Документация и каноны

| Файл | Содержание |
|------|------------|
| `erp_architecture_tree.md` | Дерево репозитория и сопоставление UI ↔ роуты |
| `erp_technical_docs.md` | **Этот файл** — правила и контракты |
| `.antigravity/db_protocol.md` | Схема/миграции/именование в БД |
| `.antigravity/styles_and_ui.md` | UI/UX |
| `.cursorrules` | Правила для агента |
| `audit_master_list.md` | Чеклист аудита по вкладкам (не схема кода) |

**При расхождении кода и дока:** править код или документ в одной задаче и сразу обновлять **оба** `erp_*.md`, если меняется структура или контракт.

## 12. Краткое сопоставление `routes` ↔ бизнес-область

| Бизнес-область | Роутер (основной) |
|----------------|------------------|
| Склад, закупка сырья, сушилка, часть нумерации | `inventory.js` |
| Производство, батчи, часть API рецептур | `production.js` |
| Продажи, заказы, отгрузки, аналитика | `sales.js` |
| Касса, проводки, контрагенты, налоги, **дашборд-аналитика, invoices** | `finance.js` |
| Справочники, оборудование (CRUD API) | `dictionaries.js` |
| Кадры, зарплата | `hr.js` |
| Печатные формы, реестр, PDF/HTML экспорты | `docs.js` |
| ОСВ, реестр движений, аналитика продаж, экспорт CSV/XLSX | `reports.js` |
| Админ (бэкап, VACUUM, логи) | `admin.js` |
| Dev-only утилиты | `dev.js` (`/api/dev/...`) |

Этого достаточно, чтобы не дублировать детальный список маршрутов; точный список — **исходный код** соответствующего файла.

## 13. Оформление заказа и отгрузка: склад-донор (`stock_source_warehouse_id`)

- При **`POST /api/sales/checkout`** для каждой позиции корзины фронтенд передаёт `items[].warehouse_id` (выбранная ячейка склада для списания), как и раньше. Бэкенд резервирует с **`whId = item.warehouse_id || склад ГП (`finished`)** и записывает тот же `whId` в колонку **`client_order_items.stock_source_warehouse_id`** (DDL через `utils/db_init.js` при старте). Связки с текстовыми именами («2 сорт») нет — только числовой `warehouses.id`, выбранный в UI при заказе.
- При **`POST /api/sales/orders/:id/ship`** авто-добор в резерв (shortfall): баланс и `allocateFifoBatches` выполняются по **`resolveStockDonorWarehouseId(stock_source_warehouse_id, finishedWhId)`** — то есть по тому же складу, с которого при оформлении забирался свободный остаток (в том числе **defect**, если клиент заказал с брака). Старые строки без колонки (NULL) ведут себя как прежде: донор = ГП.

## 13.1. Контракт отгрузки `/api/sales/orders/:id/ship`

- Контроллер отгрузки в `routes/sales.js` внутри одной SQL-транзакции обязан:
  - сгенерировать документ `УТ-xxxxx`;
  - по **проекции** (текущие `qty_ordered` / `qty_shipped` по всем позициям заказа + дельты из `items_to_ship`) выбрать префикс текста накладной: **«Полная отгрузка по Заказу»** или **«Частичная отгрузка по Заказу»**, затем в цикле подставить этот `description` во все вставки `sales_shipment` данной УТ (чтобы текст документа совпадал с фактическим типом отгрузки);
  - создать движения склада `sales_shipment` по всем фактически отгружаемым FIFO-партиям (с мягким fallback по `batch_id`, если задано в коде);
  - обновить `client_order_items.qty_shipped` и `qty_reserved`;
  - признак «заказ полностью отгружен» и перевод в `client_orders.status = 'completed'` определяются **одним** SQL-запросом после обновления счётчиков: нет строк, где \((\texttt{qty\_ordered} - \texttt{qty\_shippped}) > \varepsilon\) с **ε = 0.001** (защита от артефактов floating-point / numeric).
- Отдельная проводка в `transactions` на саму отгрузку в долг **не создаётся** этим эндпоинтом (учёт долга — по остальной архитектуре финансов и полям заказа).
