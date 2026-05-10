# PostgreSQL 17 на Ubuntu: чистая установка на порт 5432 (боевой сервер)

Инструкция для сценария: на хосте несколько версий PostgreSQL (например, 16 на `5432` и 17 на `5433`), данные восстанавливаются из **`plittex_final.sql`**. Файл **`.env` на сервере уникальный** — не подменять репозиторием, только точечно править `DB_PORT`, при необходимости **`DB_USER` / `DB_PASSWORD` / `DB_NAME`**.

Приложение читает из окружения (см. `web.js`): **`DB_HOST`**, **`DB_PORT`**, **`DB_USER`**, **`DB_PASSWORD`**, **`DB_NAME`**.

---

## Пре-чек перед удалением

Выполните **до** остановки PostgreSQL и purge, если на порту **5432** ещё есть рабочая база **`plittex_erp`** и вы хотите дополнительную страховку поверх уже имеющегося `plittex_final.sql`.

- Убедитесь, что хватает места на диске (размер дампа может быть сопоставим с объёмом БД).
- Файл будет принадлежать root; при необходимости позже скопируйте его в каталог бэкапов.

**Экстренный дамп текущей базы с порта 5432:**

```bash
sudo -u postgres pg_dump -p 5432 plittex_erp > /root/emergency_backup_before_purge.sql
```

Если база или порт другие — замените **`plittex_erp`** и **`-p 5432`** на фактические значения с боевого сервера.

---

## Фаза 0: анализ (на хосте Ubuntu, перед зачисткой)

Агент в IDE **не имеет доступа** к вашему серверу и **не может** открыть боевой `.env`. Оператор выполняет команды ниже локально по SSH.

### 0.1. Текущие переменные БД (имена ключей без обязательного вывода значений секретов)

Показать только ключи и длину значения пароля:

```bash
cd /path/to/plittex-erp   # каталог приложения на сервере
grep -E '^DB_' .env | sed -E 's/^(DB_PASSWORD=).*/\1***redacted***/'
```

Убедиться вручную, что указаны строки **`DB_HOST`**, **`DB_PORT`**, **`DB_USER`**, **`DB_NAME`**, **`DB_PASSWORD`** (названия ключей именно такие).

### 0.2. Какие кластеры и порты слушают сейчас

```bash
sudo ss -lntp | grep -E 'postgres|:5432|:5433'
sudo systemctl status postgresql --no-pager || true
pg_lsclusters 2>/dev/null || true
```

### 0.3. Проверка подключения к «боевой» паре порт/база (подставьте значения из `.env`)

```bash
export PGPASSWORD='***'   # временно из .env, не сохранять в истории — лучше .pgpass
psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER}" -d "${DB_NAME}" -c 'SELECT version();'
```

SQL для проверки после миграции:

```sql
SELECT version();
SHOW port;
SELECT current_database(), current_user;
```

### 0.4. Инвентаризация версий APT

```bash
dpkg -l | grep -E 'postgresql-|postgres'
```

### 0.5. Готовность к полной зачистке — чек-лист

- [ ] Актуальный дамп **`plittex_final.sql`** лежит на сервере (или доступен по безопасному каналу).
- [ ] Остановлены все зависящие от БД службы приложения (**PM2** и т.д.).
- [ ] Принято решение: **данные только из дампа**; каталоги `/var/lib/postgresql/` после purge будут уничтожены.
- [ ] Пароль роли приложения известен или будет задан заново и **записан в `.env`** без замены файла целиком.

Пока эти пункты не подтверждены, **полный purge не выполнять**.

---

## Фаза 1: остановка приложения

```bash
pm2 stop all
pm2 save
```

(При необходимости отключить автозапуск до окончания работ: `pm2 startup`/`pm2 unstartup` — по вашей политике хоста.)

---

## Фаза 2: остановка PostgreSQL

```bash
sudo systemctl stop postgresql || true
sudo systemctl disable postgresql@16-main postgresql@17-main 2>/dev/null || true
```

Имена unit-файлов уточните: `systemctl list-units 'postgresql*'`.

---

## Фаза 3: удаление пакетов (purge)

