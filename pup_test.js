const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');

(async () => {
    // Создаем свежий JWT токен для admin, чтобы обойти логин (если используется jwtToken в localStorage)
    const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'Plittex_Super_Secret_Key_2026_CHANGE_ME_IN_PRODUCTION', { expiresIn: '1h' });

    const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    // Перехватываем ошибки console
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
    page.on('response', response => {
        if (!response.ok()) console.log('RESPONSE FAILED:', response.url(), response.status());
    });

    await page.goto('http://localhost:3000');
    
    // Внедряем токен в localStorage
    await page.evaluate((t) => {
        localStorage.setItem('token', t);
    }, token);

    // Идем на рецепты
    await page.goto('http://localhost:3000/recipes');
    await new Promise(r => setTimeout(r, 1500));
    
    console.log('--- На странице Рецепты. Пытаемся выбрать продукт ---');
    await page.evaluate(() => {
        const prod = document.getElementById('recipe-product-select');
        if (prod && prod.tomselect) {
            const keys = Object.keys(prod.tomselect.options);
            if (keys.length > 0) prod.tomselect.setValue('433'); // Старый город
        } else if (prod) {
            prod.value = '433';
            prod.dispatchEvent(new Event('change'));
        }
    });

    await new Promise(r => setTimeout(r, 1500));
    
    console.log('--- Добавляем сырье (много песка, чтобы триггернуть варнинг) ---');
    await page.evaluate(() => {
        const mat = document.getElementById('recipe-material-select');
        if (mat) mat.value = '155'; // Песок
        const qty = document.getElementById('recipe-material-qty');
        if (qty) qty.value = '5000'; 
        if (typeof window.addIngredientToRecipe === 'function') window.addIngredientToRecipe();
    });

    await new Promise(r => setTimeout(r, 500));
    
    console.log('--- Сохраняем ---');
    await page.evaluate(() => {
        window.saveRecipe(false);
    });

    await new Promise(r => setTimeout(r, 1000));
    
    console.log('--- Пытаемся нажать Force Сохранить ---');
    await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        let clicked = false;
        btns.forEach(b => {
             if (b.innerText.includes('Да, Сохранить принудительно') || b.getAttribute('onclick') === 'saveRecipe(true)') {
                 b.click();
                 clicked = true;
             }
        });
        if (!clicked) console.log('Кнопка Force Save не найдена в DOM!');
    });

    await new Promise(r => setTimeout(r, 1000));
    
    console.log('--- Тест Массового Применения ---');
    await page.evaluate(() => {
        if (typeof window.showRecipeMassApplyModal === 'function') {
             window.showRecipeMassApplyModal();
        }
    });

    await new Promise(r => setTimeout(r, 1000));
    
    await page.evaluate(() => {
        if (typeof window.executeMassApply === 'function') {
             window.executeMassApply();
        }
    });

    await new Promise(r => setTimeout(r, 1000));

    await browser.close();
})();
