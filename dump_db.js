const { Pool } = require('pg'); 
const pool = new Pool({ user: 'postgres', password: 'Plittex_2026_SQL', host: 'localhost', port: 5432, database: 'plittex_erp' }); 
async function getDbInfo() { 
    try { 
        const resRecipes = await pool.query("SELECT * FROM settings WHERE key = 'mix_templates'"); 
        console.log('--- SETTINGS mix_templates ---'); 
        console.log(JSON.stringify(resRecipes.rows, null, 2)); 
        
        const resTable = await pool.query("SELECT * FROM recipes LIMIT 5");
        console.log('--- TABLE recipes ---');
        console.log(JSON.stringify(resTable.rows, null, 2));
    } catch (e) { 
        console.error('Error:', e.message); 
    } finally { 
        await pool.end(); 
    } 
} 
getDbInfo();
