const fs = require('fs');
let C = fs.readFileSync('public/js/recipes.js', 'utf8');

C = C.replace(/} catch \(e\) \{\s+\}\s+};\s+\/\/ 2\. ОТПРАВКА НА СЕРВЕР/g, `} catch (e) {
        console.error(e);
        UI.toast(e.message || 'Ошибка', 'error');
    }
};

// 2. ОТПРАВКА НА СЕРВЕР`);

fs.writeFileSync('public/js/recipes.js', C);
