const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function migrate() {
    console.log('--- СТАРТ МИГРАЦИИ JSON ШАБЛОНОВ ---');
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT value FROM settings WHERE key='mix_templates'");
        if (res.rows.length === 0) {
            console.log('Шаблоны не найдены.');
            return;
        }

        const oldTpl = res.rows[0].value;
        const newTpl = { ...oldTpl }; // Сохраняем и старые на всякий случай

        // Маппинг ОСНОВНОГО СЛОЯ
        if (oldTpl.main_40) newTpl.main_tile_40 = oldTpl.main_40;
        if (oldTpl.main_60) {
            newTpl.main_tile_60 = oldTpl.main_60;
            newTpl.main_block = oldTpl.main_60;
        }
        if (oldTpl.main_80) newTpl.main_tile_80 = oldTpl.main_80;
        if (oldTpl.main_bor) {
            newTpl.main_bor_dor = oldTpl.main_bor;
            newTpl.main_bor_mag = oldTpl.main_bor;
        }
        if (oldTpl.main_por) newTpl.main_por = oldTpl.main_por;

        // Маппинг ЛИЦЕВОГО СЛОЯ
        if (oldTpl.face_gs) {
            ['face_smooth_grey', 'face_smooth_white', 'face_smooth_black'].forEach(k => newTpl[k] = oldTpl.face_gs);
        }
        if (oldTpl.face_gc) {
            ['face_smooth_red', 'face_smooth_yellow', 'face_smooth_brown', 'face_smooth_orange'].forEach(k => newTpl[k] = oldTpl.face_gc);
        }
        if (oldTpl.face_grs) {
            ['face_granite_grey', 'face_granite_white', 'face_granite_black'].forEach(k => newTpl[k] = oldTpl.face_grs);
        }
        if (oldTpl.face_grc) {
            ['face_granite_red', 'face_granite_yellow', 'face_granite_brown', 'face_granite_orange'].forEach(k => newTpl[k] = oldTpl.face_grc);
        }
        if (oldTpl.face_mel_g) {
            ['face_mel_sm_onyx', 'face_mel_sm_autumn', 'face_mel_sm_amber', 'face_mel_sm_jasper', 'face_mel_sm_ruby'].forEach(k => newTpl[k] = oldTpl.face_mel_g);
        }
        if (oldTpl.face_mel_gr) {
            ['face_mel_gr_onyx', 'face_mel_gr_autumn', 'face_mel_gr_amber', 'face_mel_gr_jasper', 'face_mel_gr_ruby'].forEach(k => newTpl[k] = oldTpl.face_mel_gr);
        }

        await client.query("UPDATE settings SET value=$1 WHERE key='mix_templates'", [newTpl]);
        console.log('✅ УСПЕШНО: JSON объект mix_templates размножен под новые ключи.');
        
    } catch (err) {
        console.error('Ошибка:', err);
    } finally {
        client.release();
        await pool.end();
    }
}
migrate();
