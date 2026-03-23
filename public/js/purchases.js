let allCounterparties = [];

async function loadPurchaseMaterials() {
    // 1. Загружаем материалы
    fetch('/api/items?limit=1000&item_type=material')
        .then(res => res.json())
        .then(res => {
            const sel = document.getElementById('purchase-material-select');
            if (sel && res.data) {
                sel.innerHTML = '<option value="" disabled selected>-- Выберите сырье --</option>';
                res.data.forEach(m => {
                    sel.innerHTML += `<option value="${m.id}" data-price="${m.current_price || 0}">${m.name} (${m.unit})</option>`;
                });
            }
        });

    // 2. Загружаем ВСЕХ контрагентов
    fetch('/api/counterparties')
        .then(res => res.json())
        .then(data => {
            allCounterparties = Array.isArray(data) ? data : [];
            renderSuppliers(allCounterparties);
        });

    // 3. Загружаем счета
    fetch('/api/accounts')
        .then(res => res.json())
        .then(accounts => {
            const sel = document.getElementById('purchase-account-select');
            if (sel) {
                sel.innerHTML = '<option value="">-- НЕ ОПЛАЧИВАТЬ (В ДОЛГ) --</option>';
                accounts.forEach(acc => {
                    sel.innerHTML += `<option value="${acc.id}">${acc.name} (${parseFloat(acc.balance).toFixed(2)} ₽)</option>`;
                });
            }
        });
}

// 🚀 ИСПРАВЛЕНИЕ: Формируем умный список для автодополнения (datalist)
function renderSuppliers(list) {
    const datalist = document.getElementById('supplier-options');
    if (!datalist) return;
    
    datalist.innerHTML = list.map(s => {
        const innInfo = s.inn ? ` (ИНН: ${s.inn})` : '';
        return `<option value="${s.name}${innInfo}">`;
    }).join('');
}

// Расчет суммы
function calculatePurchaseTotal() {
    const qty = parseFloat(document.getElementById('purchase-qty').value) || 0;
    const price = parseFloat(document.getElementById('purchase-price').value) || 0;
    document.getElementById('purchase-total-cost').innerText = (qty * price).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
}

function onPurchaseMaterialSelect() {
    const sel = document.getElementById('purchase-material-select');
    const opt = sel.options[sel.selectedIndex];
    const price = parseFloat(opt.getAttribute('data-price')) || 0;
    if (price > 0) document.getElementById('purchase-price').value = price;
    calculatePurchaseTotal();
}

// ==========================================
// ОФОРМЛЕНИЕ ЗАКУПКИ СЫРЬЯ
// ==========================================

window.submitPurchase = function () {
    const materialSelect = document.getElementById('purchase-material-select');
    const accountSelect = document.getElementById('purchase-account-select');
    const supplierInput = document.getElementById('purchase-supplier-input');

    const materialId = materialSelect.value;
    const accountId = accountSelect.value || null;
    const quantity = parseFloat(document.getElementById('purchase-qty').value) || 0;
    const pricePerUnit = parseFloat(document.getElementById('purchase-price').value) || 0;
    const supplierInputValue = supplierInput.value.trim();

    if (!materialId || quantity <= 0) {
        return UI.toast('Укажите материал и количество больше нуля!', 'warning');
    }

    // 🚀 ИСПРАВЛЕНИЕ: Ищем ID поставщика по строке, которую выбрал пользователь
    const foundSupplier = allCounterparties.find(s => {
        const innInfo = s.inn ? ` (ИНН: ${s.inn})` : '';
        return `${s.name}${innInfo}` === supplierInputValue;
    });

    if (!foundSupplier) {
        return UI.toast('Поставщик не найден. Выберите из списка!', 'warning');
    }

    const supplierId = foundSupplier.id;
    const supplierName = foundSupplier.name;
    const materialName = materialSelect.options[materialSelect.selectedIndex]?.text || 'Сырье';
    const totalCost = quantity * pricePerUnit;

    const html = `
        <div style="padding: 10px; font-size: 15px;">
            <div style="text-align: center; font-size: 40px; margin-bottom: 10px;">🛒</div>
            <div style="text-align: center; margin-bottom: 15px;">
                Подтверждаете закупку сырья?
            </div>
            <div style="background: var(--surface-alt); padding: 15px; border-radius: 6px; border: 1px dashed var(--border);">
                <div style="margin-bottom: 5px;">📦 Материал: <b style="color: var(--primary);">${materialName}</b></div>
                <div style="margin-bottom: 5px;">🏭 Поставщик: <b>${supplierName}</b></div>
                <div style="margin-bottom: 5px;">⚖️ Объем: <b>${quantity}</b> (по ${pricePerUnit} ₽)</div>
                
                <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 16px;">
                    Итого к оплате: <b style="color: ${accountId ? 'var(--danger)' : 'var(--warning-text)'};">${totalCost.toLocaleString()} ₽</b>
                    ${!accountId ? `<br><span style="font-size: 12px; color: var(--warning-text);">(В долг, без списания со счета)</span>` : ''}
                </div>
            </div>
        </div>
    `;

    const buttons = `
        <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
        <button class="btn btn-blue" onclick="executePurchase('${materialId}', '${supplierId}', ${accountId ? `'${accountId}'` : null}, ${quantity}, ${pricePerUnit})">✅ Оформить закупку</button>
    `;

    UI.showModal('Подтверждение закупки', html, buttons);
};

window.executePurchase = async function (materialId, supplierId, accountId, quantity, pricePerUnit) {
    const q = parseFloat(quantity);
    const p = parseFloat(pricePerUnit);
    if (isNaN(q) || q <= 0 || isNaN(p) || p <= 0) {
        return UI.toast('Количество и цена должны быть больше нуля!', 'warning');
    }

    UI.closeModal();
    UI.toast('⏳ Оформление закупки...', 'info');

    try {
        const res = await fetch('/api/inventory/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: materialId, supplierId, accountId, quantity, pricePerUnit })
        });

        if (res.ok) {
            UI.toast('✅ Закупка успешно оформлена!', 'success');
            setTimeout(() => location.reload(), 1200);
        } else {
            const errText = await res.text();
            UI.toast('❌ Ошибка сервера: ' + errText, 'error');
        }
    } catch (e) {
        console.error(e);
        UI.toast('Критическая ошибка связи с сервером', 'error');
    }
};