/**
 * АУДИТ МОДУЛЯ: dashboard
 * Те же 6 проверок что и full_audit.js
 */
const fs = require('fs');

const jsContent = fs.readFileSync('public/js/dashboard.js', 'utf8');
const ejsContent = fs.readFileSync('views/modules/dashboard.ejs', 'utf8');

let errors = 0, warnings = 0;

// Загрузим все route-файлы для проверки API
const routeFiles = {};
['routes/production.js','routes/inventory.js','routes/dictionaries.js','routes/finance.js','routes/sales.js','routes/hr.js','routes/docs.js'].forEach(f => {
    try { routeFiles[f] = fs.readFileSync(f, 'utf8'); } catch(e) {}
});
const allRoutes = [];
for (const [file, content] of Object.entries(routeFiles)) {
    const re = /router\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
    let m;
    while ((m = re.exec(content)) !== null) allRoutes.push({ method: m[1].toUpperCase(), url: m[2], file });
}

console.log('='.repeat(60));
console.log('  📦 АУДИТ МОДУЛЯ: DASHBOARD');
console.log('='.repeat(60));

// --- 1. onclick/onchange → функция существует ---
console.log('\n📋 Проверка 1: onclick/onchange → функция существует');

// Находим все определения функций и window экспорты
const defs = new Set();
const windowExports = new Set();
let m;

