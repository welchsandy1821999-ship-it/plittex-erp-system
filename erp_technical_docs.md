# PLITTEX ERP — техническая документация

**Версия:** 2026-04-24  

Стабильные контракты, стек и правила. Историю внедрения по фазам сюда не дублировать.

---

## 1. Стек

| Слой | Технология |
|------|------------|
| Runtime | Node.js, Express 5.x |
| БД | PostgreSQL, драйвер `pg` (пул в `web.js`) |
| UI | EJS (SSR) + крупные клиентские модули в `public/js` |
| Realtime | Socket.io (тот же HTTP-сервер, что и Express) |
| Деньги (критично) | **Big.js** в серверном коде продаж/финансов/части инвентаря; на клиенте — по месту |
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
- **Лимит:** `middleware/rateLimit.js` на префикс `/api`.
- **Валидация:** `middleware/validator.js` + ad-hoc проверки в роутерах.
- **CORS:** `CORS_ORIGIN` (через запятую) или fallback localhost; не `*`.

---

## 4. Клиент: HTTP и UI

- **`public/js/core.js`:** `window.API` — `get/post/put/patch/delete` с заголовком `Authorization: Bearer` и разбором JSON; при 401/403 — `handleLogout` где применимо.
- **`views/partials/scripts.ejs`:** обёртка над `window.fetch` подставляет Bearer для URL с `/api` (кроме login) — **дополняет** `API`, предпочтительно писать новый код через **`API.*`**.
- **Модули:** `views/index.ejs` подключает все `views/modules/*`; навигация `switchModule` + `activeModuleId` в `localStorage`.
- **Стили:** `public/css/theme.css`, `layout.css`, `components.css`, `modules.css`. Инлайн в шаблонах встречается легаси; новые блоки — по **`styles_and_ui.md`**.

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

## 7. Склад и движения

- «Истина» — таблица движений (напр. `inventory_movements` и согласованные типы: закупка, отгрузка, резерв, сушилка и т.д.).
- `getWhId` / склады: не хардкодить хрупко в новом коде — использовать существующие хелперы из `web.js`/роутов.
- Сложные операции — **транзакции** `withTransaction` (`web.js`).

---

## 8. Согласованность данных

- Многошаговые записи в БД — в одной SQL-транзакции.
- Где в модели предусмотрено — **soft delete** (`is_deleted` в транзакциях и т.п.).
- Схема БД: **`.antigravity/db_protocol.md`**.

---

## 9. Тесты

- `npm test` — Jest, `--detectOpenHandles --forceExit` в `package.json`.  
- Покрытие по мере развития; новая критичная бизнес-логика — по возможности сценарий в `test/`.

---

## 10. Документация и каноны

| Файл | Содержание |
|------|------------|
| `erp_architecture_tree.md` | Дерево репозитория и сопоставление UI ↔ роуты |
| `erp_technical_docs.md` | **Этот файл** — правила и контракты |
| `.antigravity/db_protocol.md` | Схема/миграции/именование в БД |
| `.antigravity/styles_and_ui.md` | UI/UX |
| `.cursorrules` | Правила для агента |
| `audit_master_list.md` | Чеклист аудита по вкладкам (не схема кода) |

**При расхождении кода и дока:** править код или документ в одной задаче и сразу обновлять **оба** `erp_*.md`, если меняется структура или контракт.

---

## 11. Краткое сопоставление `routes` ↔ бизнес-область

| Бизнес-область | Роутер (основной) |
|----------------|------------------|
| Склад, закупка сырья, сушилка, часть нумерации | `inventory.js` |
| Производство, батчи, часть API рецептур | `production.js` |
| Продажи, заказы, отгрузки, аналитика | `sales.js` |
| Касса, проводки, контрагенты, налоги, **дашборд-аналитика, invoices** | `finance.js` |
| Справочники, оборудование (CRUD API) | `dictionaries.js` |
| Кадры, зарплата | `hr.js` |
| Печатные формы, реестр, экспорты | `docs.js` |
| Админ (бэкап, VACUUM, логи) | `admin.js` |
| Dev-only утилиты | `dev.js` (`/api/dev/...`) |

Этого достаточно, чтобы не дублировать детальный список маршрутов; точный список — **исходный код** соответствующего файла.
