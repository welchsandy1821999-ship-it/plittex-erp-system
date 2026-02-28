// === public/js/finance.js ===

function initFinance() {
    document.getElementById('finance-btn')?.addEventListener('click', () => {
        fetch('/api/report/finance')
            .then(res => res.json())
            .then(data => {
                let s = "📊 ФИНАНСОВЫЙ ОТЧЕТ:\n\n";
                data.forEach(r => s += `🔹 ${r.category}: Доход ${r.income}₽, Расход ${r.expense}₽\n`);
                alert(s);
            });
    });
}