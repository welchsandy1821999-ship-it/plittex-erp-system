; (function () {
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
            const data = await API.get(url);

            renderRefTable(data.data);
            document.getElementById('ref-page-info').innerText = `Страница ${data.currentPage} из ${data.totalPages} (Всего позиций: ${data.total})`;
        } catch (e) { console.error("Ошибка загрузки справочников:", e); }
    }

    async function updateCategoryFilters() {
        try {
            const categories = await API.get('/api/categories');
            const catSelect = document.getElementById('ref-filter-category');
            const currentVal = catSelect.value;
            catSelect.innerHTML = '<option value="">🌐 Все категории</option>';
            categories.forEach(c => catSelect.add(new Option(c, c)));
            catSelect.value = currentVal;
            if (catSelect.tomselect) catSelect.tomselect.sync();

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
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Ничего не найдено</td></tr>';
            return;
        }

        tbody.innerHTML = items.map(item => `
        <tr class="ref-table-row">
            <td class="text-muted font-12">#${item.id}</td>
            <td>
                <span class="badge ${item.item_type === 'product' ? 'badge-product' : 'badge-material'}">
                    ${item.item_type === 'product' ? '📦 Продукция' : '🪨 Сырье'}
                </span>
            </td>
            <td><strong class="text-muted">${item.category || '-'}</strong></td>
            <td class="dict-article-cell">
                ${item.article || '<span class="text-border font-normal">—</span>'}
            </td>
            
            <td><b class="text-main">${item.name}</b></td> 
            <td class="text-muted">${item.unit || ''}</td>
            
            <td class="text-right font-bold">${parseFloat(item.current_price).toLocaleString()} ₽</td>
            
            <td class="text-center font-bold ${parseFloat(item.min_stock) > 0 ? 'text-primary' : 'text-muted'}">
                ${item.min_stock || 0}
            </td>
            
            <td class="text-right">
                <button class="btn btn-outline dict-row-btn mr-5" onclick="editReference(${item.id})">✏️</button>
                <button class="btn btn-outline dict-row-btn border-danger text-danger" onclick="deleteReference(${item.id}, '${item.name.replace(/'/g, "\\'")}')">❌</button>
            </td>
        </tr>
    `).join('');
    }

    // === УПРАВЛЕНИЕ ФОРМОЙ И МАТРИЦАМИ ===

    function openRefForm() {
        document.getElementById('ref-form-container').classList.remove('inv-hidden');
        document.getElementById('ref-form-container').style.display = 'block';
        document.getElementById('ref-form-title').innerText = '✨ Добавление новой позиции';
        clearRefForm();
        loadMoldsForRefs();
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
        document.getElementById('ref-min-stock').value = '0';
        document.getElementById('ref-weight').value = '0';

        // 🚀 НОВОЕ: Очищаем поле сдельной ставки при создании новой карточки
        const prEl = document.getElementById('ref-piece-rate');
        if (prEl) prEl.value = '0';

        const typeEl = document.getElementById('ref-type');
        typeEl.value = 'product';
        if (typeEl.tomselect) typeEl.tomselect.sync();

        document.getElementById('ref-unit').value = 'кг';
        document.getElementById('ref-qty-cycle').value = '1';

        const moldSel = document.getElementById('ref-mold-id');
        if (moldSel) {
            moldSel.value = '';
            if (moldSel.tomselect) moldSel.tomselect.sync();
        }
        const gostEl = document.getElementById('ref-gost');
        if (gostEl) gostEl.value = '';

        const mixMainEl = document.getElementById('ref-mix-main');
        if (mixMainEl) mixMainEl.value = '';
        const mixFaceEl = document.getElementById('ref-mix-face');
        if (mixFaceEl) mixFaceEl.value = '';
    }

    async function editReference(id) {
        openRefForm();
        document.getElementById('ref-form-title').innerText = '✏️ Редактирование позиции (ID: ' + id + ')';

        try {
            // 🚀 ИСПРАВЛЕНИЕ: API.get уже возвращает данные, .json() вызывать НЕ НУЖНО
            const data = await API.get(`/api/items?limit=1000`);
            const item = data.data.find(i => Number(i.id) === Number(id));

            if (item) {
                document.getElementById('ref-edit-id').value = item.id;
                document.getElementById('ref-article').value = item.article || '';
                document.getElementById('ref-name').value = item.name;
                document.getElementById('ref-category').value = item.category || '';
                document.getElementById('ref-unit').value = item.unit;
                document.getElementById('ref-price').value = parseFloat(item.current_price) || 0;

                // 🛡️ Наше новое поле порога
                const minStockEl = document.getElementById('ref-min-stock');
                if (minStockEl) minStockEl.value = parseFloat(item.min_stock) || 0;

                document.getElementById('ref-weight').value = parseFloat(item.weight_kg) || 0;
                document.getElementById('ref-type').value = item.item_type;
                document.getElementById('ref-qty-cycle').value = item.qty_per_cycle || 1;

                const prEl = document.getElementById('ref-piece-rate');
                if (prEl) prEl.value = parseFloat(item.piece_rate) || 0;

                const gostEl = document.getElementById('ref-gost');
                if (gostEl) gostEl.value = item.gost_mark || '';

                // Синхронизируем выпадающие списки
                setTimeout(() => {
                    const moldSel = document.getElementById('ref-mold-id');
                    if (moldSel) {
                        moldSel.value = item.mold_id || '';
                        if (moldSel.tomselect) moldSel.tomselect.sync();
                    }
                    const typeEl = document.getElementById('ref-type');
                    if (typeEl && typeEl.tomselect) typeEl.tomselect.sync();
                }, 100);

                const mixMainEl = document.getElementById('ref-mix-main');
                if (mixMainEl) mixMainEl.value = item.mix_main_tpl || '';
                const mixFaceEl = document.getElementById('ref-mix-face');
                if (mixFaceEl) mixFaceEl.value = item.mix_face_tpl || '';

                // Прокрутка наверх к форме
                document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
            }
        } catch (e) {
            console.error("Ошибка при загрузке данных для редактирования:", e);
            UI.toast('Не удалось загрузить данные позиции', 'error');
        }
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
            min_stock: parseFloat(document.getElementById('ref-min-stock')?.value) || 0, // 🚀 Порог безопасности
            weight: parseFloat(document.getElementById('ref-weight').value) || 0,
            piece_rate: parseFloat(document.getElementById('ref-piece-rate')?.value) || 0,
            qty_per_cycle: parseFloat(document.getElementById('ref-qty-cycle').value) || 1,
            mold_id: document.getElementById('ref-mold-id').value || null,
            gost_mark: document.getElementById('ref-gost')?.value.trim() || '',
            mix_main_tpl: document.getElementById('ref-mix-main')?.value || null,
            mix_face_tpl: document.getElementById('ref-mix-face')?.value || null
        };

        if (!payload.name) return UI.toast('Укажите название позиции!', 'error');

        try {
            // 🚀 Используем правильные методы API.put или API.post
            let res;
            if (id) {
                res = await API.put(`/api/items/${id}`, payload);
            } else {
                res = await API.post('/api/items', payload);
            }

            UI.toast(id ? '✅ Позиция обновлена!' : '✅ Позиция добавлена!', 'success');
            closeRefForm();
            loadReferences(currentRefPage);
        } catch (e) {
            console.error("Ошибка при сохранении:", e);
            UI.toast('Ошибка при сохранении: ' + e.message, 'error');
        }
    }

    window.deleteReference = function (id, name) {
        const html = `
        <p>Вы уверены, что хотите удалить <b>"${name}"</b>?</p>
        <p class="font-12 text-danger mt-10">
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
            await API.delete(`/api/items/${id}`);
            if (true) {
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
            const eq = await API.get('/api/equipment');
            const sel = document.getElementById('ref-mold-id');
            if (!sel) return;

            sel.innerHTML = '<option value="">-- Без матрицы --</option>';
            eq.filter(e => e.equipment_type === 'mold').forEach(m => {
                const amort = (parseFloat(m.purchase_cost) / parseInt(m.planned_cycles)).toFixed(2);
                sel.add(new Option(`${m.name} (${amort} ₽/удар)`, m.id));
            });
            if (sel.tomselect) sel.tomselect.sync();
        } catch (e) { console.error("Ошибка загрузки матриц", e); }
    }

    // Функция инициализации всех селектов TomSelect в модуле
    function initStaticRefSelects() {
        ['ref-filter-type', 'ref-filter-category', 'ref-type', 'ref-mold-id'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.tomselect) {
                new TomSelect(el, { plugins: ['clear_button'] });
            }
        });
    }

    // Слушатель переключения видимости полей (Сырье или Продукция)
    document.addEventListener('DOMContentLoaded', () => {
        initStaticRefSelects();

        const typeSelect = document.getElementById('ref-type');
        if (typeSelect) {
            typeSelect.addEventListener('change', function () {
                const isProd = this.value === 'product';
                const groupQty = document.getElementById('group-qty-cycle');
                const groupMold = document.getElementById('group-mold-select');
                const groupGost = document.getElementById('group-gost');
                const groupMixTemplates = document.querySelector('.group-mix-templates');

                if (groupQty) groupQty.classList.toggle('inv-hidden', !isProd);
                if (groupMold) groupMold.classList.toggle('inv-hidden', !isProd);
                if (groupGost) groupGost.classList.toggle('inv-hidden', !isProd);
                if (groupMixTemplates) groupMixTemplates.classList.toggle('inv-hidden', !isProd);
            });
        }
    });

    // === ГЛОБАЛЬНЫЙ ЭКСПОРТ ===
    if (typeof loadReferences === 'function') window.loadReferences = loadReferences;
    if (typeof updateCategoryFilters === 'function') window.updateCategoryFilters = updateCategoryFilters;
    if (typeof debounceRefLoad === 'function') window.debounceRefLoad = debounceRefLoad;
    if (typeof renderRefTable === 'function') window.renderRefTable = renderRefTable;
    if (typeof openRefForm === 'function') window.openRefForm = openRefForm;
    if (typeof closeRefForm === 'function') window.closeRefForm = closeRefForm;
    if (typeof clearRefForm === 'function') window.clearRefForm = clearRefForm;
    if (typeof editReference === 'function') window.editReference = editReference;
    if (typeof saveReference === 'function') window.saveReference = saveReference;
    if (typeof changeRefPage === 'function') window.changeRefPage = changeRefPage;
    if (typeof loadMoldsForRefs === 'function') window.loadMoldsForRefs = loadMoldsForRefs;
    if (typeof initStaticRefSelects === 'function') window.initStaticRefSelects = initStaticRefSelects;
})();
