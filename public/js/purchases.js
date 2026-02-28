// === public/js/purchases.js ===

// 1. Загрузка списка сырья (вызывается при входе в систему)
function loadPurchaseMaterials() {
    fetch('/api/items?limit=1000&filter=materials')
        .then(res => res.json())
        .then(res => {
            const sel = document.getElementById('purchase-material-select');
            if (!sel) return;
            sel.innerHTML = '<option value="" selected disabled>-- Выберите сырье --</option>';
            res.data.forEach(m => {
                sel.innerHTML += `<option value="${m.id}" data-price="${m.current_price || 0}" data-unit="${m.unit}">${m.name} (${m.unit})</option>`;
            });
        });
}

// 2. Автоматический подсчет суммы при вводе количества или цены
function calculatePurchaseTotal() {
    const qty = parseFloat(document.getElementById('purchase-qty').value) || 0;
    const price = parseFloat(document.getElementById('purchase-price').value) || 0;
    const total = qty * price;
    document.getElementById('purchase-total-cost').innerText = total.toFixed(2);
}

// 3. Подставляем базовую цену из справочника при выборе сырья
function onPurchaseMaterialSelect() {
    const sel = document.getElementById('purchase-material-select');
    const opt = sel.options[sel.selectedIndex];
    const price = parseFloat(opt.getAttribute('data-price')) || 0;

    if (price > 0) {
        document.getElementById('purchase-price').value = price;
    }
    calculatePurchaseTotal(); // Пересчитываем Итого
}

// 4. Оформление прихода на склад
function submitPurchase() {
    const materialId = document.getElementById('purchase-material-select').value;
    const quantity = parseFloat(document.getElementById('purchase-qty').value) || 0;
    const pricePerUnit = parseFloat(document.getElementById('purchase-price').value) || 0;
    const supplier = document.getElementById('purchase-supplier').value;

    if (!materialId || quantity <= 0) {
        return UI.toast('Выберите сырье и укажите количество!', 'error'); // Замена alert
    }

    fetch('/api/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialId, quantity, pricePerUnit, supplier })
    }).then(async res => {
        if (res.ok) {
            UI.toast('✅ Сырье оприходовано!', 'success');
            document.getElementById('purchase-qty').value = '';
            calculatePurchaseTotal();
            if (typeof loadTable === 'function') loadTable();
        } else {
            UI.toast('Ошибка закупки', 'error');
        }
    });
}