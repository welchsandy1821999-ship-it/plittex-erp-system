# Proposal: Sticky Footer + Дедупликация описаний

## 1. Sticky Footer для Сальдо

### Текущая архитектура (проблема)
```
modal-content (flex-column)
  ├── modal-header
  ├── modal-body (overflow-y: auto, max-height: 75vh)
  │     ├── filter-panel
  │     └── history-feed-container (overflow-y: auto, max-height: 60vh) ← ВЛОЖЕННЫЙ скролл
  │           ├── #history-table-body    ← карточки
  │           └── #history-table-foot    ← Сальдо (УЕЗЖАЕТ при скролле)
  ├── modal-footer
  │     └── кнопка "Закрыть"
```
Сальдо (`#history-table-foot`) находится **внутри** `history-feed-container`, после списка карточек. При длинном списке оно уезжает вниз и видно только после прокрутки всего списка до конца.

### Целевая архитектура (решение)
```
modal-content (flex-column)
  ├── modal-header
  ├── modal-body (flex: 1, overflow-y: auto)
  │     ├── filter-panel
  │     └── history-feed-container (flex: 1, overflow-y: auto)
  │           └── #history-table-body   ← только карточки
  ├── modal-footer                      ← ПЕРЕСТРОЕННЫЙ
  │     ├── #history-table-foot         ← Сальдо (ЗАЛИПАЕТ)
  │     └── кнопка "Закрыть"
```

### Конкретные правки

#### `inventory.ejs` (строки 265-278):
1. **Удаляем** `#history-table-foot` из `history-feed-container`
2. **Перемещаем** его в `modal-footer`, ДО кнопки "Закрыть"
3. Footer становится двухстрочным: верхняя строка — Сальдо, нижняя — кнопка

```html
<!-- Лента Карточек (Event Feed) -->
<div class="history-feed-container flat bg-surface-alt p-10" style="max-height: 60vh; overflow-y: auto;">
    <div id="history-table-body" style="display:flex; flex-direction:column;">
        <!-- JS Inject -->
    </div>
    <!-- #history-table-foot УБРАН ОТСЮДА -->
</div>
</div> <!-- конец modal-body -->

<div class="modal-footer flex-col gap-10">
    <div id="history-table-foot" class="w-100">
        <!-- JS Inject: Сальдо -->
    </div>
    <div class="w-100 d-flex justify-content-end">
        <button class="btn btn-outline" onclick="closeItemHistory()">Закрыть</button>
    </div>
</div>
```

#### CSS (нет новых классов!):
Используем существующий `.modal-footer`. Единственное, что нужно — **добавить вариант** для направления `.flex-col` (уже в `theme.css:114`). Но у `.modal-footer` жёстко `justify-content: flex-end`. Нужен один контекстный оверрайд:

```css
#modal-item-history .modal-footer {
    flex-direction: column;
    align-items: stretch;
}
```

#### JS (`inventory.js`): Изменений **ноль**.
Рендер `tfoot.innerHTML = ...` (строка 1484) продолжит работать как есть — он обращается к `#history-table-foot` по ID, которому всё равно, где в DOM он находится.

---

## 2. Дедупликация текста описания

### Анализ данных
SQL-запрос (строка 910) формирует описание как:
```sql
STRING_AGG(DISTINCT m.description, ' | ') as description
```
Типичные значения `m.description`:
- `"Замес: Партия П-00125, Заказ ЗК-00006"`
- `"Возврат из Резервов"`
- `"Отгрузка по заказу ЗК-00006"`

При этом чипы уже выводят:
- `Партия: #П-00125 🔗` (если `m.batch_number` не null)
- `Заказ: ЗК-00006 🔗` (если `m.order_doc` не null)

### Решение: Regex-очистка в JS
В файле `inventory.js`, строка 1465, перед рендером `mc-desc`:

```javascript
// Дедупликация: убираем из description упоминания, 
// которые уже показаны как кликабельные чипы
let cleanDesc = (m.description || '');
if (m.batch_number) {
    // "Партия П-00125" или "Партия: П-00125" или "Партия #П-00125"
    cleanDesc = cleanDesc.replace(/,?\s*Партия[:\s#]*\S+/gi, '');
}
if (m.order_doc) {
    // "Заказ ЗК-00006" или "заказу ЗК-00006" или "Заказ: ЗК-00006"
    cleanDesc = cleanDesc.replace(/,?\s*(?:Заказ[у]?|по заказу)[:\s]*ЗК-\d+/gi, '');
}
// Чистим мусор: ведущие/замыкающие запятые, пробелы, разделители " | "
cleanDesc = cleanDesc.replace(/^[\s,|]+|[\s,|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
```

Затем строка 1465 меняется с:
```javascript
${m.description ? `<div class="mc-desc">...` : ''}
```
на:
```javascript
${cleanDesc ? `<div class="mc-desc">${Utils.escapeHtml(cleanDesc)}</div>` : ''}
```

### Примеры работы RegExp:
| Вход (`m.description`) | `batch_number` | `order_doc` | Результат |
|---|---|---|---|
| `Замес: Партия П-00125, Заказ ЗК-00006` | `П-00125` | `ЗК-00006` | `Замес:` → `Замес` |
| `Возврат из Резервов` | null | null | `Без изменений` |
| `Отгрузка по заказу ЗК-00006` | null | `ЗК-00006` | `Отгрузка` |
| `Партия П-00125` | `П-00125` | null | `` (скрывается полностью) |

---

## Итого: Объём правок

| Файл | Тип | Объём |
|---|---|---|
| `inventory.ejs` | Перенос `#history-table-foot` | ~5 строк |
| `modules.css` | 1 контекстный оверрайд footer | 4 строки |
| `inventory.js` | Regex перед рендером | ~8 строк |

**Новых CSS-классов:** 0. Используются только существующие.
**Новых HTML-элементов:** 0. Переносим уже существующий `div`.
**Риск регрессии:** Минимальный — `tfoot.innerHTML` обращается по ID `#history-table-foot`, а getElementById не зависит от позиции в DOM.

Жду подтверждения от Архитектора перед выполнением.
