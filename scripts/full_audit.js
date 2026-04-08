/**
 * ПОЛНЫЙ АУДИТ МОДУЛЕЙ: recipes, production, equipment
 * 
 * Проверяет:
 * 1. Все onclick/onchange в EJS и динамическом HTML (JS) → функция существует и экспортирована в window
 * 2. Все getElementById в JS → элемент существует в EJS
 * 3. Дублирующиеся атрибуты class в HTML/EJS
 * 4. API-эндпоинты: фронтенд вызывает → бэкенд обрабатывает  
 * 5. Незакрытые try без catch
 * 6. Функции определены но не экспортированы в window (внутри IIFE)
 */

const fs = require('fs');
const path = require('path');

const MODULES = [
    { name: 'recipes', js: 'public/js/recipes.js', ejs: 'views/modules/recipes.ejs', route: 'routes/production.js' },
    { name: 'production', js: 'public/js/production.js', ejs: 'views/modules/production.ejs', route: 'routes/production.js' },
    { name: 'equipment', js: 'public/js/equipment.js', ejs: 'views/modules/equipment.ejs', route: 'routes/production.js' },
];

const results = [];
let totalErrors = 0;
let totalWarnings = 0;

function log(level, module, message) {
    const icon = level === 'ERROR' ? '❌' : level === 'WARNING' ? '⚠️' : 'ℹ️';
    results.push({ level, module, message: `${icon} [${level}] ${message}` });
    if (level === 'ERROR') totalErrors++;
    if (level === 'WARNING') totalWarnings++;
}

// =============================================================
// 1. Найти все вызовы функций из onclick/onchange
// =============================================================
function findHandlerCalls(content, source) {
    const calls = [];
    // Ищем в статическом HTML (EJS)
    const htmlHandlerRe = /on(?:click|change|input|blur|keyup|keydown|submit|focus)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = htmlHandlerRe.exec(content)) !== null) {
        const handler = m[1].trim();
        // Извлекаем имя функции
        const funcMatch = handler.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
        if (funcMatch) {
            calls.push({ func: funcMatch[1], fullExpr: handler, source, line: content.substring(0, m.index).split('\n').length });
        }
    }
    return calls;
}

// Найти все вызовы из динамического HTML в JS (шаблонные литералы и строки)
function findDynamicHandlerCalls(jsContent, source) {
    const calls = [];
    const dynamicRe = /on(?:click|change|input|blur|keyup|keydown|submit|focus)\s*=\s*\\?["']([^"'\\]+)/gi;
    let m;
    while ((m = dynamicRe.exec(jsContent)) !== null) {
        const handler = m[1].trim();
        const funcMatch = handler.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
        if (funcMatch) {
            const funcName = funcMatch[1];
            // Пропускаем встроенные DOM-методы и UI вызовы
            if (['document', 'this', 'event', 'console', 'window', 'UI', 'API', 'Math', 'JSON', 'Date', 'String', 'Number', 'Array', 'Object', 'parseInt', 'parseFloat', 'alert', 'confirm', 'prompt'].includes(funcName)) continue;
            calls.push({ func: funcName, fullExpr: handler, source, line: jsContent.substring(0, m.index).split('\n').length });
        }
    }
    return calls;
}

// =============================================================
// 2. Найти все определения функций и window экспорты
// =============================================================
function findDefinedFunctions(jsContent) {
    const defs = new Set();
    const windowExports = new Set();

    // function name(..)
    const funcDeclRe = /(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
    let m;
    while ((m = funcDeclRe.exec(jsContent)) !== null) defs.add(m[1]);

    // const/let/var name = function
    const funcExprRe = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function/g;
    while ((m = funcExprRe.exec(jsContent)) !== null) defs.add(m[1]);

    // const/let/var name = async? (..) =>
    const arrowRe = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\(?/g;
    while ((m = arrowRe.exec(jsContent)) !== null) defs.add(m[1]);

    // window.name = function / async function
    const winFuncRe = /window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function/g;
    while ((m = winFuncRe.exec(jsContent)) !== null) {
        defs.add(m[1]);
        windowExports.add(m[1]);
    }

    // window.name = name (re-export)
    const winReExportRe = /window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/g;
    while ((m = winReExportRe.exec(jsContent)) !== null) {
        windowExports.add(m[1]);
    }

    // if (typeof X === 'function') window.X = X;
    const exportCheckRe = /window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\1/g;
    while ((m = exportCheckRe.exec(jsContent)) !== null) {
        windowExports.add(m[1]);
    }

    return { defs, windowExports };
}

// =============================================================
// 3. Найти все getElementById
// =============================================================
function findGetElementByIdCalls(jsContent) {
    const ids = [];
    const re = /getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let m;
    while ((m = re.exec(jsContent)) !== null) {
        ids.push({ id: m[1], line: jsContent.substring(0, m.index).split('\n').length });
    }
    return ids;
}

function findIdsInEjs(ejsContent) {
    const ids = new Set();
    const re = /id\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(ejsContent)) !== null) ids.add(m[1]);
    return ids;
}

// =============================================================
// 4. Найти дублирующиеся атрибуты class
// =============================================================
function findDuplicateClassAttrs(content, source) {
    const issues = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
        // Ищем теги с 2+ атрибутами class
        const tagMatch = line.match(/<[a-zA-Z][^>]*>/g);
        if (tagMatch) {
            tagMatch.forEach(tag => {
                const classCount = (tag.match(/\bclass\s*=/g) || []).length;
                if (classCount > 1) {
                    issues.push({ line: i + 1, tag: tag.substring(0, 80), source });
                }
            });
        }
    });
    return issues;
}

