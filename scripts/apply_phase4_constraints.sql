BEGIN;

-- accounts.account_role NOT NULL
ALTER TABLE accounts
    ALTER COLUMN account_role SET NOT NULL;

-- CHECK: imprest accounts require employee_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_imprest_requires_employee'
    ) THEN
        ALTER TABLE accounts
            ADD CONSTRAINT chk_accounts_imprest_requires_employee
            CHECK (
                (account_role <> 'imprest' AND type <> 'imprest')
                OR employee_id IS NOT NULL
            );
    END IF;
END $$;

-- FK: accounts.employee_id -> employees.id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_accounts_employee'
    ) THEN
        ALTER TABLE accounts
            ADD CONSTRAINT fk_accounts_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_imprest_employee_active
ON accounts(employee_id)
WHERE account_role = 'imprest'
  AND employee_id IS NOT NULL;

-- counterparties constraints
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_counterparties_employee_requires_employee_id'
    ) THEN
        ALTER TABLE counterparties
            ADD CONSTRAINT chk_counterparties_employee_requires_employee_id
            CHECK (is_employee = false OR employee_id IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_counterparties_employee'
    ) THEN
        ALTER TABLE counterparties
            ADD CONSTRAINT fk_counterparties_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_counterparties_employee_active
ON counterparties(employee_id)
WHERE is_employee = true
  AND employee_id IS NOT NULL
  AND COALESCE(is_deleted, false) = false;

-- salary_adjustments mandatory/defaultable fields
ALTER TABLE salary_adjustments
    ALTER COLUMN source_module SET NOT NULL;

ALTER TABLE salary_adjustments
    ALTER COLUMN cash_posting_mode SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_salary_adjustments_cash_posting_mode'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT chk_salary_adjustments_cash_posting_mode
            CHECK (cash_posting_mode IN ('none', 'cash', 'bank', 'imprest'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_salary_adjustments_cash_account_required'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT chk_salary_adjustments_cash_account_required
            CHECK (
                (cash_posting_mode = 'none' AND cash_account_id IS NULL)
                OR (cash_posting_mode <> 'none' AND cash_account_id IS NOT NULL)
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_salary_adjustments_employee'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT fk_salary_adjustments_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_salary_adjustments_counterparty'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT fk_salary_adjustments_counterparty
            FOREIGN KEY (counterparty_id) REFERENCES counterparties(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_salary_adjustments_linked_transaction'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT fk_salary_adjustments_linked_transaction
            FOREIGN KEY (linked_transaction_id) REFERENCES transactions(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_salary_adjustments_cash_account'
    ) THEN
        ALTER TABLE salary_adjustments
            ADD CONSTRAINT fk_salary_adjustments_cash_account
            FOREIGN KEY (cash_account_id) REFERENCES accounts(id);
    END IF;
END $$;

-- transactions FK + CHECK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_employee'
    ) THEN
        ALTER TABLE transactions
            ADD CONSTRAINT fk_transactions_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_salary_adjustment'
    ) THEN
        ALTER TABLE transactions
            ADD CONSTRAINT fk_transactions_salary_adjustment
            FOREIGN KEY (salary_adjustment_id) REFERENCES salary_adjustments(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_system_type'
    ) THEN
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
                    'imprest_settlement_bridge'
                )
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_salary_requires_employee'
    ) THEN
        ALTER TABLE transactions
            ADD CONSTRAINT chk_transactions_salary_requires_employee
            CHECK (
                (source_module <> 'salary' AND COALESCE(system_type, '') NOT LIKE 'salary%')
                OR employee_id IS NOT NULL
            );
    END IF;
END $$;

COMMIT;
