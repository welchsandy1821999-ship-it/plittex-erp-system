let refCurrentPage = 1;
let refItemsPerPage = 50;
let currentRefFilter = 'all';
let currentRefSearch = '';
let searchTimeout = null;
let sortCol = 'id';
let sortAsc = true;
let allReferences = [];

function loadReferences() {
    fetch(`/api/items?page=${refCurrentPage}&limit=${refItemsPerPage}&search=${currentRefSearch}&filter=${currentRefFilter}`)
        .then(res => res.json())
        .then(response => {
            allReferences = response.data;
            sortReferencesArray(); 
            renderReferences(allReferences);
            updatePaginationUI(response.currentPage, response.totalPages, response.total);
            if (currentRefSearch === '' && currentRefFilter === 'all' && refCurrentPage === 1) updateDatalists(response.data);
        });
}

function updateDatalists(data) {
    const cats = new Set(), units = new Set();
    data.forEach(item => { if (item.category) cats.add(item.category); if (item.unit) units.add(item.unit); });
    document.getElementById('dl-categories').innerHTML = Array.from(cats).map(c => `<option value="${c}">`).join('');
    document.getElementById('dl-units').innerHTML = Array.from(units).map(u => `<option value="${u}">`).join('');
}

function sortRefs(col) {
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = true; }
    sortReferencesArray();
    renderReferences(allReferences);
}

function sortReferencesArray() {
    allReferences.sort((a, b) => {
        let valA = a[sortCol] !== null ? a[sortCol] : '';
        let valB = b[sortCol] !== null ? b[sortCol] : '';
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return sortAsc ? -1 : 1;
        if (valA > valB) return sortAsc ? 1 : -1;
        return 0;
    });
}

