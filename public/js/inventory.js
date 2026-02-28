// === public/js/inventory.js ===

let allInventory = [];
let currentWarehouseFilter = 'all';

function loadTable() {
    fetch('/api/inventory')
        .then(res => res.json())
        .then(data => {
            allInventory = data;
            renderInventoryTable();
            updateWipDropdown();
        });
}

function applyWarehouseFilter(id, btn) {
    currentWarehouseFilter = id;
    document.querySelectorAll('#stock-mod .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventoryTable();
}

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table');
    if (!tbody) return;
    tbody.innerHTML = '';
    allInventory.forEach(item => {
        if (currentWarehouseFilter !== 'all' && String(item.warehouse_id) !== currentWarehouseFilter) return;
        tbody.innerHTML += `<tr>
            <td><span class="badge">${item.warehouse_name}</span></td>
            <td>#${item.batch_id || '-'}</td>
            <td><strong>${item.item_name}</strong></td>
            <td>${parseFloat(item.total).toFixed(2)}</td>
            <td>${item.unit}</td>
        </tr>`;
    });
}

function updateWipDropdown() {
    const sel = document.getElementById('wip-product-select');
    if (!sel) return;
    sel.innerHTML = '<option disabled selected>-- Выберите партию в сушилке --</option>';
    allInventory.filter(i => i.warehouse_id === 3).forEach(i => {
        let opt = new Option(`${i.item_name} [Партия #${i.batch_id}] (${i.total})`, i.item_id);
        opt.setAttribute('data-batch-id', i.batch_id);
        opt.setAttribute('data-qty', i.total);
        sel.add(opt);
    });
}

function onWipSelect() {
    const sel = document.getElementById('wip-product-select');
    const qty = sel.options[sel.selectedIndex]?.getAttribute('data-qty') || 0;
    document.getElementById('wip-current-info').innerText = `В камере числится: ${qty} ед.`;
    document.getElementById('wip-current-qty').value = qty;
}

function moveFromWip() {
    const sel = document.getElementById('wip-product-select');
    const batchId = sel.options[sel.selectedIndex]?.getAttribute('data-batch-id');
    const good = parseFloat(document.getElementById('wip-good-qty').value) || 0;
    const grade2 = parseFloat(document.getElementById('wip-grade2-qty').value) || 0;
    const scrap = parseFloat(document.getElementById('wip-scrap-qty').value) || 0;
    
    if (!batchId) return alert('Выберите партию!');

    fetch('/api/move-wip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            tileId: sel.value, batchId, 
            currentWipQty: parseFloat(document.getElementById('wip-current-qty').value),
            goodQty: good, grade2Qty: grade2, scrapQty: scrap,
            isComplete: document.getElementById('wip-is-complete').checked 
        })
    }).then(res => { if (res.ok) { alert('✅ Выгружено!'); loadTable(); } });
}