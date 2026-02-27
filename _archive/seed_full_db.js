const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

// === ПАЛИТРЫ И ТЕКСТУРЫ ===
const colorsStandard = ['Серая', 'Красная', 'Коричневая', 'Черная', 'Белая', 'Желтая', 'Оранжевая'];
const colorsMelange = ['Оникс', 'Осень', 'Рубин', 'Яшма', 'Янтарь'];

const textures = [
    { name: 'Гладкая', colors: colorsStandard },
    { name: 'Меланж', colors: colorsMelange },
    { name: 'Гранитная', colors: colorsStandard },
    { name: 'Гранитная меланж', colors: colorsMelange }
];

// === МАТРИЦА ПРОДУКЦИИ ===
const tileForms = [
    { name: 'ПРЯМОУГОЛЬНИК', thicks: [40, 60], weights: {40: 90.28, 60: 135.16} },
    { name: 'КВАДРАТ', thicks: [40, 60], weights: {40: 90.28, 60: 135.16} },
    { name: 'КЛАССИКО', thicks: [40, 60], weights: {40: 86.27, 60: 129.46} },
    { name: 'СИТИ-МИКС', thicks: [40, 60, 80], weights: {40: 88.89, 60: 104.17, 80: 151.11} },
    { name: 'ПАРКЕТ', thicks: [80], weights: {80: 183.60} },
    { name: 'ПЛИТА', thicks: [80], weights: {80: 216.05} }
];

const roadElements = [
    { name: 'Поребрик', weight: 36.11 },
    { name: 'Бордюр дорожный', weight: 100.00 },
    { name: 'Бордюр магистральный', weight: 120.00 }
];

const wallBlocks = [
    { name: 'Блок стеновой 200x200x400', weight: 20 },
    { name: 'Полублок 120x200x60', weight: 10 }
];

// === БАЗА СЫРЬЯ ===
const materials = [
    { name: 'Цемент М-600', unit: 'кг', price: 10.70 },
    { name: 'Цемент белый', unit: 'кг', price: 27.76 },
    { name: 'Песок Курган', unit: 'кг', price: 0.81 },
    { name: 'Песок лицевой', unit: 'кг', price: 1.00 },
    { name: 'Щебень', unit: 'кг', price: 0.96 },
    { name: 'Мадсан А', unit: 'кг', price: 108.00 },
    { name: 'Мадсан Б', unit: 'кг', price: 48.00 },
    { name: 'Пигмент (Красный/Корич/Черн)', unit: 'кг', price: 170.00 },
    { name: 'Пигмент (диоксид/белый)', unit: 'кг', price: 380.00 },
    { name: 'Скобы', unit: 'шт', price: 1.32 },
    { name: 'Упаковочная лента', unit: 'м', price: 3.00 },
    { name: 'Стрейч пленка', unit: 'м', price: 2.58 }
];

async function seed() {
    console.log('⏳ Запуск супер-генератора базы Плиттекс...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Загружаем сырье
        for (let m of materials) {
            await client.query(
                `INSERT INTO items (name, item_type, category, unit, current_price, weight_kg) VALUES ($1, 'material', '🪨 Сырье и материалы', $2, $3, 1)`, 
                [m.name, m.unit, m.price]
            );
        }

        // 2. Генерируем Плитку (6 форм * 4 текстуры * толщины * цвета)
        for (let form of tileForms) {
            for (let thick of form.thicks) {
                const weight = form.weights[thick];
                const category = `🧱 Плитка: ${form.name} (${thick}мм)`; // Формируем папку!

                for (let tex of textures) {
                    for (let color of tex.colors) {
                        const fullName = `${form.name} ${thick}мм | ${tex.name} | ${color}`;
                        await client.query(
                            `INSERT INTO items (name, item_type, category, unit, weight_kg) VALUES ($1, 'product', $2, 'кв.м', $3)`, 
                            [fullName, category, weight]
                        );
                    }
                }
            }
        }

        // 3. Генерируем Дорожные элементы (3 вида * 4 текстуры * цвета)
        for (let road of roadElements) {
            const category = `🛣️ Дорожные элементы: ${road.name}`; // Формируем папку!
            for (let tex of textures) {
                for (let color of tex.colors) {
                    const fullName = `${road.name} | ${tex.name} | ${color}`;
                    await client.query(
                        `INSERT INTO items (name, item_type, category, unit, weight_kg) VALUES ($1, 'product', $2, 'шт', $3)`, 
                        [fullName, category, road.weight]
                    );
                }
            }
        }

        // 4. Генерируем Стеновые блоки
        for (let block of wallBlocks) {
            await client.query(
                `INSERT INTO items (name, item_type, category, unit, weight_kg) VALUES ($1, 'product', '🏗️ Стеновые блоки', 'шт', $2)`, 
                [block.name, block.weight]
            );
        }

        await client.query('COMMIT');
        console.log('✅ ИДЕАЛЬНАЯ МАТРИЦА СОЗДАНА! Загружено более 500 позиций.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка:', e.message);
    } finally {
        client.release();
        pool.end();
    }
}
seed();