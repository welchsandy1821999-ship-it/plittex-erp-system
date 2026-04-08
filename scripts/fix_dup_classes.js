/**
 * Скрипт исправления дублирующихся атрибутов class в HTML
 * Объединяет два class="..." в один
 */
const fs = require('fs');

function fixDuplicateClasses(content) {
    // Паттерн: class="first classes" ... class="second classes"  внутри одного тега
    // Находим теги с 2+ class атрибутами и объединяем
    return content.replace(/<([a-zA-Z][^>]*?)class\s*=\s*"([^"]*)"([^>]*?)class\s*=\s*"([^"]*)"([^>]*?)>/g, 
        (match, before, class1, middle, class2, after) => {
            const combined = `${class1} ${class2}`.replace(/\s+/g, ' ').trim();
            return `<${before}class="${combined}"${middle}${after}>`;
        }
    );
}

const files = [
    'public/js/recipes.js',
    'public/js/production.js',
    'views/modules/production.ejs',
];

for (const file of files) {
    try {
        let content = fs.readFileSync(file, 'utf8');
        const before = (content.match(/class\s*=\s*"/g) || []).length;
        
        // Многопроходная обработка (один тег может иметь 3+ class)
        let prev;
        do {
            prev = content;
            content = fixDuplicateClasses(content);
        } while (content !== prev);
        
        const after = (content.match(/class\s*=\s*"/g) || []).length;
        
        if (before !== after) {
            fs.writeFileSync(file, content);
            console.log(`✅ ${file}: исправлено ${before - after} дублей class`);
        } else {
            console.log(`ℹ️ ${file}: дубли не найдены этим паттерном`);
        }
    } catch (e) {
        console.log(`❌ ${file}: ${e.message}`);
    }
}
