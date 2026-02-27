const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' });

// === 1. ПРАЙС-ЛИСТ (Из файла Price.pdf) ===
// Базовые цены за 1 кв.м. или 1 шт.
const priceMatrix = {
    'ПРЯМОУГОЛЬНИК 40мм': { 'Серая': 790, 'Красная': 900, 'Коричневая': 900, 'Черная': 900, 'Белая': 900, 'Желтая': 910, 'Оранжевая': 910, 'Меланж': 1250 },
    'ПРЯМОУГОЛЬНИК 60мм': { 'Серая': 950, 'Красная': 1050, 'Коричневая': 1050, 'Черная': 1050, 'Белая': 1050, 'Желтая': 1100, 'Оранжевая': 1100, 'Меланж': 1400 },
    'КВАДРАТ 40мм': { 'Серая': 790, 'Красная': 900, 'Коричневая': 900, 'Черная': 900, 'Белая': 900, 'Желтая': 910, 'Оранжевая': 910, 'Меланж': 1250 },
    'КВАДРАТ 60мм': { 'Серая': 950, 'Красная': 1050, 'Коричневая': 1050, 'Черная': 1050, 'Белая': 1050, 'Желтая': 1100, 'Оранжевая': 1100, 'Меланж': 1400 },
    'Поребрик': { 'Серая': 730, 'Красная': 850, 'Коричневая': 850, 'Меланж': 1100 },
    'Бордюр дорожный': { 'Серая': 650 },
    'Блок стеновой 200x200x400': { 'base': 45 },
    'Полублок 120x200x60': { 'base': 40 }
};

// === 2. БАЗОВЫЕ РЕЦЕПТЫ НА 40мм (Из файла калькуляции .csv) ===
const baseRecipes = {
    'Серая': [
        { name: 'Цемент М-600', qty: 17 }, { name: 'Песок Курган', qty: 104 }, { name: 'Щебень', qty: 6 },
        { name: 'Мадсан А', qty: 0.04 }, { name: 'Мадсан Б', qty: 0.06 }, { name: 'Скобы', qty: 4 }, { name: 'Стрейч пленка', qty: 8 }
    ],
    'Красная': [ // И Коричневая, Черная
        { name: 'Цемент М-600', qty: 17 }, { name: 'Песок Курган', qty: 104 }, { name: 'Щебень', qty: 6 },
        { name: 'Мадсан А', qty: 0.04 }, { name: 'Мадсан Б', qty: 0.06 }, { name: 'Пигмент (Красный/Корич/Черн)', qty: 0.12 },
        { name: 'Скобы', qty: 4 }, { name: 'Стрейч пленка', qty: 8 }
    ],
    'Желтая': [ // И Оранжевая
        { name: 'Цемент М-600', qty: 13 }, { name: 'Цемент белый', qty: 4 }, { name: 'Песок Курган', qty: 104 }, { name: 'Щебень', qty: 6 },
        { name: 'Мадсан А', qty: 0.04 }, { name: 'Мадсан Б', qty: 0.06 }, { name: 'Пигмент (диоксид/белый)', qty: 0.14 }, // Желтый пигмент используем базу диоксида пока
        { name: 'Скобы', qty: 4 }, { name: 'Стрейч пленка', qty: 8 }
    ],
    'Белая': [
        { name: 'Цемент М-600', qty: 13 }, { name: 'Цемент белый', qty: 4.5 }, { name: 'Песок Курган', qty: 104 }, { name: 'Щебень', qty: 6 },
        { name: 'Мадсан А', qty: 0.04 }, { name: 'Мадсан Б', qty: 0.06 }, { name: 'Пигмент (диоксид/белый)', qty: 0.5 },
        { name: 'Скобы', qty: 4 }, { name: 'Стрейч пленка', qty: 8 }
    ]
};

