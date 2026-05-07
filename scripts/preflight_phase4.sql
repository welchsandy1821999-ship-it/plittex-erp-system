-- Pre-flight checks for Phase 4 hard constraints.
-- Read-only. Returns rows where bad_rows > 0.

WITH issues AS (
    -- CHECK blockers
    SELECT 'accounts.imprest_without_employee' AS issue, COUNT(*)::bigint AS bad_rows
    FROM accounts
    WHERE (account_role = 'imprest' OR type = 'imprest')
      AND employee_id IS NULL

    UNION ALL
    SELECT 'counterparties.is_employee_without_employee_id' AS issue, COUNT(*)::bigint AS bad_rows
    FROM counterparties
    WHERE is_employee = true
      AND employee_id IS NULL

    UNION ALL
    SELECT 'salary_adjustments.invalid_cash_posting_mode' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments
    WHERE COALESCE(cash_posting_mode, 'none') NOT IN ('none', 'cash', 'bank', 'imprest')

    UNION ALL
    SELECT 'salary_adjustments.cash_mode_requires_cash_account' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments
    WHERE (
        (COALESCE(cash_posting_mode, 'none') = 'none' AND cash_account_id IS NOT NULL)
        OR (COALESCE(cash_posting_mode, 'none') <> 'none' AND cash_account_id IS NULL)
    )

    UNION ALL
    SELECT 'transactions.invalid_system_type' AS issue, COUNT(*)::bigint AS bad_rows
    FROM transactions
    WHERE system_type IS NOT NULL
      AND system_type NOT IN (
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
        'imprest_settlement_bridge'
      )

    UNION ALL
    SELECT 'transactions.salary_without_employee_id' AS issue, COUNT(*)::bigint AS bad_rows
    FROM transactions
    WHERE (
        source_module = 'salary'
        OR COALESCE(system_type, '') LIKE 'salary%'
    )
      AND employee_id IS NULL

    -- UNIQUE blockers
    UNION ALL
    SELECT 'accounts.duplicate_imprest_employee_id' AS issue, COUNT(*)::bigint AS bad_rows
    FROM (
        SELECT employee_id
        FROM accounts
        WHERE account_role = 'imprest'
          AND employee_id IS NOT NULL
        GROUP BY employee_id
        HAVING COUNT(*) > 1
    ) d

    UNION ALL
    SELECT 'counterparties.duplicate_active_employee_id' AS issue, COUNT(*)::bigint AS bad_rows
    FROM (
        SELECT employee_id
        FROM counterparties
        WHERE is_employee = true
          AND employee_id IS NOT NULL
          AND COALESCE(is_deleted, false) = false
        GROUP BY employee_id
        HAVING COUNT(*) > 1
    ) d

    -- FK blockers
    UNION ALL
    SELECT 'fk.accounts_employee_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM accounts a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.employee_id IS NOT NULL
      AND e.id IS NULL

    UNION ALL
    SELECT 'fk.counterparties_employee_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM counterparties cp
    LEFT JOIN employees e ON e.id = cp.employee_id
    WHERE cp.employee_id IS NOT NULL
      AND e.id IS NULL

    UNION ALL
    SELECT 'fk.salary_adjustments_employee_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments sa
    LEFT JOIN employees e ON e.id = sa.employee_id
    WHERE sa.employee_id IS NOT NULL
      AND e.id IS NULL

    UNION ALL
    SELECT 'fk.salary_adjustments_counterparty_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments sa
    LEFT JOIN counterparties cp ON cp.id = sa.counterparty_id
    WHERE sa.counterparty_id IS NOT NULL
      AND cp.id IS NULL

    UNION ALL
    SELECT 'fk.salary_adjustments_linked_transaction_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments sa
    LEFT JOIN transactions t ON t.id = sa.linked_transaction_id
    WHERE sa.linked_transaction_id IS NOT NULL
      AND t.id IS NULL

    UNION ALL
    SELECT 'fk.salary_adjustments_cash_account_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM salary_adjustments sa
    LEFT JOIN accounts a ON a.id = sa.cash_account_id
    WHERE sa.cash_account_id IS NOT NULL
      AND a.id IS NULL

    UNION ALL
    SELECT 'fk.transactions_employee_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM transactions t
    LEFT JOIN employees e ON e.id = t.employee_id
    WHERE t.employee_id IS NOT NULL
      AND e.id IS NULL

    UNION ALL
    SELECT 'fk.transactions_salary_adjustment_missing' AS issue, COUNT(*)::bigint AS bad_rows
    FROM transactions t
    LEFT JOIN salary_adjustments sa ON sa.id = t.salary_adjustment_id
    WHERE t.salary_adjustment_id IS NOT NULL
      AND sa.id IS NULL
)
SELECT issue, bad_rows
FROM issues
WHERE bad_rows > 0
ORDER BY issue;
