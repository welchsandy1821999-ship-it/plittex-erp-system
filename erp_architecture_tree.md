# PLITTEX ERP — карта репозитория

**Обновлено:** 2026-04-24  

Карта структуры и границ ответственности. Историю фаз сюда не пишем — только актуальное состояние.

---

## 1. Верхний уровень

```text
plittex-erp/
├── web.js                 # Точка входа: Express, пул БД, Socket.io, маршруты, ERP_CONFIG
├── package.json
├── login.html             # Страница входа (вне EJS-оболочки)
├── ecosystem.config.js    # PM2 (production), при использовании
│
├── middleware/
│   ├── auth.js            # authenticateToken, requireAdmin
│   ├── rateLimit.js       # apiRateLimiter для /api
│   └── validator.js       # Централизованные проверки тела запроса (часть сценариев)
│
├── routes/                # См. §3 — все вешаются на app из web.js
├── utils/                 # См. §4
├── test/                  # Jest: интеграционные/хелперы
│
├── views/
│   ├── index.ejs          # Shell: layout + подключение модулей
│   ├── modules/           # 12 UI-модулей (см. §5)
│   ├── partials/          # layout, scripts, modals
│   └── docs/              # EJS печатных форм (УПД, акт, договор, …)
│
├── public/
│   ├── css/               # theme, layout, components, modules
│   ├── js/                # Клиентские модули (см. §5); `auth-flow.js` — только для `login.html`
│   ├── libs/              # vendor: chart, flatpickr, tom-select (см. `views/index.ejs`)
│   ├── images/
│   ├── saved_docs/        # Сгенерированные/сохранённые вложения (runtime)
│   └── uploads/           # Загрузки (multer)
│
├── .agent/workflows/      # Сценарии агента (не рантайм)
├── .antigravity/          # db_protocol, styles, rules (см. .cursorrules)
├── audit_master_list.md  # Аудит вкладок (живой чеклист)
├── erp_architecture_tree.md
├── erp_technical_docs.md
└── .cursorrules
```

---

## 2. Слой и зона ответственности

| Слой | Назначение |
|------|------------|
| `web.js` | Бутстрап, `Pool`, `io`, глобальные хелперы (`withTransaction`, `getWhId`, `getNextDocNumber`), CORS, helmet, `ERP_CONFIG`, регистрация роутеров, `/api/health`, `POST /api/generate-print-token`, затем `app.use('/api', authenticateToken)` |
| `middleware/*` | Сквозные политики: JWT, лимит запросов, валидация |
| `routes/*` | Бизнес-API по доменам; файлы — фабрики `module.exports = (pool, …) => router` |
| `views/*` | SSR-разметка; сценарий SPA внутри одной страницы (`switchModule`) |
| `public/js/*` | Логика модулей в браузере, глобальные `API`, `UI`, сокет-клиент в `core.js` |
| `public/css/*` | Тема, сетка, компоненты, модульные дополнения |
| `utils/*` | Инфра: лог, cron, бэкапы, инициализация БД, Telegram, **allocateClientAdvance** (аллокация авансов по заказам) |

---

## 3. Маршруты (файл → mount)

| Файл | Примечание |
|------|------------|
| `routes/inventory.js` | `app.use('/', …)` — склад, сушилка, закупки (API), движения |
| `routes/production.js` | Производство, рецептуры (часть путей), MRP, аналитика |
| `routes/finance.js` | Касса, транзакции, контрагенты, **дашборд-виджеты** (`/api/analytics/…`), **ожидаемые платежи** (`/api/invoices`) |
| `routes/dictionaries.js` | Справочники, **оборудование** (`/api/equipment*`) |
| `routes/hr.js` | Кадры, зарплата |
| `routes/sales.js` | Заказы, отгрузки, аналитика продаж, часть путей контрагентов |
| `routes/docs.js` | Печать, реестр, PDF/HTML документы |
| `routes/dev.js` | `app.use('/api/dev', …)` — только dev |
| `routes/admin.js` | `app.use('/api/admin', …)` — бэкапы, настройки, аудит-экспорт |

**До глобального `authenticateToken` остаются:** `GET /api/health`, `POST /api/login` (внутри роутеров/логина), `POST /api/generate-print-token` (требует сессию, выдаёт краткоживущий print-JWT).

---

## 4. `utils/`

| Файл | Роль |
|------|------|
| `logger.js` | Логирование (Winston) |
| `db_init.js` | Системные таблицы при старте, audit |
| `cron.js` | Планировщик |
| `backup.js` | Бэкапы БД |
| `telegram.js` | Бот, уведомления |
| `allocateClientAdvance.js` | FIFO-распределение несвязанных **приходов** по `client_orders` (транзакции, reconcile API) |

---

## 5. UI: модуль (`id` в sidebar) → шаблон → скрипт

| Модуль (nav) | `div#` | EJS | Основной JS |
|--------------|--------|-----|-------------|
| Дашборд | `dashboard-mod` | `views/modules/dashboard.ejs` | `public/js/dashboard.js` |
| Финансы | `fin-mod` | `views/modules/finance.ejs` | `public/js/finance.js` |
| Формовка | `prod-mod` | `views/modules/production.ejs` | `public/js/production.js` |
| Склады | `stock-mod` | `views/modules/inventory.ejs` | `public/js/inventory.js` |
| Закупки | `purchase-mod` | `views/modules/purchase.ejs` | `public/js/purchases.js` |
| Продажи | `sales-mod` | `views/modules/sales.ejs` | `public/js/sales.js` |
| Кадры/ЗП | `salary-mod` | `views/modules/salary.ejs` | `public/js/salary.js` |
| Справочники | `ref-mod` (admin) | `views/modules/references.ejs` | `public/js/references.js` |
| Реестр документов | `docs-registry-mod` (admin) | `views/modules/docs_registry.ejs` | `public/js/docs_registry.js` |
| Рецептуры | `recipe-mod` (admin) | `views/modules/recipes.ejs` | `public/js/recipes.js` |
| Оборудование | `equipment-mod` | `views/modules/equipment.ejs` | `public/js/equipment.js` |
| Админ | `admin-mod` (admin) | `views/modules/admin.ejs` | `public/js/admin.js` |

Общий рантайм: `public/js/core.js` (в т.ч. `window.API`, WebSocket), `public/js/cache.js`, порядок подключения в `views/partials/scripts.ejs`. Класс `admin-only` в nav скрывается не-админам через JWT в `startApp` в `scripts.ejs`.

---

## 6. Стили

Файлы в `public/css/`: `theme.css`, `layout.css`, `components.css`, `modules.css` (подключение в `views/index.ejs`).

---

## 7. События Socket.io (сервер → клиент)

Типовые: `inventory_updated`, `finance_updated`, `production_updated`, `sales_updated` (см. `public/js/core.js` — дебаунс, вызовы `loadTable`, `loadFinanceData`, `loadDashboardWidgets` и т.д.). `io` передаётся в роуты через `req.app.get('io')`.

---

## 8. Данные и целостность (кратко)

- Склад: **остатки** из `inventory_movements` (и связанных правил), не фиктивная «таблица баланса».
- Критичные сценарии: **транзакции БД** `withTransaction` в роутерах.
- Схема БД и миграции — по принятому в проекте процессу; канон **`.antigravity/db_protocol.md`**.

---

## 9. Политика обновления

1. Меняется структура/маршрут/модуль → **сначала** обновить этот файл и **`erp_technical_docs.md`**.  
2. Не вести здесь дневник коммитов.
