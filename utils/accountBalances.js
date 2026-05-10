/**
 * Shared-утилита: пересчёт денормализованного balance в таблице accounts.
 *
 * balance = SUM(income) − SUM(expense) по не-удалённым транзакциям.
 * Вызывается после любой мутации транзакций (checkout, оплата, удаление и т.д.).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient — pool или client (внутри транзакции)
 * @param {Array<number>} accountIds — массив ID счетов для пересчёта
 */
async function recalcAccountBalances(dbClient, accountIds = []) {
    const unique = Array.from(new Set(
        (accountIds || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
    ));
    if (!unique.length) return;
    await dbClient.query(
        `
        UPDATE accounts a
        SET balance = ROUND(COALESCE((
            SELECT SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) -
                   SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END)
            FROM transactions t
            WHERE t.account_id = a.id
              AND COALESCE(t.is_deleted, false) = false
        ), 0), 2)
        WHERE a.id = ANY($1::int[])
        `,
        [unique]
    );
}

module.exports = { recalcAccountBalances };