function renderReferences(items) {
    const tbody = document.getElementById('ref-table-body');
    let htmlBuffer = '';
    items.forEach(item => {
        const priceStr = item.current_price ? `${item.current_price} ₽` : `<span class="badge badge-danger">Не указана</span>`;
        const badgeType = item.item_type === 'product' ? `<span class="badge badge-prod">Продукция</span>` : `<span class="badge badge-mat">Сырье</span>`;
        htmlBuffer += `
            <tr id="row-${item.id}">
                <td style="color: var(--text-muted);">${item.id}</td>
                <td style="font-size: 13px; font-weight: 500;">${item.category || 'Без категории'}</td>
                <td><div style="margin-bottom: 4px;">${badgeType}</div><strong style="color: var(--text-main);">${item.name}</strong></td>
                <td>${item.unit}</td>
                <td style="font-weight: 600;">${priceStr}</td>
                <td>${item.weight_kg}</td>
                <td style="text-align: right;">
                    <button class="btn btn-outline" style="padding: 6px 10px;" onclick="editInline(${item.id}, '${item.name.replace(/"/g, '&quot;')}', '${item.category}', '${item.unit}', '${item.current_price || ''}', '${item.weight_kg}', '${item.item_type}')">✏️</button>
                    <button class="btn btn-outline" style="padding: 6px 10px; color: var(--danger);" onclick="deleteReferenceItem(${item.id})">❌</button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = htmlBuffer;
}

function changeRefPage(step) {
    refCurrentPage += step;
    if (refCurrentPage < 1) refCurrentPage = 1;
    loadReferences();
}

function updatePaginationUI(current, total, totalItems) {
    document.getElementById('ref-page-info').innerText = `Страница ${current} из ${total} (Всего: ${totalItems})`;
    document.getElementById('ref-btn-prev').disabled = current === 1;
    document.getElementById('ref-btn-next').disabled = current === total;
}

function handleRefSearch() {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        currentRefSearch = document.getElementById('ref-search').value;
        refCurrentPage = 1; 
        loadReferences();
    }, 300);
}

function applyRefFilter(filterType, btnElem) {
    currentRefFilter = filterType;
    refCurrentPage = 1; 
    document.querySelectorAll('#ref-mod .filter-row .filter-btn').forEach(b => b.classList.remove('active'));
    if(btnElem) btnElem.classList.add('active');
    loadReferences();
}

function toggleRefConstructor() {
    const type = document.getElementById('ref-type').value;
    document.getElementById('ref-tile-constructor').style.display = (type === 'product') ? 'grid' : 'none';
}

function editInline(id, name, cat, unit, price, weight, type) {
    const tr = document.getElementById(`row-${id}`);
    tr.innerHTML = `
        <td style="color: var(--text-muted);">${id}</td>
        <td><input type="text" id="inl-cat-${id}" list="dl-categories" class="input-modern" value="${cat !== 'null' ? cat : ''}"></td>
        <td><input type="text" id="inl-name-${id}" class="input-modern" value="${name}"></td>
        <td><input type="text" id="inl-unit-${id}" list="dl-units" class="input-modern" value="${unit}"></td>
        <td><input type="number" id="inl-price-${id}" class="input-modern" value="${price}" step="0.01"></td>
        <td><input type="number" id="inl-weight-${id}" class="input-modern" value="${weight}" step="0.01"></td>
        <td style="text-align: right;">
            <button class="btn btn-green" style="padding: 6px 10px;" onclick="saveInline(${id}, '${type}')">💾</button>
            <button class="btn btn-outline" style="padding: 6px 10px;" onclick="loadReferences()">✖</button>
        </td>
    `;
}

function saveInline(id, itemType) {
    const data = {
        name: document.getElementById(`inl-name-${id}`).value,
        item_type: itemType, category: document.getElementById(`inl-cat-${id}`).value,
        unit: document.getElementById(`inl-unit-${id}`).value,
        price: parseFloat(document.getElementById(`inl-price-${id}`).value) || null,
        weight: parseFloat(document.getElementById(`inl-weight-${id}`).value) || 0
    };
    fetch(`/api/items/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(async res => { if (res.ok) { loadReferences(); loadProducts(); } else alert(await res.text()); });
}

function addRefSmart() {
    const id = document.getElementById('ref-edit-id').value;
    const type = document.getElementById('ref-type').value;
    let finalName = document.getElementById('ref-name').value;
    
    if (type === 'product' && !id) {
        const thick = document.getElementById('ref-thick').value;
        const tex = document.getElementById('ref-texture').value;
        const col = document.getElementById('ref-color').value;
        if (thick || tex || col) finalName = `${finalName} ${thick ? thick+'мм' : ''} | ${tex} | ${col}`.replace(/  +/g, ' ').trim();
    }
    const data = {
        name: finalName, item_type: type, category: document.getElementById('ref-category').value || 'Без категории',
        unit: document.getElementById('ref-unit').value, price: parseFloat(document.getElementById('ref-price').value) || null,
        weight: parseFloat(document.getElementById('ref-weight').value) || 0
    };
    if (!data.name || !data.unit) return alert('Введите название и единицу измерения!');

    const url = id ? `/api/items/${id}` : '/api/items';
    const method = id ? 'PUT' : 'POST';
    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(async res => {
            if (res.ok) { loadReferences(); loadProducts(); cancelEdit(); } else alert('Ошибка: ' + await res.text());
        });
}

function cancelEdit() {
    document.getElementById('ref-edit-id').value = ''; document.getElementById('ref-name').value = '';
    document.getElementById('ref-price').value = ''; document.getElementById('ref-weight').value = '';
    document.getElementById('ref-form-title').innerText = 'Добавление новой позиции';
    document.getElementById('ref-save-btn').innerHTML = '➕ Добавить в базу';
    document.getElementById('ref-cancel-btn').style.display = 'none';
}

function deleteReferenceItem(id) {
    if (!confirm('Точно удалить эту позицию?')) return;
    fetch('/api/items/' + id, { method: 'DELETE' }).then(async res => {
        if (res.ok) { loadReferences(); loadProducts(); } else alert(await res.text()); 
    });
}