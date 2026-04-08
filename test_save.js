const { Pool } = require('pg'); 
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' }); 
async function test() { 
    const client = await pool.connect(); 
    try { 
        await client.query('BEGIN'); 
        await client.query('DELETE FROM recipes WHERE product_id = $1', [433]); 
        await client.query('INSERT INTO recipes (product_id, material_id, quantity_per_unit) VALUES ($1, $2, $3)', [433, 153, 5]); 
        await client.query('COMMIT'); 
        console.log('Successfully saved to recipes'); 
    } catch(e) { 
        await client.query('ROLLBACK'); 
        console.log('Error', e.message); 
    } finally { 
        client.release(); 
        pool.end(); 
    } 
} 
test();
