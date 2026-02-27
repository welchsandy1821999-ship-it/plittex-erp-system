const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function calculateEconomics() {
    console.log('Анализ себестоимости и рентабельности...\n');

    try {
        // 1. Получаем текущие цены из базы
        const cementRes = await pool.query("SELECT current_price FROM items WHERE name = 'Цемент М500'");
        const tileRes = await pool.query("SELECT current_price FROM items WHERE name = 'Плитка КВАДРАТ 2.К.4 (Белая)'");
        
        const cementPrice = parseFloat(cementRes.rows[0].current_price); // 12.50 руб/кг
        const tileSalePrice = parseFloat(tileRes.rows[0].current_price); // 900 руб/кв.м

        // 2. Данные нашей производственной партии (из прошлого скрипта)
        const cementUsedKg = 300; 
        const tileProducedSqm = 14.4; 

        // 3. Математика производства
        const totalMaterialCost = cementUsedKg * cementPrice; // 300 * 12.5 = 3750 руб.
        const costPerSqm = totalMaterialCost / tileProducedSqm; // 3750 / 14.4 = 260.41 руб.

        // 4. Математика продаж
        const profitPerSqm = tileSalePrice - costPerSqm; // 900 - 260.41 = 639.59 руб.
        const marginPercent = (profitPerSqm / tileSalePrice) * 100; // Рентабельность
        const totalBatchProfit = profitPerSqm * tileProducedSqm; // Чистыми с поддона

        // Вывод красивого отчета
        console.log('=== ЭКОНОМИКА ПАРТИИ (Белый Квадрат) ===');
        console.log(`Произведено: ${tileProducedSqm} кв.м.`);
        console.log(`Потрачено цемента: ${cementUsedKg} кг на сумму ${totalMaterialCost} руб.`);
        console.log('----------------------------------------');
        console.log(`Себестоимость 1 кв.м: ${costPerSqm.toFixed(2)} руб.`);
        console.log(`Цена продажи 1 кв.м:  ${tileSalePrice.toFixed(2)} руб.`);
        console.log(`Чистая прибыль с 1 кв.м: ${profitPerSqm.toFixed(2)} руб.`);
        console.log('----------------------------------------');
        console.log(`💰 ИТОГО ПРИБЫЛЬ С ПОДДОНА: ${totalBatchProfit.toFixed(2)} руб.`);
        console.log(`📈 Рентабельность (Маржа):  ${marginPercent.toFixed(1)}%`);
        console.log('========================================');

    } catch (err) {
        console.error('Ошибка при расчете:', err.message);
    } finally {
        pool.end(); 
    }
}

calculateEconomics();