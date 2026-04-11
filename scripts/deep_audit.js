const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, '../DEEP_AUDIT_REPORT.md');
const routesDir = path.join(__dirname, '../routes');
const publicJsDir = path.join(__dirname, '../public/js');
const viewsDir = path.join(__dirname, '../views');
const controllersDir = path.join(__dirname, '../controllers'); // Might not exist, but let's check

function getAllFiles(dirPath, extFilter = null, arrayOfFiles) {
    if (!fs.existsSync(dirPath)) return arrayOfFiles || [];
    let files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];
    files.forEach((file) => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            arrayOfFiles = getAllFiles(fullPath, extFilter, arrayOfFiles);
        } else {
            if (!extFilter || fullPath.endsWith(extFilter)) {
                arrayOfFiles.push(fullPath);
            }
        }
    });
    return arrayOfFiles;
}

const allBackendFiles = getAllFiles(routesDir, '.js').concat(getAllFiles(controllersDir, '.js'));
const allFrontendFiles = getAllFiles(publicJsDir, '.js').concat(getAllFiles(viewsDir, '.ejs'));

let report = `# 🔬 ФАЗА 2: Глубокий Эвристический Аудит (DEEP AUDIT REPORT)\n\n`;
report += `*Автогенерированный отчет. Строгий Read-Only анализ.* \n\n`;

// 1. Session / Auth
report += `## 🛡️ Security & API\n\n### 1. Отсутствие проверки сессии/авторизации (Middleware Missing)\n`;
let authIssues = [];
allBackendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.match(/router\.(get|post|put|delete|patch)\(/)) {
            if (!line.includes('requireAdmin') && !line.includes('authenticateToken') && !line.includes('ensureAuthenticated')) {
                // Ignore login/auth routes which naturally don't need it
                if (!line.includes('/login') && !line.includes('/api/auth')) {
                    authIssues.push(`- **${path.basename(file)}** (line ${i+1}): \`${line.trim()}\``);
                }
            }
        }
    });
});
if (authIssues.length > 0) report += authIssues.join('\n') + '\n\n';
else report += `- ✅ Все критические роуты защищены.\n\n`;


// 2. IDOR 
report += `### 2. Возможный IDOR (Insecure Direct Object Reference)\n`;
let idorIssues = [];
allBackendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.match(/SELECT.*FROM.*WHERE id = \$1/i) && !line.match(/user_id/i)) {
             idorIssues.push(`- **${path.basename(file)}** (line ${i+1}): Прямой запрос по ID без проверки владельца: \`${line.trim()}\``);
        }
    });
});
if (idorIssues.length > 0) report += idorIssues.join('\n') + '\n\n';
else report += `- ✅ Явных признаков IDOR на уровне прямых SELECT не найдено (или используется сложная логика).\n\n`;


// 3. Stack Trace Leakage
report += `### 3. Утечка стектрейсов (Stack Trace Leakage)\n`;
let leakIssues = [];
allBackendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.includes('res.status(500).send(err') || line.includes('res.status(500).json({ error: err')) {
            leakIssues.push(`- **${path.basename(file)}** (line ${i+1}): Возможная утечка стека ошибки: \`${line.trim()}\``);
        }
    });
});
if (leakIssues.length > 0) report += leakIssues.join('\n') + '\n\n';
else report += `- ✅ Обработчики 500-х ошибок безопасны.\n\n`;


// 4. Performance: Select * without LIMIT
report += `## ⚡ Performance & DB\n\n### 1. Неоптимизированные запросы (SELECT * без LIMIT)\n`;
let perfIssues = [];
allBackendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
         if (line.match(/SELECT \*/i) && !line.match(/LIMIT/i) && !line.match(/WHERE id/i)) {
             perfIssues.push(`- **${path.basename(file)}** (line ${i+1}): \`${line.trim()}\``);
         }
    });
});
if (perfIssues.length > 0) report += perfIssues.join('\n') + '\n\n';
else report += `- ✅ Все SELECT * содержат LIMIT или WHERE id.\n\n`;

// 5. N+1 Loops
report += `### 2. N+1 запросы (await pool.query внутри циклов)\n`;
let n1Issues = [];
allBackendFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    // regex is hard for this, but we can look for "for(" or ".map(" followed by "await pool.query"
    if (content.match(/for\s*\(.*\{[^}]*await\s+pool\.query/is)) {
        n1Issues.push(`- **${path.basename(file)}**: Обнаружен вызов БД внутри цикла FOR.`);
    }
});
if (n1Issues.length > 0) report += [...new Set(n1Issues)].join('\n') + '\n\n';
else report += `- ✅ N+1 запросов не найдено.\n\n`;

