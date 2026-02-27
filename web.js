const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = 3000;

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL',
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

app.use(express.static('public'));
app.use(express.json()); 

// 1. Отдаем остатки склада
app.get('/api/inventory', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT items.name, items.unit, SUM(inventory_movements.quantity) as total
            FROM inventory_movements
            JOIN items ON inventory_movements.item_id = items.id
            GROUP BY items.name, items.unit
            HAVING SUM(inventory_movements.quantity) != 0
            ORDER BY items.name;
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('Ошибка сервера');
    }
});

// 2. Отдаем список готовой продукции
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name FROM items WHERE item_type = 'product' ORDER BY name");
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('Ошибка сервера');
    }
});

// === ФУНКЦИЯ АВТОРИЗАЦИИ (LOGIN) ===
app.post('/api/login', async (req, res) => {
    // Получаем логин и пароль из формы на сайте
    const { username, password } = req.body;

    try {
        // Ищем такого пользователя в базе
        const userRes = await pool.query(
            "SELECT id, username, role, full_name FROM users WHERE username = $1 AND password = $2",
            [username, password]
        );

        // Если база вернула 0 строк — значит логин или пароль неверные
        if (userRes.rows.length === 0) {
            return res.status(401).send('Неверный логин или пароль!');
        }

        // Если всё отлично, отправляем браузеру данные пользователя (и его роль)
        const user = userRes.rows[0];
        res.json({
            success: true,
            user: user
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// 3. УМНОЕ ПРОИЗВОДСТВО ПО РЕЦЕПТУРЕ
app.post('/api/produce', async (req, res) => {
    const { tileId, quantity } = req.body; 

    if (!tileId || quantity <= 0) {
        return res.status(400).send('Некорректные данные');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Шаг А: Ищем рецепт для выбранной плитки
        const recipeRes = await client.query(
            `SELECT material_id, quantity_per_unit 
             FROM recipes 
             WHERE product_id = $1`,
            [tileId]
        );

        const ingredients = recipeRes.rows;

        // Если рецепта нет — останавливаем производство!
        if (ingredients.length === 0) {
            throw new Error('Для этой продукции не задана рецептура в базе!');
        }

        // Шаг Б: В цикле списываем каждое сырье по рецепту
        for (let ingredient of ingredients) {
            // Умножаем норму на количество квадратов
            const totalNeeded = (ingredient.quantity_per_unit * quantity).toFixed(4);
            
            await client.query(
                `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) 
                 VALUES ($1, $2, $3, $4)`,
                [
                    ingredient.material_id, 
                    -totalNeeded, // Обязательно с минусом!
                    'production_expense', 
                    `Списание по рецепту на партию ${quantity} ед. (Продукт ID: ${tileId})`
                ]
            );
        }

        // Шаг В: Приходуем саму готовую плитку
        await client.query(
            `INSERT INTO inventory_movements (item_id, quantity, movement_type, description) 
             VALUES ($1, $2, $3, $4)`,
            [tileId, quantity, 'production_receipt', 'Выпуск с веб-интерфейса']
        );

        await client.query('COMMIT');
        res.send('Успех');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка производства:', err.message);
        // Отправляем текст ошибки в браузер, чтобы пользователь понял, в чем дело
        res.status(500).send(err.message || 'Внутренняя ошибка');
    } finally {
        client.release();
    }
});

app.listen(port, () => console.log(`🚀 Умный сервер запущен: http://localhost:${port}`));