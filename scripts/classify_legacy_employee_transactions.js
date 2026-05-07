#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');

function dbConfigFromEnv() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  };
}

async function main() {
  const pool = new Pool(dbConfigFromEnv());
  const client = await pool.connect();

  try {
    console.log('== Legacy employee transaction classification start ==');
    console.log(`DB: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT}`);

    await client.query('BEGIN');

    // Расширяем жесткий whitelist system_type (Phase 4), чтобы разрешить legacy-классы
    await client.query(`
      ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS chk_transactions_system_type
    `);
    await client.query(`
      ALTER TABLE transactions
      ADD CONSTRAINT chk_transactions_system_type
      CHECK (
        system_type IS NULL OR system_type IN (
          'salary_payment',
          'salary_imprest_deduction',
          'salary_accrual',
          'salary_tax_withhold',
          'salary_period_adjustment',
          'salary_adjustment_cash_out',
          'salary_adjustment_cash_in',
          'imprest_instant_transit_out',
          'imprest_instant_transit_in',
          'imprest_instant_expense',
          'imprest_issue_out',
          'imprest_issue_in',
          'imprest_return_out',
          'imprest_return_in',
          'imprest_settlement_bridge',
          'imprest_legacy_expense',
          'salary_legacy_action'
        )
      )
    `);

    // 1) Корпоративные подотчетные траты -> imprest_legacy_expense
    const corporateRes = await client.query(`
      WITH employee_related AS (
        SELECT t.id
        FROM transactions t
        LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.source_module = 'manual'
          AND t.system_type IS NULL
          AND (
            t.employee_id IS NOT NULL
            OR (cp.is_employee = true AND cp.employee_id IS NOT NULL)
          )
          AND (
            COALESCE(t.category, '') IN (
              'Траты офис',
              'Хоз. нужды',
              'Хоз.нужды',
              'Закупка сырья',
              'Бумага',
              'Вода',
              'Журнал'
            )
            OR COALESCE(t.description, '') ~* '(траты офис|хоз\\.?\\s*нужды|закупка сырья|бумаг|вода|журнал)'
          )
      )
      UPDATE transactions t
      SET system_type = 'imprest_legacy_expense'
      FROM employee_related e
      WHERE t.id = e.id
    `);

    // 2) Личные расчеты сотрудника -> salary_legacy_action + backfill employee_id
    const salaryRes = await client.query(`
      WITH employee_related AS (
        SELECT t.id, cp.employee_id AS cp_employee_id
        FROM transactions t
        LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
        WHERE COALESCE(t.is_deleted, false) = false
          AND t.source_module = 'manual'
          AND t.system_type IS NULL
          AND (
            t.employee_id IS NOT NULL
            OR (cp.is_employee = true AND cp.employee_id IS NOT NULL)
          )
          AND (
            COALESCE(t.category, '') IN (
              'Возврат заемных средств',
              'Выплата сотруднику',
              'Начисление ЗП',
              'Зарплата',
              'Оплата труда',
              'Зарплата и Авансы',
              'Премии',
              'Штрафы',
              'Удержание из ЗП'
            )
            OR COALESCE(t.description, '') ~* '(выплата сотруднику|начислен[ао]\\s+за\\s+период|начисление\\s+зп|возврат\\s+заем|положил[аи]\\s+на\\s+карту|займ)'
          )
      )
      UPDATE transactions t
      SET system_type = 'salary_legacy_action',
          employee_id = COALESCE(t.employee_id, e.cp_employee_id)
      FROM employee_related e
      WHERE t.id = e.id
    `);

    await client.query('COMMIT');

    const postCheck = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE system_type = 'imprest_legacy_expense')::int AS imprest_legacy_expense_total,
        COUNT(*) FILTER (WHERE system_type = 'salary_legacy_action')::int AS salary_legacy_action_total
      FROM transactions
      WHERE COALESCE(is_deleted, false) = false
    `);

    console.log(`[classification] updated to imprest_legacy_expense: ${corporateRes.rowCount}`);
    console.log(`[classification] updated to salary_legacy_action: ${salaryRes.rowCount}`);
    console.log('[postcheck totals]', postCheck.rows[0]);
    console.log('== Legacy employee transaction classification done ==');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      console.error('[tx] rolled back');
    } catch (rbErr) {
      console.error('[tx] rollback failed:', rbErr.message);
    }
    console.error('[classification] failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
