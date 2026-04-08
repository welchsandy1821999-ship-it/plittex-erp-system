const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:Plittex_2026_SQL@localhost:5432/plittex_erp' });

async function run() {
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const movements = await client.query(`
                SELECT m.id as mov_id, m.item_id 
                FROM inventory_movements m
                JOIN items i ON m.item_id = i.id
                WHERE m.warehouse_id = 5 
                  AND i.name NOT ILIKE '%2 сорт%' 
                  AND i.name NOT ILIKE '%2-й сорт%'
            `);
            
            console.log(`Found ${movements.rows.length} movements to migrate.`);
            
            let migratedItems = 0;
            
            for (let mov of movements.rows) {
                const origItemRes = await client.query('SELECT name, article, category, unit, current_price, item_type, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark, dealer_price FROM items WHERE id = $1', [mov.item_id]);
                if (origItemRes.rows.length === 0) continue;
                
                const orig = origItemRes.rows[0];
                const newName = `${orig.name.trim()} 2 сорт`;
                const newArticle = orig.article ? `${orig.article.trim()}2S` : `${mov.item_id}-2S`;
                const newPrice = orig.current_price ? (orig.current_price / 2) : 0;
                const newDealerPrice = orig.dealer_price ? (orig.dealer_price / 2) : 0;
                
                let newItemId;
                const checkExistRes = await client.query('SELECT id FROM items WHERE name = $1 AND is_deleted = false LIMIT 1', [newName]);
                if (checkExistRes.rows.length > 0) {
                    newItemId = checkExistRes.rows[0].id;
                } else {
                    const insertRes = await client.query(`
                        INSERT INTO items (name, article, category, unit, current_price, dealer_price, item_type, is_deleted, weight_kg, qty_per_cycle, amortization_per_cycle, mold_id, gost_mark)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)
                        RETURNING id
                    `, [newName, newArticle, orig.category, orig.unit, newPrice, newDealerPrice, orig.item_type, orig.weight_kg, orig.qty_per_cycle, orig.amortization_per_cycle, orig.mold_id, orig.gost_mark]);
                    newItemId = insertRes.rows[0].id;
                    migratedItems++;
                }
                
                await client.query('UPDATE inventory_movements SET item_id = $1 WHERE id = $2', [newItemId, mov.mov_id]);
            }
            
            await client.query('COMMIT');
            console.log(`Successfully updated ${movements.rows.length} movements and created ${migratedItems} new 2nd grade items.`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Transaction rolled back due to error:', err);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Connection error:', err);
    } finally {
        pool.end();
    }
}
run();
