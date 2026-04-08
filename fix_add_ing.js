const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');

// Normalize line endings
C = C.replace(/\r\n/g, '\n');

const targetStr = `window.addIngredientToRecipe = function () {
    const matSelect = document.getElementById('recipe-material-select');
    const qtyInput = document.getElementById('recipe-material-qty');
    const qty = parseFloat(qtyInput.value);

    if (matSelect.selectedIndex <= 0 || !qty || qty <= 0) {
        return UI.toast("Выберите материал и укажите количество больше нуля!", "warning");
    }

    const opt = matSelect.options[matSelect.selectedIndex];
    const materialId = parseInt(matSelect.value);

    // Проверяем, нет ли уже этого материала в рецепте
    const existingIndex = currentRecipeData.findIndex(i => i.materialId === materialId);
    if (existingIndex !== -1) {
        // Если есть, просто прибавляем количество
        currentRecipeData[existingIndex].qty += qty;
        UI.toast(\`Количество для "\${opt.getAttribute('data-name')}" увеличено\`, 'info'); // Можно добавить легкий фидбек
    } else {
        // Если нет, добавляем новую строку
        currentRecipeData.push({
            materialId: materialId,
            name: opt.getAttribute('data-name'),
            qty: qty,
            unit: opt.getAttribute('data-unit'),
            price: parseFloat(opt.getAttribute('data-price')) || 0
        });
    }

    // Очищаем поле ввода для следующего компонента
    qtyInput.value = '';
    renderRecipeTable();
};`;

const newStr = `window.addIngredientToRecipe = function () {
    const matSelect = document.getElementById('recipe-material-select');
    const qtyInput = document.getElementById('recipe-material-qty');
    const qty = parseFloat(qtyInput.value);
    
    // Безопасное получение ID из TomSelect или обычного select
    const tsM = matSelect.tomselect;
    const rawVal = tsM ? tsM.getValue() : matSelect.value;
    const materialId = parseInt(rawVal);

    if (!materialId || isNaN(materialId) || !qty || qty <= 0) {
        return UI.toast("Выберите материал и укажите количество больше нуля!", "warning");
    }

    // Ищем материал в закэшированном списке
    const materialObj = window.allMaterialsList ? window.allMaterialsList.find(m => m.id === materialId) : null;
    const matName = materialObj ? materialObj.name : (tsM && tsM.options[rawVal] ? tsM.options[rawVal].text : 'Неизвестно');
    const matUnit = materialObj ? (materialObj.unit || 'кг') : 'шт';
    const matPrice = materialObj ? (parseFloat(materialObj.current_price) || 0) : 0;

    const existingIndex = currentRecipeData.findIndex(i => parseInt(i.materialId) === materialId);
    if (existingIndex !== -1) {
        currentRecipeData[existingIndex].qty += qty;
        UI.toast(\`Количество для "\${matName}" увеличено\`, 'info');
    } else {
        currentRecipeData.push({
            materialId: materialId,
            name: matName,
            qty: qty,
            unit: matUnit,
            price: matPrice
        });
    }

    qtyInput.value = '';
    if (tsM) tsM.clear(true);
    renderRecipeTable();
};`;

if (!C.includes('window.addIngredientToRecipe = function () {')) {
    console.log("Could not find start");
    process.exit(1);
}

if (!C.includes(targetStr)) {
    console.log("target string not found exactly");
    process.exit(1);
}

C = C.split(targetStr).join(newStr);
// Add \r\n back? Not strictly necessary for JS, but we can do it
fs.writeFileSync('public/js/recipes.js', C);
console.log("Patched successfully");
