BEGIN;

ALTER TABLE salary_adjustments
    ADD COLUMN IF NOT EXISTS counterparty_id BIGINT,
    ADD COLUMN IF NOT EXISTS linked_transaction_id BIGINT,
    ADD COLUMN IF NOT EXISTS cash_posting_mode VARCHAR(20) DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS cash_account_id BIGINT,
    ADD COLUMN IF NOT EXISTS operation_kind VARCHAR(32),
    ADD COLUMN IF NOT EXISTS source_module VARCHAR(32) DEFAULT 'salary';

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS employee_id BIGINT,
    ADD COLUMN IF NOT EXISTS salary_adjustment_id BIGINT,
    ADD COLUMN IF NOT EXISTS system_type VARCHAR(32),
    ADD COLUMN IF NOT EXISTS generation_batch_id UUID;

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS employee_id BIGINT,
    ADD COLUMN IF NOT EXISTS account_role VARCHAR(20) DEFAULT 'generic';

COMMIT;