const funcDeclRe = /(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
while ((m = funcDeclRe.exec(jsContent)) !== null) defs.add(m[1]);

const winFuncRe = /window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function/g;
while ((m = winFuncRe.exec(jsContent)) !== null) { defs.add(m[1]); windowExports.add(m[1]); }

const winReExportRe = /window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\1/g;
while ((m = winReExportRe.exec(jsContent)) !== null) windowExports.add(m[1]);

// Находим все вызовы из onclick/onchange в EJS
const htmlHandlerRe = /on(?:click|change|input|blur|keyup|keydown|submit|focus)\s*=\s*["']([^"']+)["']/gi;
const ejsHandlers = [];
while ((m = htmlHandlerRe.exec(ejsContent)) !== null) {
    const funcMatch = m[1].trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
    if (funcMatch) ejsHandlers.push({ func: funcMatch[1], line: ejsContent.substring(0, m.index).split('\n').length });
}

// Находим вызовы из динамического HTML в JS
const dynamicRe = /on(?:click|change|input|blur|keyup|keydown|submit|focus)\s*=\s*\\?["']([^"'\\]+)/gi;
const jsHandlers = [];
while ((m = dynamicRe.exec(jsContent)) !== null) {
    const funcMatch = m[1].trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
    if (funcMatch) {
        const fn = funcMatch[1];
        if (!['document','this','event','console','window','UI','API','Math','JSON','parseInt','parseFloat','alert','confirm'].includes(fn))
            jsHandlers.push({ func: fn, line: jsContent.substring(0, m.index).split('\n').length });
    }
}

const allHandlers = [...ejsHandlers, ...jsHandlers];
const checked = new Set();
let check1ok = true;
const isIIFE = jsContent.includes('(function()') || jsContent.includes(';(function()');

for (const h of allHandlers) {
    if (checked.has(h.func)) continue;
    checked.add(h.func);
    if (['UI','API','document','this','event','console','window','toggleSection'].includes(h.func)) continue;
    
    const isDefined = defs.has(h.func) || windowExports.has(h.func);
    const isExported = windowExports.has(h.func);
    
    if (!isDefined) {
        console.log(`  ❌ ERROR: "${h.func}" вызывается из обработчика (строка ${h.line}), но НЕ ОПРЕДЕЛЕНА!`);
        errors++; check1ok = false;
    } else if (!isExported && isIIFE) {
        console.log(`  ❌ ERROR: "${h.func}" определена, но НЕ экспортирована в window (внутри IIFE)`);
        errors++; check1ok = false;
    }
}
if (check1ok) console.log('  ✅ Все обработчики ссылаются на существующие функции');

// --- 2. getElementById → элемент в EJS ---
console.log('\n📋 Проверка 2: getElementById → элемент существует в EJS');
const idRe = /getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const ejsIdRe = /id\s*=\s*["']([^"']+)["']/g;
const ejsIds = new Set();
while ((m = ejsIdRe.exec(ejsContent)) !== null) ejsIds.add(m[1]);
// Добавляем ID из динамического HTML в JS
const dynIdRe = /id\s*=\s*["'`]([^"'`$]+)["'`]/g;
while ((m = dynIdRe.exec(jsContent)) !== null) ejsIds.add(m[1]);

const missingIds = new Set();
let check2ok = true;
while ((m = idRe.exec(jsContent)) !== null) {
    const id = m[1];
    if (id.includes('${') || id.includes('+')) continue;
    if (!ejsIds.has(id) && !missingIds.has(id)) {
        const createdDyn = jsContent.includes(`id="${id}"`) || jsContent.includes(`id='${id}'`);
        if (!createdDyn) {
            console.log(`  ⚠️ WARNING: getElementById("${id}") — элемент не найден в EJS`);
            warnings++; check2ok = false; missingIds.add(id);
        }
    }
}
if (check2ok) console.log('  ✅ Все getElementById ссылаются на существующие элементы');

// --- 3. Дубли class ---
console.log('\n📋 Проверка 3: Дублирование атрибутов class');
let check3ok = true;
[{content: ejsContent, name: 'dashboard.ejs'}, {content: jsContent, name: 'dashboard.js'}].forEach(({content, name}) => {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
        const tags = line.match(/<[a-zA-Z][^>]*>/g);
        if (tags) tags.forEach(tag => {
            if ((tag.match(/\bclass\s*=/g) || []).length > 1) {
                console.log(`  ⚠️ WARNING: Дубль class в ${name}:${i+1}: ${tag.substring(0,80)}...`);
                warnings++; check3ok = false;
            }
        });
    });
});
if (check3ok) console.log('  ✅ Нет дублирующихся атрибутов class');

// --- 4. API → маршрут ---
console.log('\n📋 Проверка 4: API-вызовы → маршруты');
const apiRe = /API\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
let check4ok = true;
while ((m = apiRe.exec(jsContent)) !== null) {
    let baseUrl = m[2].split('?')[0].replace(/\$\{[^}]+\}/g, ':param');
    const found = allRoutes.find(r => r.url.replace(/:[\w]+/g, ':param') === baseUrl);
    if (!found && !baseUrl.includes(':param')) {
        const withParam = baseUrl.replace(/\/\d+$/, '/:param');
        const found2 = allRoutes.find(r => r.url.replace(/:[\w]+/g, ':param') === withParam);
        if (!found2) {
            // Check web.js too
            const webJs = fs.readFileSync('web.js', 'utf8');
            if (!webJs.includes(baseUrl)) {
                console.log(`  ⚠️ WARNING: API ${m[1].toUpperCase()} ${m[2]} — маршрут не найден`);
                warnings++; check4ok = false;
            }
        }
    }
}
if (check4ok) console.log('  ✅ Все API-вызовы имеют маршруты');

// --- 5. try/catch ---
console.log('\n📋 Проверка 5: Обработка ошибок');
const tryCount = (jsContent.match(/\btry\s*\{/g) || []).length;
const catchCount = (jsContent.match(/\bcatch\s*\(/g) || []).length;
if (tryCount !== catchCount) {
    console.log(`  ⚠️ WARNING: try(${tryCount}) != catch(${catchCount})`);
    warnings++;
} else {
    console.log(`  ✅ try/catch сбалансированы (${tryCount}/${catchCount})`);
}

// --- 6. Синтаксис ---
console.log('\n📋 Проверка 6: Синтаксис JS');
const { execSync } = require('child_process');
try {
    execSync('node -c public/js/dashboard.js', { stdio: 'pipe' });
    console.log('  ✅ Синтаксис корректен');
} catch (e) {
    console.log(`  ❌ ERROR: ${e.stderr?.toString()}`);
    errors++;
}

// --- ИТОГИ ---
console.log(`\n${'='.repeat(60)}`);
console.log(`  📊 ИТОГИ: ${errors} ошибок, ${warnings} предупреждений`);
if (errors === 0 && warnings === 0) console.log('  🟢 Все проверки пройдены!');
console.log('');