async function updateDb() {
    console.log('⏳ Начинаю интеллектуальный анализ 500+ позиций...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Получаем ID всех материалов
        const matRes = await client.query("SELECT id, name FROM items WHERE item_type = 'material'");
        const matIds = {};
        matRes.rows.forEach(m => matIds[m.name] = m.id);

        // 2. Получаем всю продукцию
        const prodRes = await client.query("SELECT id, name, weight_kg FROM items WHERE item_type = 'product'");
        
        let priceUpdates = 0;
        let recipeUpdates = 0;

        for (let prod of prodRes.rows) {
            let priceToSet = null;
            let recipeToSet = null;
            let multiplier = 1;

            // --- АНАЛИЗ ЦЕНЫ ---
            if (prod.name.includes('ПРЯМОУГОЛЬНИК') && prod.name.includes('40мм')) priceToSet = getPrice(priceMatrix['ПРЯМОУГОЛЬНИК 40мм'], prod.name);
            else if (prod.name.includes('ПРЯМОУГОЛЬНИК') && prod.name.includes('60мм')) priceToSet = getPrice(priceMatrix['ПРЯМОУГОЛЬНИК 60мм'], prod.name);
            else if (prod.name.includes('КВАДРАТ') && prod.name.includes('40мм')) priceToSet = getPrice(priceMatrix['КВАДРАТ 40мм'], prod.name);
            else if (prod.name.includes('КВАДРАТ') && prod.name.includes('60мм')) priceToSet = getPrice(priceMatrix['КВАДРАТ 60мм'], prod.name);
            else if (prod.name.includes('Поребрик')) priceToSet = getPrice(priceMatrix['Поребрик'], prod.name);
            else if (prod.name.includes('Бордюр дорожный')) priceToSet = priceMatrix['Бордюр дорожный']['Серая'];
            else if (prod.name.includes('Блок стеновой')) priceToSet = priceMatrix['Блок стеновой 200x200x400']['base'];
            else if (prod.name.includes('Полублок')) priceToSet = priceMatrix['Полублок 120x200x60']['base'];

            if (priceToSet) {
                await client.query("UPDATE items SET current_price = $1 WHERE id = $2", [priceToSet, prod.id]);
                priceUpdates++;
            }

            // --- АНАЛИЗ РЕЦЕПТА (Для плитки) ---
            if (prod.name.includes('мм')) { // Если это плитка
                // Определяем базовый цвет рецепта
                if (prod.name.includes('Серая')) recipeToSet = baseRecipes['Серая'];
                else if (prod.name.includes('Красная') || prod.name.includes('Коричневая') || prod.name.includes('Черная')) recipeToSet = baseRecipes['Красная'];
                else if (prod.name.includes('Желтая') || prod.name.includes('Оранжевая')) recipeToSet = baseRecipes['Желтая'];
                else if (prod.name.includes('Белая')) recipeToSet = baseRecipes['Белая'];
                else recipeToSet = baseRecipes['Серая']; // Дефолт для меланжа

                // Считаем множитель толщины (База 40мм весит ~90кг)
                multiplier = prod.weight_kg / 90.28; 

                // Очищаем старый рецепт и пишем новый
                await client.query("DELETE FROM recipes WHERE product_id = $1", [prod.id]);
                for (let ing of recipeToSet) {
                    if (!matIds[ing.name]) continue; // Если материал не найден в базе, пропускаем
                    
                    // Упаковка (скобы, пленка) не умножается на толщину!
                    let finalQty = (ing.name === 'Скобы' || ing.name === 'Стрейч пленка') ? ing.qty : (ing.qty * multiplier).toFixed(3);
                    
                    await client.query(
                        "INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)", 
                        [prod.id, matIds[ing.name], finalQty]
                    );
                }
                recipeUpdates++;
            }
        }

        await client.query('COMMIT');
        console.log(`✅ ГОТОВО! Установлено цен: ${priceUpdates}. Сгенерировано сложных рецептов: ${recipeUpdates}.`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Ошибка:', e.message);
    } finally {
        client.release();
        pool.end();
    }
}

// Вспомогательная функция для поиска цвета в матрице
function getPrice(matrixRow, prodName) {
    if (prodName.includes('Меланж')) return matrixRow['Меланж'] || matrixRow['Серая'];
    for (let color in matrixRow) {
        if (prodName.includes(color)) return matrixRow[color];
    }
    return matrixRow['Серая']; // По умолчанию
}

updateDb();