const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// 1. ПРАВИЛА ДЛЯ БАЗОВЫХ НАЗВАНИЙ
const baseRules = [
    { match: 'ПРЯМОУГОЛЬНИК 40', new: 'Тротуарная плитка ПРЯМОУГОЛЬНИК - 2.П.4 40мм' },
    { match: 'ПРЯМОУГОЛЬНИК 60', new: 'Тротуарная плитка ПРЯМОУГОЛЬНИК - 2.П.6 60мм' },
    { match: 'КВАДРАТ 40', new: 'Тротуарная плитка КВАДРАТ - 2.К.4 40мм' },
    { match: 'КВАДРАТ 60', new: 'Тротуарная плитка КВАДРАТ - 2.К.6 60мм' },
    { match: 'КЛАССИКО 40', new: 'Тротуарная плитка КЛАССИКО - 2.КО.4 40мм' },
    { match: 'КЛАССИКО 60', new: 'Тротуарная плитка КЛАССИКО - 2.КО.6 60мм' },
    { match: 'СИТИ-МИКС 40', new: 'Тротуарная плитка СИТИ-МИКС - 1.СМ.4 40мм' },
    { match: 'СИТИ-МИКС 60', new: 'Тротуарная плитка СИТИ-МИКС - 1.СМ.6 60мм' },
    { match: 'СИТИ-МИКС 80', new: 'Тротуарная плитка СИТИ-МИКС - 1.СМ.8 80мм' },
    { match: 'ПАРКЕТ 80', new: 'Тротуарная плитка ПАРКЕТ - 1.ПР.8 80мм' },
    { match: 'ПЛИТА 80', new: 'Тротуарная плитка ПЛИТА - 3.П.8 80мм' },
    { match: 'БОРДЮР МАГИСТРАЛЬНЫЙ', new: 'Бордюр магистральный 1000х300х180' },
    { match: 'БОРДЮР ДОРОЖНЫЙ', new: 'Бордюр дорожный 1000х300х150' },
    { match: 'ПОРЕБРИК', new: 'Поребрик газонный 1000х200х80' },
    { match: 'БЛОК СТЕНОВОЙ', new: 'Блок стеновой 200x200x400' },
    { match: 'ПОЛУБЛОК', new: 'Полублок 120x200x60' }
];

const colors = ['Серая', 'Красная', 'Белая', 'Желтая', 'Коричневая', 'Черная', 'Оранжевая', 'Оникс', 'Осень', 'Рубин', 'Янтарь', 'Яшма'];

const mColors = { 'Серая': 'Серый', 'Красная': 'Красный', 'Белая': 'Белый', 'Желтая': 'Желтый', 'Коричневая': 'Коричневый', 'Черная': 'Черный', 'Оранжевая': 'Оранжевый', 'Серый': 'Серый', 'Красный': 'Красный', 'Белый': 'Белый', 'Желтый': 'Желтый', 'Коричневый': 'Коричневый', 'Черный': 'Черный', 'Оранжевый': 'Оранжевый' };

function getFinalName(oldName) {
    if (oldName === 'Тест') return null;
    const up = oldName.toUpperCase();

    // Ищем правило
    const rule = baseRules.find(r => up.includes(r.match));
    if (!rule) return null;

    const isM = rule.match.includes('БОРДЮР') || rule.match.includes('ПОРЕБРИК') || rule.match.includes('БЛОК') || rule.match.includes('ПОЛУБЛОК');

    // Фактура
    let texture = isM ? 'Гладкий' : 'Гладкая';
    if (up.includes('ГРАНИТ') && up.includes('МЕЛАНЖ')) texture = 'Меланж Гранит';
    else if (up.includes('МЕЛАНЖ')) texture = isM ? 'Меланж Гладкий' : 'Меланж Гладкая';
    else if (up.includes('ГРАНИТ')) texture = 'Гранит';
    else if (up.includes('ГЛАДК')) texture = isM ? 'Гладкий' : 'Гладкая';

    // Цвет
    let color = colors.find(c => oldName.includes(c)) || (isM ? 'Серый' : 'Серая');
    if (isM && mColors[color]) color = mColors[color];
    if (!isM && mColors[color]) color = Object.keys(mColors).find(key => mColors[key] === color && key.endsWith('ая')) || color;

    return `${rule.new} ${texture} ${color}`.replace(/\s+/g, ' ').trim();
}

async function run() {
    const isExec = process.argv.includes('--execute');
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT id, name FROM items WHERE item_type = 'product' AND is_deleted IS NOT TRUE");
        console.log(`--- НАЧАЛО: ${isExec ? 'БОЕВОЙ РЕЖИМ' : 'ТЕСТ (DRY RUN)'} ---`);
        if (isExec) await client.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS legacy_name VARCHAR(255)");

        for (const row of res.rows) {
            const final = getFinalName(row.name);
            if (!final || final === row.name) continue;

            console.log(`[ID:${row.id}] ${row.name.padEnd(55)} -> ${final}`);
            if (isExec) {
                await client.query("UPDATE items SET legacy_name = name WHERE id = $1 AND legacy_name IS NULL", [row.id]);
                await client.query("UPDATE items SET name = $1 WHERE id = $2", [final, row.id]);
            }
        }
    } finally {
        client.release();
        await pool.end();
        console.log('\nГотово.');
    }
}
run();