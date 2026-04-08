const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');

const replacement = `catch (e) {
        if (e.body && e.body.warning) {
            const html = \`<div class="p-10 font-15">\${e.body.warning.replace(/\\n/g, '<br>')}</div>\`;
            const buttons = \`
                <button class="btn btn-outline" onclick="UI.closeModal()">Отмена</button>
                <button class="btn btn-blue" style="background: var(--danger); border-color: var(--danger);" 
                        onclick="executeSaveRecipe(\${productId}, '\${productName}', true)">🗑️ Да, Сохранить принудительно</button>
            \`;
            return UI.showModal('⚠️ Внимание: Отклонение норм', html, buttons);
        } else {
            console.error(e);
            UI.toast(e.message || 'Ошибка', 'error');
        }
    }`;

C = C.replace(/catch \(e\) \{ console\.error\(e\); \}/g, replacement);

fs.writeFileSync('public/js/recipes.js', C);
console.log('Fixed recipes error handling');
