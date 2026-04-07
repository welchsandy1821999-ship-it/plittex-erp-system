const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'plittex_erp',
    password: 'Plittex_2026_SQL',
    port: 5432,
});

async function run() {
    const client = await pool.connect();
    let mismatches = 0;
    try {
        const dbItems = await client.query("SELECT * FROM items");
        const items = dbItems.rows;

        const fileContent = fs.readFileSync('ревизия_склада_март2026.csv', 'utf8');
        let lines = fileContent.replace(/^\uFEFF/, '').split(/\r?\n/);

        console.log("=== Checking W4 (1-й сорт) ===");
        for(let i=1; i<lines.length; i++){
            const line = lines[i].trim();
            if(!line || line.startsWith('ИТОГО')) continue;
            const parts = line.split(';');
            if(parts.length >= 5) {
                const name = parts[0].trim();
                const grade = parts[1].trim() || '1 сорт';
                const qty = parseFloat(parts[2].replace(',', '.') || 0);

                if (grade.includes('2 сорт') || grade.includes('Эксп')) continue;

                // Find in DB
                const dbItem = items.find(d => d.name === name);
                if (dbItem) {
                    const st = await client.query("SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_movements WHERE item_id=$1 AND warehouse_id=4", [dbItem.id]);
                    const actualQty = parseFloat(st.rows[0].q);
                    
                    if (Math.abs(actualQty - qty) > 0.01) {
                         console.log(`MISMATCH: ${name} -> CSV says ${qty}, but W4 has ${actualQty}`);
                         mismatches++;
                    }
                }
            }
        }
        
    } finally {
        client.release();
        pool.end();
    }
    if (mismatches === 0) console.log("SUCCESS! All 1-st grade / W4 matched exactly.");
}
run();
