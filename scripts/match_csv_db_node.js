const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'plittex_db',
    password: 'password',
    port: 5432,
});

function normalizeName(name) {
    if (!name) return '';
    return name.toLowerCase().trim().replace(/\s+/g, ' ').replace(/x/g, 'х');
}

function calculateSimilarity(str1, str2) {
    // Very simple similarity for quick fallback check, or just inclusion
    let matches = 0;
    const words1 = str1.split(' ');
    const words2 = str2.split(' ');
    for (const w of words1) {
        if (str2.includes(w)) matches++;
    }
    return matches / Math.max(words1.length, words2.length);
}

async function run() {
    try {
        const fileContent = fs.readFileSync('ревизия_склада_март2026.csv', 'utf-8');
        const lines = fileContent.split('\n');
        
        const csvItems = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('ИТОГО ПО СКЛАДУ')) continue;
            
            // split by ';' correctly handling missing parts
            const parts = line.split(';');
            if (parts.length >= 5) {
                const name = parts[0].trim();
                if(name) {
                    csvItems.push({
                        name: name,
                        grade: parts[1].trim() || '1 сорт',
                        qty: parseFloat(parts[2].replace(',', '.') || 0),
                        base_price: parseFloat(parts[3].replace(',', '.') || 0),
                        unit_price: parseFloat(parts[4].replace(',', '.') || 0)
                    });
                }
            }
        }

        const result = await pool.query("SELECT id, name, category, current_price, is_archived FROM items WHERE category != 'Сырье'");
        const dbItems = result.rows;
        const dbMap = {};
        const dbNormMap = {};
        
        dbItems.forEach(item => {
            dbMap[item.name] = item;
            dbNormMap[normalizeName(item.name)] = item;
        });

        const exactMatches = [];
        const fuzzyMatches = [];
        const notFound = [];

        for (const item of csvItems) {
            const normName = normalizeName(item.name);
            if (dbMap[item.name]) {
                exactMatches.push({ csv: item, db: dbMap[item.name] });
            } else if (dbNormMap[normName]) {
                exactMatches.push({ csv: item, db: dbNormMap[normName] });
            } else {
                let bestMatch = null;
                let bestScore = 0;
                Object.keys(dbNormMap).forEach(key => {
                    const score = calculateSimilarity(normName, key);
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = dbNormMap[key];
                    }
                });
                
                if (bestScore > 0.6) {
                    fuzzyMatches.push({ csv: item, db: bestMatch, score: bestScore });
                } else {
                    notFound.push(item);
                }
            }
        }

        let report = `# Отчет: Сопоставление ревизии с БД\n\n`;
        report += `**Всего уникальных позиций в файле ревизии:** ${csvItems.length}\n`;
        report += `**Найдено точных совпадений:** ${exactMatches.length}\n`;
        report += `**Частичных совпадений (требуют проверки):** ${fuzzyMatches.length}\n`;
        report += `**Не найдено в базе (новые карточки):** ${notFound.length}\n\n`;

        if (notFound.length > 0) {
            report += `## 🚨 Не найдено в базе ERP (Новые позиции: ${notFound.length})\n`;
            report += `| Наименование в CSV | Сорт | Цена в CSV | Ожидаемое действие |\n`;
            report += `|---|---|---|---|\n`;
            notFound.forEach(i => {
                report += `| ${i.name} | ${i.grade} | ${i.unit_price} | Создать карточку |\n`;
            });
            report += `\n`;
        }

        if (fuzzyMatches.length > 0) {
            report += `## ⚠️ Частичные совпадения (${fuzzyMatches.length})\n`;
            report += `| Наименование в CSV | Наименование в БД | Совпадение | Цена CSV | Цена БД |\n`;
            report += `|---|---|---|---|---|\n`;
            fuzzyMatches.forEach(m => {
                report += `| ${m.csv.name} | ${m.db.name} | ${Math.round(m.score * 100)}% | ${m.csv.unit_price} | ${m.db.current_price} |\n`;
            });
            report += `\n`;
        }
        
        const priceDiffs = exactMatches.filter(m => m.csv.grade === '1 сорт' && m.csv.base_price !== Number(m.db.current_price));
        if (priceDiffs.length > 0) {
            report += `## 💰 Расхождения цен по 1-му сорту (${priceDiffs.length})\n`;
            report += `| Наименование | Цена в CSV (Новая) | Цена в БД (Старая) |\n`;
            report += `|---|---|---|\n`;
            priceDiffs.forEach(m => {
                report += `| ${m.csv.name} | ${m.csv.base_price} | ${m.db.current_price} |\n`;
            });
        }

        fs.writeFileSync('C:/Users/Пользователь/.gemini/antigravity/brain/104a1864-8ecc-4e2f-825c-f290b319d8b4/artifacts/csv_db_match_report.md', report);
        console.log("Analysis complete. Written to artifact csv_db_match_report.md.");

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