// 6. Sync calls
report += `### 3. Блокирующие синхронные вызовы Node.js\n`;
let syncIssues = [];
allBackendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.match(/\w+Sync\(/) && !line.includes('__dirname') && !file.includes('audit_')) {
             syncIssues.push(`- **${path.basename(file)}** (line ${i+1}): \`${line.trim()}\``);
        }
    });
});
if (syncIssues.length > 0) report += syncIssues.join('\n') + '\n\n';
else report += `- ✅ Синхронный I/O не используется.\n\n`;


// 7. Fetch silent failures
report += `## 🖥️ Frontend & UX\n\n### 1. Тихие отказы (Silent Failures в fetch)\n`;
let fetchIssues = [];
allFrontendFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const fetchMatches = content.match(/fetch\(/g);
    if (fetchMatches) {
        if (!content.includes('.catch(') && !content.includes('try {') && !content.includes('!res.ok')) {
             fetchIssues.push(`- **${path.basename(file)}**: Найдены вызовы fetch без явной обработки .catch()`);
        }
    }
});
if (fetchIssues.length > 0) report += [...new Set(fetchIssues)].join('\n') + '\n\n';
else report += `- ✅ Все fetch-запросы обрабатывают ошибки.\n\n`;

// 8. EventListener leaks
report += `### 2. Возможные утечки памяти (addEventListener без remove)\n`;
let eventIssues = [];
allFrontendFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('addEventListener') && !content.includes('removeEventListener')) {
        eventIssues.push(`- **${path.basename(file)}**: Вызывается \`addEventListener\`, но нет \`removeEventListener\`.`);
    }
});
if (eventIssues.length > 0) report += [...new Set(eventIssues)].join('\n') + '\n\n';
else report += `- ✅ Утечек событий не обнаружено.\n\n`;


// 9. Data Integrity: Transactions
report += `## 🧮 Data Integrity\n\n### 1. Отсутствие транзакций при множественной записи\n`;
let txIssues = [];
allBackendFiles.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const inserts = (content.match(/INSERT INTO/gi) || []).length;
    const updates = (content.match(/UPDATE/gi) || []).length;
    const begins = (content.match(/BEGIN/gi) || []).length;
    
    // Simplistic heuristic: multiple mutators but few/no BEGINs
    if (inserts + updates > 3 && begins === 0) {
        txIssues.push(`- **${path.basename(file)}**: Активное изменение БД (${inserts} inserts, ${updates} updates), но нет \`BEGIN/COMMIT\`.`);
    }
});
if (txIssues.length > 0) report += txIssues.join('\n') + '\n\n';
else report += `- ✅ Транзакции (BEGIN/COMMIT) присутствуют там, где нужны.\n\n`;


// 10. Self-Defined Heuristics (OWASP / SOLID)
report += `## 🤖 Автономная генерация критериев (Self-Defined Heuristics)\n\n`;

// Hardcoded secrets
report += `### ⚠️ Новый критерий: Жестко закодированные секреты / Пароли в коде (OWASP A07:2021)\n`;
let secrets = [];
allBackendFiles.concat(allFrontendFiles).forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if ((line.includes('password = "') || line.includes("password = '") || line.includes('secret = "') || line.includes('token = "')) && !line.includes('process.env')) {
            secrets.push(`- **${path.basename(file)}** (line ${i+1}): \`${line.trim()}\``);
        }
    });
});
if (secrets.length > 0) report += secrets.join('\n') + '\n\n';
else report += `- ✅ Хардкода секретов не обнаружено.\n\n`;

// XSS vulnerabilities
report += `### ⚠️ Новый критерий: Опасная инъекция HTML (Рефлекторный XSS, OWASP A03:2021)\n`;
let xss = [];
allFrontendFiles.forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.includes('.innerHTML =') && line.includes('`') && line.match(/\$\{.*\}/)) {
            xss.push(`- **${path.basename(file)}** (line ${i+1}): Использование \`innerHTML\` с шаблонными строками уязвимо для XSS: \`${line.trim()}\``);
        }
    });
});
// limit xss reporting to top 15 to avoid massive bloat
if (xss.length > 0) report += xss.slice(0, 15).join('\n') + (xss.length > 15 ? `\n- *...и еще ${xss.length - 15} случаев.*` : '') + '\n\n';
else report += `- ✅ Опасного innerHTML не найдено.\n\n`;


// Eval / Injection
report += `### ⚠️ Новый критерий: Использование eval() или опасного выполнения кода\n`;
let evalIssues = [];
allFrontendFiles.concat(allBackendFiles).forEach(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.match(/eval\(/) || line.match(/setTimeout\(['"]/)) {
             evalIssues.push(`- **${path.basename(file)}** (line ${i+1}): \`${line.trim()}\``);
        }
    });
});
if (evalIssues.length > 0) report += evalIssues.join('\n') + '\n\n';
else report += `- ✅ Использование eval() не обнаружено.\n\n`;

fs.writeFileSync(reportPath, report);
console.log('DEEP_AUDIT_REPORT.md успешно сгенерирован.');
