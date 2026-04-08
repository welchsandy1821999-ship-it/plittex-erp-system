const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');

const regex = /catch \(e\) \{ console\.error\("Ошибка загрузки данных рецептов:", e\); \}/;
if (regex.test(C)) {
    C = C.replace(regex, `catch (e) { console.error("Ошибка загрузки данных рецептов:", e); }
    window.switchRecipeMode('BOM'); // Инициализация интерфейса при загрузке`);
    fs.writeFileSync('public/js/recipes.js', C);
    console.log('Added initialization');
} else {
    console.log('Regex not matched');
}
