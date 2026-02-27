const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'Plittex_2026_SQL', 
    host: 'localhost',
    port: 5432,
    database: 'plittex_erp'
});

async function generateFinancialReport() {
    console.log('Сбор финансовой статистики...\n');

    try {
        // Умный SQL-запрос для подсчета баланса
        const report = await pool.query(`
            SELECT 
                payment_method,
                SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) AS total_income,
                SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS total_expense,
                SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) AS current_balance
            FROM transactions
            GROUP BY payment_method;
        `);

        console.log('=== ФИНАНСОВЫЙ ОТЧЕТ ===');
        
        // Красиво выводим результат на экран
        for (let row of report.rows) {
            // Переводим английские названия в понятные
            const methodName = row.payment_method === 'cash' ? 'Наличная касса' : 'Расчетный счет';
            
            console.log(`\nСчет: ${methodName}`);
            console.log(`+ Все доходы:  ${row.total_income || 0} руб.`);
            console.log(`- Все расходы: ${row.total_expense || 0} руб.`);
            console.log(`= ОСТАТОК:     ${row.current_balance || 0} руб.`);
        }
        
        console.log('\n========================');

    } catch (err) {
        console.error('Ошибка при формировании отчета:', err.message);
    } finally {
        pool.end(); 
    }
}

generateFinancialReport();