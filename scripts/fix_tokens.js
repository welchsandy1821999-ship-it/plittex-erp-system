const fs = require('fs');

const files = [
    'c:\\Users\\Пользователь\\Desktop\\plittex-erp\\public\\js\\sales.js',
    'c:\\Users\\Пользователь\\Desktop\\plittex-erp\\public\\js\\finance.js',
    'c:\\Users\\Пользователь\\Desktop\\plittex-erp\\public\\js\\production.js'
];

files.forEach(file => {
    if (!fs.existsSync(file)) return;
    let content = fs.readFileSync(file, 'utf8');

    // 1. Замена вызовов с обратными кавычками ` (шаблонные строки)
    // Ищем: window.open(`/api/...` или `/print/...` или `/files/...`
    // window.open(`/print/act?cpId=${cpId}`, '_blank')
    content = content.replace(/window\.open\(`(\/[^`]+)`\s*,\s*'_blank'\)/g, (match, url) => {
        const joiner = url.includes('?') ? '&' : '?';
        return `window.open(\`${url}${joiner}token=\${localStorage.getItem('token')}\`, '_blank')`;
    });

    // 2. Замена вызовов с обычными кавычками ' внутри HTML-строк 
    // Пример: onclick="window.open('/print/upd?docNum=${h.doc_num}', '_blank')"
    content = content.replace(/window\.open\('(\/[^']+)'\s*,\s*'_blank'\)/g, (match, url) => {
        const joiner = url.includes('?') ? '&' : '?';
        // Добавляем конкатенацию: onclick="window.open('/print/upd?docNum=${h.doc_num}&token=' + localStorage.getItem('token'), '_blank')"
        return `window.open('${url}${joiner}token=' + localStorage.getItem('token'), '_blank')`;
    });

    fs.writeFileSync(file, content);
    console.log('Fixed', file);
});
