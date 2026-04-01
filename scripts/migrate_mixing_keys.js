const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function migrateKeys() {
    const client = await pool.connect();
    try {
        console.log('--- НАЧАЛО МИГРАЦИИ КЛЮЧЕЙ ЗАМЕСОВ (ПОВНАЯ МАТРИЦА ИСЧЕРПЫВАЮЩИХ КЛЮЧЕЙ) ---');
        
        await client.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS mix_main_tpl VARCHAR(50)");
        await client.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS mix_face_tpl VARCHAR(50)");

        const res = await client.query("SELECT id, name FROM items WHERE item_type = 'product'");
        let count = 0;

        for (const row of res.rows) {
            const name = row.name; 
            
            // --- 1. ОПРЕДЕЛЕНИЕ ОСНОВНОГО СЛОЯ ---
            let mainKey = 'main_tile_60'; // Default fallback
            if (name.includes('Блок') || name.includes('Полублок')) mainKey = 'main_block';
            else if (name.includes('Бордюр дорожный')) mainKey = 'main_bor_dor';
            else if (name.includes('Бордюр магистральный')) mainKey = 'main_bor_mag';
            else if (name.includes('Поребрик')) mainKey = 'main_por';
            else if (name.includes('40мм')) mainKey = 'main_tile_40';
            else if (name.includes('60мм')) mainKey = 'main_tile_60';
            else if (name.includes('80мм')) mainKey = 'main_tile_80';

            // --- 2. ОПРЕДЕЛЕНИЕ ЛИЦЕВОГО СЛОЯ ---
            let textureStr = '';
            // Проверяем фактуры от самых сложных (составных) к простым
            if (name.includes('Меланж Гранит')) textureStr = 'mel_gr';
            else if (name.includes('Меланж Гладкая') || name.includes('Меланж Гладкий')) textureStr = 'mel_sm';
            else if (name.includes('Гранит')) textureStr = 'granite';
            else if (name.includes('Гладкая') || name.includes('Гладкий')) textureStr = 'smooth';
            else textureStr = 'smooth'; // Default if none found

            let colorStr = '';
            if (name.includes('Белая') || name.includes('Белый')) colorStr = 'white';
            else if (name.includes('Серая') || name.includes('Серый')) colorStr = 'grey';
            else if (name.includes('Черная') || name.includes('Черный')) colorStr = 'black';
            else if (name.includes('Красная') || name.includes('Красный')) colorStr = 'red';
            else if (name.includes('Желтая') || name.includes('Желтый')) colorStr = 'yellow';
            else if (name.includes('Коричневая') || name.includes('Коричневый')) colorStr = 'brown';
            else if (name.includes('Оранжевая') || name.includes('Оранжевый')) colorStr = 'orange';
            else if (name.includes('Оникс')) colorStr = 'onyx';
            else if (name.includes('Осень')) colorStr = 'autumn';
            else if (name.includes('Янтарь')) colorStr = 'amber';
            else if (name.includes('Яшма')) colorStr = 'jasper';
            else if (name.includes('Рубин')) colorStr = 'ruby';
            else colorStr = 'grey'; // Default if none found

            const faceKey = `face_${textureStr}_${colorStr}`;

            await client.query(
                "UPDATE items SET mix_main_tpl = $1, mix_face_tpl = $2 WHERE id = $3",
                [mainKey, faceKey, row.id]
            );
            
            console.log(`[ID:${row.id}] ${name} -> ${mainKey} / ${faceKey}`);
            count++;
        }
        console.log(`\nМИГРАЦИЯ УСПЕШНО ЗАВЕРШЕНА. Изменено позиций: ${count}`);
    } catch (err) {
        console.error('Ошибка миграции:', err);
    } finally {
        client.release();
        await pool.end();
    }
}
migrateKeys();
