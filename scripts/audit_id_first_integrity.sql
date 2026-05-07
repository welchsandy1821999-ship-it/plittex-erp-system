-- Read-only integrity audit for ID-first employee finance architecture
-- No writes, only SELECT statements.

WITH
imprest_accounts AS (
    SELECT a.id, a.employee_id
    FROM accounts a
    WHERE (a.account_role = 'imprest' OR a.type = 'imprest')
),
salary_tx AS (
    SELECT t.id, t.employee_id, t.account_id, t.salary_adjustment_id, t.counterparty_id, t.system_type
    FROM transactions t
    WHERE COALESCE(t.is_deleted, false) = false
      AND (
          t.source_module = 'salary'
          OR t.system_type IN (
              'salary_payment',
              'salary_imprest_deduction',
              'salary_accrual',
              'salary_tax_withhold',
              'salary_period_adjustment',
              'salary_adjustment_cash_out',
              'salary_adjustment_cash_in'
          )
      )
),
bridge_scope AS (
    SELECT sa.id, sa.linked_transaction_id, sa.cash_posting_mode
    FROM salary_adjustments sa
    WHERE COALESCE(sa.is_deleted, false) = false
      AND COALESCE(sa.cash_posting_mode, 'none') <> 'none'
)
SELECT
    'null_rate.imprest_accounts_employee_id_null' AS metric,
    COUNT(*) FILTER (WHERE ia.employee_id IS NULL)::bigint AS bad_rows,
    COUNT(*)::bigint AS total_rows,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE ia.employee_id IS NULL) / COUNT(*), 2)
    END AS percent
FROM imprest_accounts ia

UNION ALL
SELECT
    'null_rate.salary_transactions_employee_id_null' AS metric,
    COUNT(*) FILTER (WHERE st.employee_id IS NULL)::bigint AS bad_rows,
    COUNT(*)::bigint AS total_rows,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE st.employee_id IS NULL) / COUNT(*), 2)
    END AS percent
FROM salary_tx st

UNION ALL
SELECT
    'orphan.transactions_employee_id_missing_employee' AS metric,
    COUNT(*)::bigint AS bad_rows,
    NULL::bigint AS total_rows,
    NULL::numeric AS percent
FROM transactions t
LEFT JOIN employees e ON e.id = t.employee_id
WHERE t.employee_id IS NOT NULL
  AND e.id IS NULL

UNION ALL
SELECT
    'orphan.transactions_counterparty_id_missing_counterparty' AS metric,
    COUNT(*)::bigint AS bad_rows,
    NULL::bigint AS total_rows,
    NULL::numeric AS percent
FROM transactions t
LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
WHERE t.counterparty_id IS NOT NULL
  AND cp.id IS NULL

UNION ALL
SELECT
    'orphan.salary_adjustments_linked_transaction_missing' AS metric,
    COUNT(*)::bigint AS bad_rows,
    NULL::bigint AS total_rows,
    NULL::numeric AS percent
FROM salary_adjustments sa
LEFT JOIN transactions t ON t.id = sa.linked_transaction_id
WHERE sa.linked_transaction_id IS NOT NULL
  AND t.id IS NULL

UNION ALL
SELECT
    'orphan.transactions_salary_adjustment_missing' AS metric,
    COUNT(*)::bigint AS bad_rows,
    NULL::bigint AS total_rows,
    NULL::numeric AS percent
FROM transactions t
LEFT JOIN salary_adjustments sa ON sa.id = t.salary_adjustment_id
WHERE t.salary_adjustment_id IS NOT NULL
  AND sa.id IS NULL

UNION ALL
SELECT
    'bridge.coverage_salary_adjustments_cash_mode_linked' AS metric,
    COUNT(*) FILTER (WHERE bs.linked_transaction_id IS NOT NULL)::bigint AS bad_rows,
    COUNT(*)::bigint AS total_rows,
    CASE WHEN COUNT(*) = 0 THEN 100
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE bs.linked_transaction_id IS NOT NULL) / COUNT(*), 2)
    END AS percent
FROM bridge_scope bs

ORDER BY metric;
