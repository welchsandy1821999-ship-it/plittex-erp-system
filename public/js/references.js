// === public/js/references.js ===

let currentRefPage = 1;
let refSearchTimeout = null;

// Инициализация при открытии приложения
async function loadReferences(page = 1) {
    currentRefPage = page;
    const search = document.getElementById('ref-search').value;
    let itemType = document.getElementById('ref-filter-type').value;

    // ИСПРАВЛЕНИЕ: Если выбраны "Все виды", сбрасываем фильтр для сервера
    if (itemType === 'all') {
        itemType = '';
    }

    const category = document.getElementById('ref-filter-category').value;

    try {
        await updateCategoryFilters();
        const url = `/api/items?page=${page}&limit=50&search=${encodeURIComponent(search)}&item_type=${itemType}&category=${encodeURIComponent(category)}`;
        const res = await fetch(url);
        const data = await res.json();

        renderRefTable(data.data);
        document.getElementById('ref-page-info').innerText = `Страница ${data.currentPage} из ${data.totalPages} (Всего позиций: ${data.total})`;
    } catch (e) { console.error("Ошибка загрузки справочников:", e); }
}

async function updateCategoryFilters() {
    try {
        const res = await fetch('/api/categories');
        const categories = await res.json();
        const catSelect = document.getElementById('ref-filter-category');
        const currentVal = catSelect.value;
        catSelect.innerHTML = '<option value="">🌐 Все категории</option>';
        categories.forEach(c => catSelect.add(new Option(c, c)));
        catSelect.value = currentVal;

        const dataList = document.getElementById('dl-categories');
        dataList.innerHTML = '';
        categories.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            dataList.appendChild(opt);
        });
    } catch (e) {
        console.error("Ошибка обновления категорий:", e);
        UI.toast('Не удалось обновить список категорий', 'error');
    }
}

function debounceRefLoad() {
    clearTimeout(refSearchTimeout);
    refSearchTimeout = setTimeout(() => { loadReferences(1); }, 400);
}

function renderRefTable(items) {
    const tbody = document.getElementById('ref-table-body');
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Ничего не найдено</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr style="transition: 0.2s;">
            <td style="color: var(--text-muted); font-size: 12px;">#${item.id}</td>
            <td><span class="badge ${item.item_type === 'product' ? 'badge-prod' : 'badge-mat'}">${item.item_type === 'product' ? '📦 Продукция' : '🪨 Сырье'}</span></td>
            <td><strong style="color: var(--text-muted);">${item.category || '-'}</strong></td>
            
            <td style="font-family: monospace; font-size: 13px; font-weight: bold; color: var(--primary);">
                ${item.article || '<span style="color: var(--border); font-weight: normal;">—</span>'}
            </td>

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

// === УПРАВЛЕНИЕ ФОРМОЙ И МАТРИЦАМИ ===

function openRefForm() {
    document.getElementById('ref-form-container').style.display = 'block';
    document.getElementById('ref-form-title').innerText = '✨ Добавление новой позиции';
    clearRefForm();
    loadMoldsForRefs(); // Загружаем матрицы при открытии
    document.getElementById('ref-type').dispatchEvent(new Event('change'));
}

function closeRefForm() {
    document.getElementById('ref-form-container').style.display = 'none';
    clearRefForm();
}

function clearRefForm() {
    document.getElementById('ref-edit-id').value = '';
    document.getElementById('ref-article').value = '';
    document.getElementById('ref-name').value = '';
    document.getElementById('ref-category').value = '';
    document.getElementById('ref-price').value = '0';
    document.getElementById('ref-weight').value = '0';
    document.getElementById('ref-type').value = 'product';
    document.getElementById('ref-unit').value = 'кг';
    document.getElementById('ref-qty-cycle').value = '1';
    const moldSel = document.getElementById('ref-mold-id');
    if (moldSel) moldSel.value = '';
    const gostEl = document.getElementById('ref-gost');
    if (gostEl) gostEl.value = '';
}

function editReference(id) {
    openRefForm();
    document.getElementById('ref-form-title').innerText = '✏️ Редактирование позиции (ID: ' + id + ')';

    fetch(`/api/items?limit=1000`)
        .then(res => res.json())
        .then(data => {
            const item = data.data.find(i => i.id === id);
            if (item) {
                document.getElementById('ref-edit-id').value = item.id;
                document.getElementById('ref-article').value = item.article || '';
                document.getElementById('ref-name').value = item.name;
                document.getElementById('ref-category').value = item.category || '';
                document.getElementById('ref-unit').value = item.unit;
                document.getElementById('ref-price').value = parseFloat(item.current_price);
                document.getElementById('ref-weight').value = parseFloat(item.weight_kg);
                document.getElementById('ref-type').value = item.item_type;
                document.getElementById('ref-qty-cycle').value = item.qty_per_cycle || 1;
                const gostEl = document.getElementById('ref-gost');
                if (gostEl) gostEl.value = item.gost_mark || '';

                // Ставим таймаут, чтобы дать матрицам долю секунды на загрузку с сервера
                setTimeout(() => {
                    const moldSel = document.getElementById('ref-mold-id');
                    if (moldSel) moldSel.value = item.mold_id || '';
                }, 100);

                document.getElementById('ref-type').dispatchEvent(new Event('change'));
                document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
}

async function saveReference() {
    const id = document.getElementById('ref-edit-id').value;
    const payload = {
        name: document.getElementById('ref-name').value.trim(),
        article: document.getElementById('ref-article').value.trim(),
        item_type: document.getElementById('ref-type').value,
        category: document.getElementById('ref-category').value.trim(),
        unit: document.getElementById('ref-unit').value.trim(),
        price: parseFloat(document.getElementById('ref-price').value) || 0,
        weight: parseFloat(document.getElementById('ref-weight').value) || 0,
        qty_per_cycle: parseFloat(document.getElementById('ref-qty-cycle').value) || 1,
        mold_id: document.getElementById('ref-mold-id').value || null,
        gost_mark: document.getElementById('ref-gost') ? document.getElementById('ref-gost').value.trim() : ''
    };

    if (!payload.name) return UI.toast('Укажите название позиции!', 'error');

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

// Загрузка списка матриц с сервера
async function loadMoldsForRefs() {
    try {
        const res = await fetch('/api/equipment');
        const eq = await res.json();
        const sel = document.getElementById('ref-mold-id');
        if (!sel) return;

        sel.innerHTML = '<option value="">-- Без матрицы --</option>';
        eq.filter(e => e.equipment_type === 'mold').forEach(m => {
            const amort = (parseFloat(m.purchase_cost) / parseInt(m.planned_cycles)).toFixed(2);
            sel.add(new Option(`${m.name} (${amort} ₽/удар)`, m.id));
        });
    } catch (e) { console.error("Ошибка загрузки матриц", e); }
}

// Слушатель переключения видимости полей (Сырье или Продукция)
document.addEventListener('DOMContentLoaded', () => {
    const typeSelect = document.getElementById('ref-type');
    if (typeSelect) {
        typeSelect.addEventListener('change', function () {
            const isProd = this.value === 'product';
            const groupQty = document.getElementById('group-qty-cycle');
            const groupMold = document.getElementById('group-mold-select');
            const groupGost = document.getElementById('group-gost');

            if (groupQty) groupQty.style.display = isProd ? 'block' : 'none';
            if (groupMold) groupMold.style.display = isProd ? 'block' : 'none';
            if (groupGost) groupGost.style.display = isProd ? 'block' : 'none';
        });
    }
});