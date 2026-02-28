// === public/js/references.js ===

let currentRefPage = 1;
let refSearchTimeout = null;

// Инициализация при открытии приложения
async function loadReferences(page = 1) {
    currentRefPage = page;

    const search = document.getElementById('ref-search').value;
    const itemType = document.getElementById('ref-filter-type').value;
    const category = document.getElementById('ref-filter-category').value;

    try {
        // 1. Обновляем список категорий в фильтрах (если это первая загрузка)
        await updateCategoryFilters();

        // 2. Загружаем сами товары
        const url = `/api/items?page=${page}&limit=50&search=${encodeURIComponent(search)}&item_type=${itemType}&category=${encodeURIComponent(category)}`;
        const res = await fetch(url);
        const data = await res.json();

        renderRefTable(data.data);
        document.getElementById('ref-page-info').innerText = `Страница ${data.currentPage} из ${data.totalPages} (Всего позиций: ${data.total})`;
    } catch (e) { console.error("Ошибка загрузки справочников:", e); }
}

// Загрузка динамических категорий с сервера
async function updateCategoryFilters() {
    try {
        const res = await fetch('/api/categories');
        const categories = await res.json();

        // Обновляем фильтр-селект
        const catSelect = document.getElementById('ref-filter-category');
        const currentVal = catSelect.value;
        catSelect.innerHTML = '<option value="">🌐 Все категории</option>';
        categories.forEach(c => catSelect.add(new Option(c, c)));
        catSelect.value = currentVal; // Сохраняем выбранное значение

        // Обновляем подсказки (Datalist) для формы добавления
        const dataList = document.getElementById('dl-categories');
        dataList.innerHTML = '';
        categories.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            dataList.appendChild(opt);
        });
    } catch (e) { }
}

// Умный поиск (задержка 0.4 сек, чтобы не спамить сервер при каждом нажатии клавиши)
function debounceRefLoad() {
    clearTimeout(refSearchTimeout);
    refSearchTimeout = setTimeout(() => {
        loadReferences(1);
    }, 400);
}

// Отрисовка таблицы
function renderRefTable(items) {
    const tbody = document.getElementById('ref-table-body');
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Ничего не найдено</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr style="transition: 0.2s;" onmouseover="this.style.backgroundColor='#f1f5f9'" onmouseout="this.style.backgroundColor=''">
            <td style="color: var(--text-muted); font-size: 12px;">#${item.id}</td>
            <td><span class="badge ${item.item_type === 'product' ? 'badge-prod' : 'badge-mat'}">${item.item_type === 'product' ? '📦 Продукция' : '🪨 Сырье'}</span></td>
            <td><strong style="color: var(--text-muted);">${item.category || '-'}</strong></td>
            <td style="font-weight: 600; color: var(--text-main); cursor: pointer;" onclick="editReference(${item.id})">${item.name}</td>
            <td>${item.unit}</td>
            <td><span style="color: var(--primary); font-weight: bold;">${parseFloat(item.current_price).toFixed(2)} ₽</span></td>
            <td style="text-align: right;">
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; margin-right: 5px;" onclick="editReference(${item.id})">✏️</button>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" onclick="deleteReference(${item.id}, '${item.name}')">❌</button>
            </td>
        </tr>
    `).join('');
}

// === УПРАВЛЕНИЕ ФОРМОЙ ===

function openRefForm() {
    document.getElementById('ref-form-container').style.display = 'block';
    document.getElementById('ref-form-title').innerText = '✨ Добавление новой позиции';
    clearRefForm();
}

function closeRefForm() {
    document.getElementById('ref-form-container').style.display = 'none';
    clearRefForm();
}

function clearRefForm() {
    document.getElementById('ref-edit-id').value = '';
    document.getElementById('ref-name').value = '';
    document.getElementById('ref-category').value = '';
    document.getElementById('ref-price').value = '0';
    document.getElementById('ref-weight').value = '0';
    document.getElementById('ref-type').value = 'product';
    document.getElementById('ref-unit').value = 'кг';
}

// Загрузка данных в форму для редактирования
function editReference(id) {
    openRefForm();
    document.getElementById('ref-form-title').innerText = '✏️ Редактирование позиции (ID: ' + id + ')';

    // Ищем товар в уже загруженной таблице (чтобы не делать лишний запрос)
    fetch(`/api/items?search=&item_type=&category=`) // Небольшой хак: проще всего достать напрямую, но лучше сделаем запрос
        .then(res => res.json())
        .then(data => {
            const item = data.data.find(i => i.id === id);
            if (item) {
                document.getElementById('ref-edit-id').value = item.id;
                document.getElementById('ref-name').value = item.name;
                document.getElementById('ref-category').value = item.category || '';
                document.getElementById('ref-unit').value = item.unit;
                document.getElementById('ref-price').value = parseFloat(item.current_price);
                document.getElementById('ref-weight').value = parseFloat(item.weight_kg);
                document.getElementById('ref-type').value = item.item_type;

                // Прокручиваем наверх к форме
                document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
}

// Сохранение (Добавление / Обновление)
async function saveReference() {
    const id = document.getElementById('ref-edit-id').value;
    const payload = {
        name: document.getElementById('ref-name').value.trim(),
        item_type: document.getElementById('ref-type').value,
        category: document.getElementById('ref-category').value.trim(),
        unit: document.getElementById('ref-unit').value.trim(),
        price: parseFloat(document.getElementById('ref-price').value) || 0,
        weight: parseFloat(document.getElementById('ref-weight').value) || 0
    };

    if (!payload.name) return UI.toast('Укажите название позиции!', 'error'); // Замена alert

    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/items/${id}` : '/api/items';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            UI.toast(id ? '✅ Позиция обновлена!' : '✅ Позиция добавлена!', 'success');
            closeRefForm();
            loadReferences(currentRefPage);
            if (typeof loadProducts === 'function') loadProducts();
        } else {
            UI.toast('Ошибка: ' + await res.text(), 'error');
        }
    } catch (e) { console.error(e); }
}

window.deleteReference = function (id, name) {
    const html = `
        <p>Вы уверены, что хотите удалить <b>"${name}"</b>?</p>
        <p style="font-size: 12px; color: var(--danger); margin-top: 10px;">
            ⚠️ База данных запретит удаление, если этот товар используется в рецептах или уже есть на складе.
        </p>
    `;
    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-red" onclick="confirmDeleteRef(${id})">Удалить навсегда</button>
    `;
    UI.showModal('Удаление из справочника', html, buttons);
};

window.confirmDeleteRef = async function (id) {
    try {
        const res = await fetch(`/api/items/${id}`, { method: 'DELETE' });
        if (res.ok) {
            UI.closeModal();
            UI.toast('Позиция удалена', 'success');
            loadReferences(currentRefPage);
            if (typeof loadProducts === 'function') loadProducts();
        } else {
            UI.toast('Нельзя удалить: товар используется в системе', 'error');
        }
    } catch (e) { console.error(e); }
};

function changeRefPage(dir) {
    const newPage = currentRefPage + dir;
    if (newPage > 0) loadReferences(newPage);
}