Пакеты на разных машинах могут называться чуть иначе. Сверка перед purge:

```bash
dpkg -l | grep -i postgres
```

Пример удаления кластеров 16 и 17 и общих клиентских пакетов (адаптируйте список под вывод `dpkg -l`):

```bash
sudo apt purge -y \
  postgresql-client-17 postgresql-contrib-17 postgresql-17 \
  postgresql-client-16 postgresql-contrib-16 postgresql-16 \
  'postgresql-*' \
  postgresql-client postgresql-common
sudo apt autoremove -y --purge
```

Если последняя строка с `'postgresql-*'` слишком агрессивна, удалите вручную только те метапакеты, которые реально установлены.

---

## Фаза 4: очистка каталогов данных и конфигов

```bash
sudo rm -rf /etc/postgresql
sudo rm -rf /var/lib/postgresql/*
```

Убедитесь, что **нет нужных WAL/бэкапов** только здесь — после шага они исчезнут.

---

## Фаза 5: установка PostgreSQL 17 (официальный репозиторий PGDG на Ubuntu)

Актуальные шаги см. на [PostgreSQL Linux downloads (Ubuntu)](https://www.postgresql.org/download/linux/ubuntu/). Типовая последовательность:

```bash
sudo apt install -y postgresql-common curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
sudo apt update
sudo apt install -y postgresql-17
sudo systemctl enable --now postgresql
```

Стандартный кластер **`17/main`** слушает **5432**.

Проверка порта **обязательна** после установки (процессы, слушающие TCP/UDP):

```bash
sudo ss -tulpn | grep 5432
```

Дополнительно версия Postgres и номер порта из настроек кластера:

```bash
sudo -u postgres psql -c "SHOW port;"
sudo -u postgres psql -c "SELECT version();"
```

Если на 5432 сидит процесс не PostgreSQL — освободите порт **до** или **после** остановки старого кластера и перезапустите службу **`postgresql`**.

---

## Фаза 6: роль `plittex` и база `plittex_erp`

Пароль замените на свой (и тот же укажите в `.env` как **`DB_PASSWORD`**):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE plittex WITH LOGIN PASSWORD 'REPLACE_ME_STRONG_PASSWORD';
CREATE DATABASE plittex_erp OWNER plittex;
GRANT ALL PRIVILEGES ON DATABASE plittex_erp TO plittex;
SQL
```

После восстановления из дампа возможно понадобятся дополнительные **`GRANT`** на схемы/таблицы — зависит от того, как собран **`plittex_final.sql`** (владельцы объектов в дампе). При ошибках прав см. ниже раздел про владение.

---

## Фаза 7: импорт `plittex_final.sql`

Обычно (plain SQL):

```bash
sudo -u postgres psql -d plittex_erp -v ON_ERROR_STOP=1 -f /path/to/plittex_final.sql
```

Если дамп собран через `pg_restore` в custom-формате — используйте `pg_restore`, не `psql`.

При конфликтах владельцев объектов возможны пересоздание с:

```bash
pg_restore ... --no-owner --no-privileges ...
```

или правка дампа до импорта — по ситуации.

Кодировка: приложение ожидает UTF‑8 (`web.js` выставляет `client_encoding`). Дамп желательно в UTF‑8.

### Владение объектами и права приложения (обязательно проверить)

Если дамп восстанавливали от имени **`postgres`**, а в `.env` указана роль **`plittex`**, приложение при старте выполняет `initSystemTables()` (`utils/db_init.js`): `ALTER TABLE`, `CREATE INDEX` на существующих таблицах. Без прав владельца возможны ошибки в логах PM2:

- `must be owner of table report_runs`
- `permission denied for table users`

После импорта выполните от суперпользователя Postgres (имена базы и роли замените на свои из `.env`):

```sql
\c your_database_name
REASSIGN OWNED BY postgres TO plittex;
```

Если владелец объектов не `postgres`, сначала посмотрите `tableowner` в `pg_tables`, затем примените `REASSIGN OWNED BY <старый_владелец> TO plittex;`. Подробнее и про колонку `is_deleted` — файл **`docs/deployment/http500-after-postgres-migration-TODO.md`**.

---

## Фаза 8: точечное изменение `.env` на сервере

Не копировать `.env` из репозитория. Отредактировать существующий файл, минимально:

| Ключ           | Значение после переноса        |
|----------------|---------------------------------|
| `DB_PORT`      | `5432`                          |
| `DB_HOST`      | как было (часто `localhost`) |
| `DB_NAME`      | `plittex_erp` (если совпадает с созданной БД) |
| `DB_USER`      | `plittex` (если создана такая роль) |
| `DB_PASSWORD`  | пароль роли **`plittex`**       |

Проверка с теми же переменными, что после правки:

```bash
grep -E '^DB_' .env | sed -E 's/^(DB_PASSWORD=).*/\1***redacted***/'
node -e "require('dotenv').config(); console.log('port',process.env.DB_PORT,'db',process.env.DB_NAME)"
```

Подключение:

```bash
psql -h localhost -p 5432 -U plittex -d plittex_erp -c 'SELECT 1;'
```

---

## Фаза 9: запуск приложения

```bash
cd /path/to/plittex-erp
pm2 start ecosystem.config.*   # ваш файл
pm2 save
```

Проверьте логи на ошибки пула PostgreSQL.

---

## Промежуточные сохранения состояния

- Перед purge: сохранён **`plittex_final.sql`**, сохранено содержимое критичных конфигов (если нужны вне дампа): `postgresql.conf`, `pg_hba.conf` (**пути до purge**: обычно `/etc/postgresql/<версия>/<кластер>/`).
- После установки PG17: выписки `SHOW port`, `SELECT version()`, вывод успешного `psql -c SELECT 1` от пользователя приложения.

---

## Справочно: переменные в репозитории

Пример ключей см. `.env.example` (имена переменные совпадают; значения имени базы и пользователя в вашем задаче могут быть **`plittex` / `plittex_erp`**, а не как в примере).

---

## Сводка команд: PostgreSQL 17 на порт 5432 (ручной ввод по SSH)

Команды по порядку. Пути (`/path/to/plittex_final.sql`) и имена systemd-юнитов при необходимости подставьте свои. Пароли и секреты в чат не копировать.

```bash
# 0 — страховка (если нужен доп. дамп с текущего 5432)
sudo -u postgres pg_dump -p 5432 plittex_erp > /root/emergency_backup_before_purge.sql

# 1 — приложение
pm2 stop all
pm2 save

# 2 — Postgres
sudo systemctl stop postgresql || true

# 3 — удаление пакетов (список уточните: dpkg -l | grep -i postgres)
sudo apt purge -y postgresql-client-17 postgresql-contrib-17 postgresql-17 \
  postgresql-client-16 postgresql-contrib-16 postgresql-16 \
  postgresql-client postgresql-common || true
sudo apt autoremove -y --purge

# 4 — каталоги данных и конфигов
sudo rm -rf /etc/postgresql /var/lib/postgresql/*

# 5 — PostgreSQL 17 из PGDG
sudo apt install -y postgresql-common curl ca-certificates lsb-release
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
sudo apt update
sudo apt install -y postgresql-17
sudo systemctl enable --now postgresql

# 6 — проверка: слушает ли 5432 postgres
sudo ss -tulpn | grep 5432

# 7 — роль и БД (пароль свой; совпадает с DB_PASSWORD в .env)
sudo -u postgres psql <<'SQL'
CREATE ROLE plittex WITH LOGIN PASSWORD 'REPLACE_ME_STRONG_PASSWORD';
CREATE DATABASE plittex_erp OWNER plittex;
GRANT ALL PRIVILEGES ON DATABASE plittex_erp TO plittex;
SQL

# 8 — импорт основного дампа
sudo -u postgres psql -d plittex_erp -v ON_ERROR_STOP=1 -f /path/to/plittex_final.sql

# 9 — правка .env приложения только точечно: DB_PORT=5432, DB_NAME, DB_USER, DB_PASSWORD по факту
# затем
pm2 start …
pm2 save
```

Ссылки: [PostgreSQL: установка под Ubuntu](https://www.postgresql.org/download/linux/ubuntu/).
