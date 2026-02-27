const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function receiveMaterials() {
    console.log('Разгружаем фуру с материалами...');

    try {
        // ШАГ 1: Создаем карточку сырья в справочнике номенклатуры
        const itemResult = await pool.query(
            `INSERT INTO items (name, item_type, unit, current_price) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id`,
            ['Цемент М500', 'material', 'кг', 12.50]
        );
        
        const cementId = itemResult.rows[0].id;
        console.log(`Сырье зарегистрировано в базе. ID цемента: ${cementId}`);

        // ШАГ 2: Фиксируем приход на склад (10 000 кг = 10 тонн)
        await pool.query(
            `INSERT INTO inventory_movements 
            (item_id, quantity, movement_type, description) 
            VALUES ($1, $2, $3, $4)`,
            [
                cementId,        // Ссылка на ID цемента из первого шага
                10000.00,        // Количество: строго положительное число (+10 000)
                'receipt',       // Тип операции: receipt (приход)
                'Приходная накладная №88 от ООО "Цемент-Юг"' // Основание
            ]
        );

        console.log('✅ 10 тонн цемента успешно оприходовано на склад!');

    } catch (err) {
        console.error('Ошибка при приемке:', err.message);
    } finally {
        pool.end(); // Закрываем соединение
    }
}

receiveMaterials();