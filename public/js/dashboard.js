// === public/js/dashboard.js ===
// Модуль визуализации данных и финансовой аналитики

let myChart = null; // Глобальная переменная для хранения объекта графика

function loadDashboard() {
    const ctx = document.getElementById('costChart');
    if (!ctx) return;

    // 1. Получаем данные из нашего аналитического маршрута на сервере
    fetch('/api/analytics/cost-deviation')
        .then(res => res.json())
        .then(data => {
            if (data.length === 0) {
                console.log("Данных для графика пока нет. Закройте хотя бы одну партию!");
                return;
            }

            // 2. Подготавливаем метки (номера партий) и значения
            const labels = data.map(item => item.batch_number);
            const plannedCosts = data.map(item => parseFloat(item.planned_unit_cost).toFixed(2));
            const actualCosts = data.map(item => parseFloat(item.actual_unit_cost).toFixed(2));

            // 3. Уничтожаем старый график, если он был (чтобы не было наслоений)
            if (myChart) myChart.destroy();

            // 4. Инициализируем Chart.js
            myChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Плановая себестоимость (₽/ед)',
                            data: plannedCosts,
                            borderColor: '#3b82f6', // Синий
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            borderWidth: 3,
                            tension: 0.3,
                            fill: true
                        },
                        {
                            label: 'Фактическая себестоимость (₽/ед)',
                            data: actualCosts,
                            borderColor: '#ef4444', // Красный
                            backgroundColor: 'rgba(239, 68, 68, 0.1)',
                            borderWidth: 3,
                            tension: 0.3,
                            fill: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top' },
                        tooltip: { mode: 'index', intersect: false }
                    },
                    scales: {
                        y: { 
                            beginAtZero: false,
                            title: { display: true, text: 'Рубли за ед. продукции' }
                        },
                        x: {
                            title: { display: true, text: 'Номер партии' }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Ошибка загрузки аналитики:", err));
}