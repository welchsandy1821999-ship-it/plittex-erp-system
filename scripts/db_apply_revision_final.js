const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'plittex_erp',
    password: 'Plittex_2026_SQL',
    port: 5432,
});

// Hardcoded manual mappings for the 13 tricky items without SKU
const MANUAL_MAPPING = {
    'бордюр дорожный серый': 'Бордюр дорожный 1000х300х150 Гладкий Серый',
    'бордюр дорожный меланж "осень"': 'Бордюр дорожный 1000х300х150 Меланж Гладкий Осень',
    'плита тротуарная гранитная 1.см.8 "сити-микс" осень': 'Тротуарная плитка СИТИ-МИКС - 1.СМ.8 80мм Меланж Гладкая Осень',
    'полублок': null, // Need to handle manually or create
    'поребрик желтый': 'Поребрик 1000х200х80 Гладкий Желтый',
    'поребрик коричневый': 'Поребрик 1000х200х80 Гладкий Коричневый',
    'поребрик красный': 'Поребрик 1000х200х80 Гладкий Красный',
    'поребрик оранжевый': 'Поребрик 1000х200х80 Гладкий Оранжевый',
    'поребрик меланж рубин': 'Поребрик 1000х200х80 Меланж Гладкий Рубин',
    'поребрик серый': 'Поребрик 1000х200х80 Гладкий Серый',
    'поребрик черный': 'Поребрик 1000х200х80 Гладкий Черный',
    'поребрик меланж яшма': 'Поребрик 1000х200х80 Меланж Гладкий Яшма'
};

