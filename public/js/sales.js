// === public/js/sales.js ===

function initSales() {
    document.getElementById('sale-btn')?.addEventListener('click', () => {
        const tileId = document.getElementById('sale-product-select').value;
        const qty = document.getElementById('sale-qty').value;
        const price = document.getElementById('sale-price').value;

        fetch('/api/sales', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tileId, quantity: qty, pricePerUnit: price })
        }).then(res => { if (res.ok) { alert('✅ Продажа оформлена'); loadTable(); } });
    });

    document.getElementById('sale-qty')?.addEventListener('input', calculateWeight);
    document.getElementById('sale-product-select')?.addEventListener('change', calculateWeight);
}

function calculateWeight() {
    const select = document.getElementById('sale-product-select');
    if (!select || select.selectedIndex === -1) return;
    const weight = parseFloat(select.options[select.selectedIndex].getAttribute('data-weight')) || 0;
    const qty = parseFloat(document.getElementById('sale-qty').value) || 0;
    const totalKg = (weight * qty).toFixed(1);
    document.getElementById('total-weight').innerText = totalKg;
    document.getElementById('total-tons').innerText = (totalKg / 1000).toFixed(2);
}

function loadProducts() {
    fetch('/api/products').then(res => res.json()).then(data => {
        const s1 = document.getElementById('product-select');
        const s2 = document.getElementById('sale-product-select');
        if(!s1 || !s2) return;
        s1.innerHTML = ''; s2.innerHTML = '';
        data.forEach(p => {
            let opt = new Option(p.name, p.id);
            opt.setAttribute('data-weight', p.weight_kg || 0);
            s1.add(opt.cloneNode(true));
            s2.add(opt.cloneNode(true));
        });
        calculateWeight();
    });
}