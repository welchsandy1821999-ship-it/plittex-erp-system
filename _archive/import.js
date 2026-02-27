const { Pool } = require('pg');

// Подключаемся к нашей базе
const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

// Массив с твоими товарами (я перенес сюда часть прайса)
const products = [
    { name: 'Плитка ПРЯМОУГОЛЬНИК 2.П.4 (Серая)', type: 'product', unit: 'кв.м', price: 790.00 },
    { name: 'Плитка ПРЯМОУГОЛЬНИК 2.П.4 (Красная/Коричневая/Черная)', type: 'product', unit: 'кв.м', price: 900.00 },
    { name: 'Плитка ПРЯМОУГОЛЬНИК 2.П.6 (Серая)', type: 'product', unit: 'кв.м', price: 950.00 },
    { name: 'Плитка ПРЯМОУГОЛЬНИК 2.П.4 ГРАНИТ (Серая)', type: 'product', unit: 'кв.м', price: 1100.00 },
    { name: 'Плитка КВАДРАТ 2.К.4 (Белая)', type: 'product', unit: 'кв.м', price: 900.00 },
    { name: 'Поребрик газонный гладкий 1000x200x80 (Серый)', type: 'product', unit: 'шт', price: 310.00 },
    { name: 'Поребрик газонный гладкий 1000x200x80 (Красный/Желтый)', type: 'product', unit: 'шт', price: 430.00 },
    { name: 'Блок стеновой 200x200x400', type: 'product', unit: 'шт', price: 45.00 },
    { name: 'Полублок 120x200x60', type: 'product', unit: 'шт', price: 40.00 }
];

// Функция автоматической загрузки
async function importData() {
    console.log('Начинаем загрузку прайс-листа в базу...');
    
    // Цикл пробегается по каждому товару из списка выше
    for (let item of products) {
        try {
            // Отправляем SQL-запрос INSERT для каждой позиции
            await pool.query(
                'INSERT INTO items (name, item_type, unit, current_price) VALUES ($1, $2, $3, $4)',
                [item.name, item.type, item.unit, item.price]
            );
            console.log(`Успешно добавлено: ${item.name}`);
        } catch (err) {
            console.error(`Ошибка при добавлении ${item.name}:`, err.message);
        }
    }
    
    console.log('✅ Загрузка завершена!');
    pool.end(); // Закрываем соединение с базой
}

// Запускаем функцию
importData();