function normalizeName(name) {
    if (!name) return '';
    return name.toLowerCase().replace(/["'-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/x/g, 'х');
}

function extractSku(name) {
    const match = name.match(/\d+\.[а-яa-z]+\.\d+(?:,\d+)?/i);
    return match ? match[0].toUpperCase() : null;
}

function extractColors(name) {
    const n = name.toLowerCase().replace(/ё/g, 'е');
    const cols = ["бел", "желт", "коричнев", "красн", "оранжев", "сер", "черн", "оникс", "осень", "рубин", "яшма", "янтар"];
    const found = [];
    cols.forEach(c => { if(n.includes(c)) found.push(c); });
    if(n.includes("меланж")) found.push("меланж");
    return found.sort().join('|');
}

function extractTexture(name) {
    if(name.toLowerCase().includes("гранит")) return "гранит";
    return "гладк";
}

async function run() {
    const client = await pool.connect();
    try {
        console.log("Cleaning up previous revision attempts...");
        await client.query("DELETE FROM inventory_movements WHERE description = 'Ревизия склада Загрузка CSV (Март 2026)'");

        console.log("Loading ERP Items...");
        const res = await client.query("SELECT * FROM items WHERE category != 'Сырье'");
        const errItems = res.rows;
        
        let dbBaseItems = []; // Pure base items
        errItems.forEach(item => {
            dbBaseItems.push(item);
        });

        console.log("Loading CSV...");
        const fileContent = fs.readFileSync('ревизия_склада_март2026.csv', 'utf8');
        // Handle potential BOM
        let lines = fileContent.replace(/^\uFEFF/, '').split(/\r?\n/);
        
        // Aggregate CSV
        const aggregatedCsv = {};
        for(let i=1; i<lines.length; i++){
            const line = lines[i].trim();
            if(!line || line.startsWith('ИТОГО')) continue;
            const parts = line.split(';');
            if(parts.length >= 5) {
                const name = parts[0].trim();
                const grade = parts[1].trim() || '1 сорт';
                const qty = parseFloat(parts[2].replace(',', '.') || 0);
                const base_price = parseFloat(parts[3].replace(',', '.') || 0);
                const unit_price = parseFloat(parts[4].replace(',', '.') || 0);
                
                const key = name + '|' + grade;
                if(!aggregatedCsv[key]) {
                    aggregatedCsv[key] = { name, grade, qty, base_price, unit_price };
                } else {
                    aggregatedCsv[key].qty += qty;
                }
            }
        }
        
        console.log(`Processing ${Object.keys(aggregatedCsv).length} unique lines...`);
        let createdCount = 0;
        let updateCount = 0;
        let diffCount = 0;
        
        for (const key in aggregatedCsv) {
            const csvItem = aggregatedCsv[key];
            const lowerName = csvItem.name.toLowerCase();
            const normName = normalizeName(csvItem.name);
            const isDerived = csvItem.grade.toLowerCase().includes('2 сорт') || csvItem.grade.toLowerCase().includes('эксп');
            
            // 1. FIND BASE ITEM
            let baseItem = null;
            
            // Strip out grade text for lookup
            let cleanNormForLookup = normName.replace(/2\s*сорт/gi, '').replace(/экспериментальная/gi, '').replace(/эксперементальная/gi, '').trim();

            const c_sku = extractSku(cleanNormForLookup);
            const c_col = extractColors(cleanNormForLookup);
            const c_tex = extractTexture(cleanNormForLookup);
            
            // Check manual map first
            let manualFound = null;
            for(const [mk, mv] of Object.entries(MANUAL_MAPPING)) {
                if(cleanNormForLookup.includes(normalizeName(mk))) {
                    manualFound = mv;
                    break;
                }
            }
            
            if(manualFound) {
                baseItem = dbBaseItems.find(d => d.name === manualFound);
            } else {
                for (const d of dbBaseItems) {
                    if (d.name === csvItem.name) {
                        baseItem = d;
                        break;
                    }
                    if (normalizeName(d.name) === cleanNormForLookup) {
                        baseItem = d;
                        break;
                    }
                    const d_sku = extractSku(d.name);
                    if (c_sku && d_sku && c_sku === d_sku && c_col === extractColors(d.name) && c_tex === extractTexture(d.name)) {
                        baseItem = d;
                        break;
                    }
                }
            }
            
            if (!baseItem) {
                // If it's pure Uriko or completely new, create as 1st grade directly
                if (normName.includes("урико") || normName.includes("полублок")) {
                    console.log(`[CREATE BASE] Creating missing base item: ${csvItem.name}`);
                    let category = normName.includes("урико") ? ((c_tex === 'гранит') ? "Плитка гранитная" : "Плитка гладкая") : "Прочее";
                    const insertRes = await client.query(
                        `INSERT INTO items (name, category, current_price, unit, item_type) VALUES ($1, $2, $3, 'кв.м', 'Продукция') RETURNING *`, 
                        [csvItem.name, category, csvItem.unit_price]
                    );
                    baseItem = insertRes.rows[0];
                    dbBaseItems.push(baseItem); // add to dictionary
                    createdCount++;
                } else {
                    console.log(`WARNING: Could not find base item for ${csvItem.name}`);
                    continue;
                }
            }
            
            // 2. RESOLVE FINAL ITEM
            let finalItem = null;
            if (isDerived) {
                // Determine suffix
                let suffix = csvItem.grade.toLowerCase().includes('2 сорт') ? '2 сорт' : 'Экспериментальная';
                let newName = `${baseItem.name} ${suffix}`;
                
                // Does it exist?
                const exRes = await client.query(`SELECT * FROM items WHERE name = $1`, [newName]);
                if (exRes.rows.length > 0) {
                    finalItem = exRes.rows[0];
                } else {
                    console.log(`[CREATE GRADE 2] ${newName}`);
                    const instRes = await client.query(
                        `INSERT INTO items (name, category, current_price, unit, item_type) VALUES ($1, $2, $3, $4, 'Продукция') RETURNING *`,
                        [newName, baseItem.category, csvItem.unit_price, baseItem.unit]
                    );
                    finalItem = instRes.rows[0];
                    createdCount++;
                }
            } else {
                finalItem = baseItem;
                // Update price for 1st grade
                await client.query(`UPDATE items SET current_price = $1 WHERE id = $2`, [csvItem.unit_price, finalItem.id]);
                updateCount++;
            }
            
            // 3. INVENTORY CHECK & ADJUSTMENT
            // Warehouse rules
            const warehouse_id = isDerived ? 5 : 4; 
            
            const currentStockRes = await client.query(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_movements WHERE item_id = $1 AND warehouse_id = $2`, [finalItem.id, warehouse_id]);
            const currentStock = parseFloat(currentStockRes.rows[0].qty);
            
            const diff = csvItem.qty - currentStock;
            
            if (Math.abs(diff) > 0.01) {
                const adjustVal = diff.toFixed(2);
                
                const batchRes = await client.query(`SELECT batch_id FROM inventory_movements WHERE item_id = $1 AND batch_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [finalItem.id]);
                const batchId = batchRes.rows.length > 0 ? batchRes.rows[0].batch_id : null;
                
                await client.query(`
                    INSERT INTO inventory_movements 
                    (movement_date, item_id, quantity, movement_type, description, warehouse_id, created_at, user_id, batch_id)
                    VALUES (NOW(), $1, $2, 'ревизия', 'Ревизия склада Загрузка CSV (Март 2026)', $3, NOW(), 1, $4)
                `, [finalItem.id, adjustVal, warehouse_id, batchId]);
                diffCount++;
            }
        }
        
        await client.query('COMMIT');
        console.log(`\nDONE. Created: ${createdCount}, Updated prices: ${updateCount}, Inserted adjustmens: ${diffCount}`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("TRANSACTION FAILED:", e);
    } finally {
        client.release();
        pool.end();
    }
}

run();