// =============================================================
// 5. Найти API-вызовы и проверить маршруты
// =============================================================
function findApiCalls(jsContent) {
    const calls = [];
    const re = /API\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
    let m;
    while ((m = re.exec(jsContent)) !== null) {
        calls.push({ method: m[1].toUpperCase(), url: m[2], line: jsContent.substring(0, m.index).split('\n').length });
    }
    // Also find fetch calls
    const fetchRe = /fetch\(\s*['"`]([^'"`]+)['"`]/gi;
    while ((m = fetchRe.exec(jsContent)) !== null) {
        calls.push({ method: 'FETCH', url: m[1], line: jsContent.substring(0, m.index).split('\n').length });
    }
    return calls;
}

function findRouteHandlers(routeContent) {
    const routes = [];
    const re = /router\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
    let m;
    while ((m = re.exec(routeContent)) !== null) {
        routes.push({ method: m[1].toUpperCase(), url: m[2] });
    }
    return routes;
}

// =============================================================
// 6. Проверить IIFE-скоуп
// =============================================================
function checkIIFEScope(jsContent, moduleName) {
    const isIIFE = jsContent.includes('(function()') || jsContent.includes(';(function()');
    if (!isIIFE) return;

    const { defs, windowExports } = findDefinedFunctions(jsContent);
    
    // Находим все вызовы из onclick/onchange в динамическом HTML
    const handlerCalls = findDynamicHandlerCalls(jsContent, `${moduleName}.js`);
    
    // Каждая функция, вызываемая из onclick, ДОЛЖНА быть в window
    const calledFuncs = new Set(handlerCalls.map(h => h.func));
    
    for (const func of calledFuncs) {
        // Пропускаем известные глобальные DOM-методы
        if (['UI', 'API', 'closeModal', 'showModal', 'toast'].includes(func)) continue;
        
        if (defs.has(func) && !windowExports.has(func)) {
            log('ERROR', moduleName, `Функция "${func}" определена внутри IIFE, но НЕ экспортирована в window. Вызов из onclick/onchange не сработает!`);
        } else if (!defs.has(func) && !windowExports.has(func)) {
            log('ERROR', moduleName, `Функция "${func}" вызывается из onclick/onchange, но ВООБЩЕ НЕ ОПРЕДЕЛЕНА в файле!`);
        }
    }
}

// =============================================================
// MAIN AUDIT
// =============================================================
console.log('='.repeat(80));
console.log('  ПОЛНЫЙ АУДИТ МОДУЛЕЙ: recipes, production, equipment');
console.log('='.repeat(80));
console.log('');

// Загружаем все route-файлы
const routeFiles = {};
try {
    routeFiles['routes/production.js'] = fs.readFileSync('routes/production.js', 'utf8');
} catch(e) {}
try {
    routeFiles['routes/inventory.js'] = fs.readFileSync('routes/inventory.js', 'utf8');
} catch(e) {}

const allRoutes = [];
for (const [file, content] of Object.entries(routeFiles)) {
    findRouteHandlers(content).forEach(r => allRoutes.push({ ...r, file }));
}

for (const mod of MODULES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  📦 Модуль: ${mod.name.toUpperCase()}`);
    console.log(`${'─'.repeat(60)}`);

    let jsContent, ejsContent;
    try { jsContent = fs.readFileSync(mod.js, 'utf8'); } catch (e) { log('ERROR', mod.name, `JS файл не найден: ${mod.js}`); continue; }
    try { ejsContent = fs.readFileSync(mod.ejs, 'utf8'); } catch (e) { log('ERROR', mod.name, `EJS файл не найден: ${mod.ejs}`); continue; }

    // --- ПРОВЕРКА 1: onclick/onchange → функция существует ---
    console.log('\n  📋 Проверка 1: onclick/onchange → функция существует');
    
    const ejsHandlers = findHandlerCalls(ejsContent, `${mod.name}.ejs`);
    const jsHandlers = findDynamicHandlerCalls(jsContent, `${mod.name}.js`);
    const allHandlers = [...ejsHandlers, ...jsHandlers];
    
    const { defs, windowExports } = findDefinedFunctions(jsContent);
    
    const checkedFuncs = new Set();
    let check1Issues = 0;
    for (const h of allHandlers) {
        const key = h.func;
        if (checkedFuncs.has(key)) continue;
        checkedFuncs.add(key);
        
        // Пропускаем встроенные
        if (['UI', 'API', 'document', 'this', 'event', 'console', 'window', 'toggleSection'].includes(key)) continue;
        
        const isDefined = defs.has(key) || windowExports.has(key);
        const isExported = windowExports.has(key);
        
        if (!isDefined) {
            log('ERROR', mod.name, `Функция "${key}" вызывается из обработчика (${h.source}:${h.line}), но НЕ ОПРЕДЕЛЕНА нигде в файле!`);
            check1Issues++;
        } else if (!isExported) {
            // Проверяем, внутри ли IIFE
            const isIIFE = jsContent.includes('(function()') || jsContent.includes(';(function()');
            if (isIIFE) {
                log('ERROR', mod.name, `Функция "${key}" определена, но НЕ экспортирована в window (внутри IIFE). onclick не сработает!`);
                check1Issues++;
            }
        }
    }
    if (check1Issues === 0) console.log('    ✅ Все обработчики ссылаются на существующие функции');

    // --- ПРОВЕРКА 2: getElementById → элемент в EJS ---
    console.log('\n  📋 Проверка 2: getElementById → элемент существует в EJS');
    
    const jsIds = findGetElementByIdCalls(jsContent);
    const ejsIds = findIdsInEjs(ejsContent);
    
    // Добавляем ID, которые создаются динамически в JS
    const dynamicIdRe = /id\s*=\s*["'`]([^"'`$]+)["'`]/g;
    let dm;
    while ((dm = dynamicIdRe.exec(jsContent)) !== null) ejsIds.add(dm[1]);
    
    let check2Issues = 0;
    const missingIds = new Set();
    for (const entry of jsIds) {
        // Пропускаем динамические ID (содержат переменные)
        if (entry.id.includes('${') || entry.id.includes('+')) continue;
        
        if (!ejsIds.has(entry.id)) {
            if (!missingIds.has(entry.id)) {
                // Проверяем, не создается ли этот элемент динамически в JS
                const createdDynamically = jsContent.includes(`id="${entry.id}"`) || jsContent.includes(`id='${entry.id}'`) || jsContent.includes(`id=\\"${entry.id}\\"`);
                if (!createdDynamically) {
                    log('WARNING', mod.name, `getElementById("${entry.id}") вызывается на строке ${entry.line}, но элемент не найден в EJS`);
                    check2Issues++;
                    missingIds.add(entry.id);
                }
            }
        }
    }
    if (check2Issues === 0) console.log('    ✅ Все getElementById ссылаются на существующие элементы');

    // --- ПРОВЕРКА 3: Дублирование атрибутов class ---
    console.log('\n  📋 Проверка 3: Дублирование атрибутов class в HTML');
    
    const ejsDupClasses = findDuplicateClassAttrs(ejsContent, `${mod.name}.ejs`);
    const jsDupClasses = findDuplicateClassAttrs(jsContent, `${mod.name}.js`);
    const allDupClasses = [...ejsDupClasses, ...jsDupClasses];
    
    if (allDupClasses.length > 0) {
        allDupClasses.forEach(d => {
            log('WARNING', mod.name, `Дублированный class в ${d.source}:${d.line}: ${d.tag}...`);
        });
    } else {
        console.log('    ✅ Нет дублирующихся атрибутов class');
    }

    // --- ПРОВЕРКА 4: API-вызовы → маршруты существуют ---
    console.log('\n  📋 Проверка 4: API-вызовы → маршруты на бэкенде');
    
    const apiCalls = findApiCalls(jsContent);
    let check4Issues = 0;
    for (const call of apiCalls) {
        // Нормализуем URL (убираем параметры после ?)
        let baseUrl = call.url.split('?')[0];
        // Убираем динамические части вроде ${productId}
        baseUrl = baseUrl.replace(/\$\{[^}]+\}/g, ':param');
        
        // Ищем подходящий маршрут
        const matchingRoute = allRoutes.find(r => {
            let routePattern = r.url.replace(/:[\w]+/g, ':param');
            return routePattern === baseUrl;
        });
        
        if (!matchingRoute && !baseUrl.includes(':param')) {
            // Попробуем с параметром на конце
            const withParam = baseUrl.replace(/\/\d+$/, '/:param');
            const matchingRoute2 = allRoutes.find(r => r.url.replace(/:[\w]+/g, ':param') === withParam);
            if (!matchingRoute2) {
                log('WARNING', mod.name, `API вызов ${call.method} ${call.url} (строка ${call.line}) — маршрут не найден в route-файлах`);
                check4Issues++;
            }
        }
    }
    if (check4Issues === 0) console.log('    ✅ Все API-вызовы имеют соответствующие маршруты');

    // --- ПРОВЕРКА 5: try без catch ---
    console.log('\n  📋 Проверка 5: Обработка ошибок (try/catch)');
    
    const tryCount = (jsContent.match(/\btry\s*\{/g) || []).length;
    const catchCount = (jsContent.match(/\bcatch\s*\(/g) || []).length;
    
    if (tryCount !== catchCount) {
        log('WARNING', mod.name, `Несовпадение try(${tryCount}) и catch(${catchCount}) — возможны необработанные ошибки`);
    } else {
        console.log(`    ✅ try/catch сбалансированы (${tryCount}/${catchCount})`);
    }

    // --- ПРОВЕРКА 6: Синтаксис JS ---
    console.log('\n  📋 Проверка 6: Синтаксис JS');
    
    const { execSync } = require('child_process');
    try {
        execSync(`node -c "${mod.js}"`, { stdio: 'pipe' });
        console.log('    ✅ Синтаксис корректен');
    } catch (e) {
        log('ERROR', mod.name, `Синтаксическая ошибка в ${mod.js}: ${e.stderr?.toString()}`);
    }
}

// =============================================================
// ИТОГИ
// =============================================================
console.log(`\n${'='.repeat(80)}`);
console.log('  📊 ИТОГИ АУДИТА');
console.log('='.repeat(80));
console.log(`\n  Всего ошибок (ERROR):      ${totalErrors}`);
console.log(`  Всего предупреждений (WARNING): ${totalWarnings}`);
console.log('');

if (totalErrors > 0) {
    console.log('  🔴 КРИТИЧЕСКИЕ ОШИБКИ:');
    results.filter(r => r.level === 'ERROR').forEach(r => {
        console.log(`    [${r.module}] ${r.message}`);
    });
}

if (totalWarnings > 0) {
    console.log('\n  🟡 ПРЕДУПРЕЖДЕНИЯ:');
    results.filter(r => r.level === 'WARNING').forEach(r => {
        console.log(`    [${r.module}] ${r.message}`);
    });
}

if (totalErrors === 0 && totalWarnings === 0) {
    console.log('  🟢 Все проверки пройдены успешно!');
}

console.log('');
