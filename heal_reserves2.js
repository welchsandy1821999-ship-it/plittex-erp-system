const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function heal() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = `
WITH MatchData AS (
  SELECT 
      sr.id as sr_id, 
      ss.linked_order_item_id 
  FROM inventory_movements sr
  JOIN inventory_movements ss 
    ON ss.movement_type = 'sales_shipment' 
   AND ss.item_id = sr.item_id 
   AND ss.description ILIKE '%' || SUBSTRING(sr.description FROM 'УТ-[0-9]+') || '%'
  WHERE sr.movement_type = 'shipment_reversal' AND sr.linked_order_item_id IS NULL
)
UPDATE inventory_movements im
SET linked_order_item_id = md.linked_order_item_id
FROM MatchData md
WHERE im.id = md.sr_id
RETURNING im.id, im.linked_order_item_id;
    `;
    const res = await client.query(q);
    console.log('Fixed orphaned shipment_reversals:', res.rowCount);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
    pool.end();
  }
}
heal();
