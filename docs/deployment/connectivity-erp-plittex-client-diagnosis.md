# Доступность erp.plittex.ru: диагностика и миграция на Cloudflare

**Обновлено:** 2026-06-06 (v3 — решение через Cloudflare)  
**Домен:** `erp.plittex.ru`  
**Origin (Beget VPS):** `159.194.207.6`  
**Приложение:** Socket.io на `/socket.io/` (дашборды, realtime)

---

## 1. Зафиксированное состояние серверной части

| Компонент | Статус | Примечание |
|-----------|--------|------------|
| **Nginx** | Работает | HTTPS на `:443`, прокси на `127.0.0.1:3000` |
| **SSL (Let's Encrypt RSA)** | Работает | Валидный сертификат на origin; **оставляем без изменений** |
| **PM2 / Node** | Работает | `plittex-erp` online |
| **Socket.io** | Работает | Отдельный `location /socket.io/` в nginx |

**Вывод:** Ubuntu/Nginx/PM2 **исправны**. Менять конфигурацию сервера для Cloudflare **не требуется**.

---

## 2. Симптомы и установленная причина

| Клиент | Wi‑Fi (общий IP с ПК) | LTE |
|--------|------------------------|-----|
| **Десктоп** | ✅ | ✅ |
| **Мобильный** | ❌ reset/timeout | ❌ reset/timeout |

- Блокировка **не** по публичному IP клиента (ПК и телефон на одной Wi‑Fi — разное поведение).
- Запросы с телефона часто **не доходят** до `access.log` nginx → отсев на **периметре хостинга Beget**.
- **Подтверждённая причина:** фильтрация **TLS fingerprint** (JA3/JA4) сетевым экраном / anti-DDoS хостинга — режет мобильные ClientHello, пропускает десктопные.

**IPv6** остаётся вторичной гипотезой; основной блок — **TLS на стороне Beget**.

---

## 3. Принятое решение

**Проксирование `erp.plittex.ru` через Cloudflare (тариф Free).**

| Зачем | Как |
|-------|-----|
| Обход TLS-блокировки Beget | Клиент (в т.ч. мобильный) устанавливает TLS с **Cloudflare**, не с IP `159.194.207.6` |
| Сохранить HTTPS на origin | Режим **Full** или **Full (strict)** — nginx продолжает отдавать Let's Encrypt |
| Realtime | **WebSockets: ON** в Cloudflare → socket.io через `/socket.io/` |

Изменения **только** в панели Cloudflare и у **регистратора DNS** (NS). **SSH на сервер не нужен.**

---

## 4. Архитектура после миграции

```
[Браузер / мобильный] ──TLS──► [Cloudflare edge] ──TLS──► [159.194.207.6 nginx:443] ──► [PM2 :3000]
                                      │                              │
                              Universal SSL                  Let's Encrypt (как сейчас)
                              WebSockets ON                  location / + /socket.io/
```

---

## 5. Историческая диагностика (архив)

Разделы 5–8 ниже сохранены как контекст расследования (IPv6, curl-тесты, трассировка). Для внедрения используйте **раздел 10**.

<details>
<summary>Раздел 5–8 — планы диагностики (свернуть)</summary>

### Отвергнуто

Магистральная блокировка РКН/ТСПУ по IP — несостоятельна (один Wi‑Fi, разное поведение ПК/телефон).

### Гипотеза IPv6

```cmd
nslookup -type=A erp.plittex.ru
nslookup -type=AAAA erp.plittex.ru
curl.exe -v -4 --max-time 15 https://erp.plittex.ru/
curl.exe -v -6 --max-time 15 https://erp.plittex.ru/
```

### Гипотеза TLS fingerprint (подтверждена → Cloudflare)

```cmd
curl.exe -v --max-time 15 https://erp.plittex.ru/
curl.exe -v -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ..." https://erp.plittex.ru/
```

### Трассировка (вторично)

```cmd
tracert -d erp.plittex.ru
pathping -n -q 1 -p 50 erp.plittex.ru
```

</details>

---

## 10. Пошаговая инструкция: Cloudflare Free (только панели CF и регистратора)

> **Важно:** смена NS делегирует DNS-зону **`plittex.ru`** Cloudflare. Перед сменой **экспортируйте все текущие DNS-записи** у регистратора (почта, `@`, `www`, другие поддомены) и **воссоздайте их** в Cloudflare, иначе пострадают другие сервисы домена.

### Шаг 1. Регистрация и добавление сайта (Cloudflare)

1. Откройте [https://dash.cloudflare.com](https://dash.cloudflare.com) и войдите (или создайте аккаунт).
2. **Add a site** → введите **`plittex.ru`** (корневая зона; поддомен `erp` настраивается записью внутри зоны).
3. Выберите план **Free** → **Continue**.
4. На шаге **DNS Records** Cloudflare просканирует существующие записи. **Проверьте список** — при необходимости добавьте вручную записи, которых не хватает (MX, TXT, другие A/CNAME).

### Шаг 2. DNS-запись для ERP (оранжевое облако)

1. В зоне **`plittex.ru`** → **DNS** → **Records**.
2. Найдите или **Add record**:
   - **Type:** `A`
   - **Name:** `erp` (полное имя: `erp.plittex.ru`)
   - **IPv4 address:** `159.194.207.6`
   - **Proxy status:** **Proxied** (оранжевое облако ☁️ включено) — **обязательно**
   - **TTL:** Auto
3. **Save**.

Запись в режиме **DNS only** (серое облако) **не** скроет origin от Beget и **не решит** проблему мобильного TLS.

### Шаг 3. Смена NS у регистратора домена

1. Cloudflare покажет два nameserver'а, например:
   - `ada.ns.cloudflare.com`
   - `bob.ns.cloudflare.com`  
   (у вас будут **ваши** имена — скопируйте из панели.)
2. В панели **регистратора** домена `plittex.ru` (не Beget VPS, а там, где куплен домен):
   - Раздел **DNS / Nameservers / Делегирование**
   - Замените текущие NS на **два NS от Cloudflare**
   - Сохраните.
3. В Cloudflare дождитесь статуса зоны **Active** (обычно от 15 минут до 24–48 часов).

Пока NS не переключились, Cloudflare-прокси **не работает** для пользователей.

### Шаг 4. SSL/TLS — критично: Full или Full (strict)

1. Cloudflare → **`plittex.ru`** → **SSL/TLS** → **Overview**.
2. **Encryption mode:**
   - Выберите **Full (strict)** — **рекомендуется** (на origin уже валидный Let's Encrypt для `erp.plittex.ru`).
   - Допустимо **Full**, если strict временно ругается на сертификат (менее строгая проверка origin).

| Режим | Поведение | Для нас |
|-------|-----------|---------|
| **Flexible** | Клиент→CF: HTTPS, CF→origin: **HTTP** | ❌ **Нельзя.** Nginx редиректит HTTP→HTTPS → **цикл редиректов**, сайт «ломается» |
| **Full** | CF→origin: HTTPS, cert origin не проверяется | ✅ OK |
| **Full (strict)** | CF→origin: HTTPS, cert origin **должен быть валидным** | ✅ **Лучший выбор** |

3. Опционально: **SSL/TLS** → **Edge Certificates** → включить **Always Use HTTPS** (после установки Full/Strict).

**На сервере** сертификат Let's Encrypt и `listen 443 ssl` **не трогаем**.

### Шаг 5. WebSockets — критично для socket.io

1. Cloudflare → **`plittex.ru`** → **Network**.
2. Найдите **WebSockets**.
3. Убедитесь, что переключатель **ON** (включён).

Без этого long-polling может частично работать, но **WebSocket-транспорт socket.io** для дашбордов будет нестабилен или отвалится.

Путь приложения **`/socket.io/`** менять не нужно — Cloudflare проксирует тот же URL.

### Шаг 6. Проверка после активации

Выполнить **с мобильного телефона** (LTE и Wi‑Fi):

1. Открыть `https://erp.plittex.ru/` — страница логина/ERP загружается.
2. Войти в систему — дашборд обновляется без ошибок (socket.io).
3. На ПК: `nslookup erp.plittex.ru` — A-запись должна указывать на **IP Cloudflare** (не `159.194.207.6`), если запись Proxied.

При **525 SSL handshake failed** (strict): проверить, что на origin nginx отдаёт валидный LE-сертификат для `erp.plittex.ru` (на сервере уже OK по прошлым проверкам) или временно **Full** вместо strict.

При **redirect loop**: почти всегда включён **Flexible** — переключить на **Full (strict)**.

---

## 11. Что **не** делаем на сервере (Beget VPS)

| Действие | Нужно? |
|----------|--------|
| Правка `/etc/nginx/sites-available/plittex-erp` | ❌ Нет |
| Перевыпуск Let's Encrypt «под Cloudflare» | ❌ Нет (origin cert остаётся) |
| Смена порта PM2 / `web.js` | ❌ Нет |
| Установка cloudflared / tunnel | ❌ Нет (используем DNS proxy, не Tunnel) |
| Открытие Real IP в nginx | ⚪ Опционально позже (`CF-Connecting-IP`); для работы сайта не обязательно |

---

## 12. Чеклист внедрения

- [ ] Сайт `plittex.ru` добавлен в Cloudflare, план **Free**
- [ ] Все старые DNS-записи перенесены в Cloudflare
- [ ] `A` **`erp`** → `159.194.207.6`, **Proxied** (оранжевое облако)
- [ ] NS у регистратора заменены на Cloudflare, зона **Active**
- [ ] SSL/TLS: **Full (strict)** или **Full** — **не Flexible**
- [ ] **Network → WebSockets: ON**
- [ ] Мобильный: сайт открывается, socket.io работает

---

## 13. Связанные документы

- `erp_technical_docs.md` — стек, Socket.io, CORS.
- `docs/deployment/postgresql-ubuntu-production.md` — PostgreSQL на Ubuntu.
