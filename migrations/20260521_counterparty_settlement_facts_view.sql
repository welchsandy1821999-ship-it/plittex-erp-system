-- Phase 1: единый слой фактов взаиморасчётов контрагента (read-only VIEW).
-- Не переключает боевые роуты. Сверка: scripts/compare_settlement_balance.js
--
-- balance = SUM(balance_delta) по контрагенту
-- Положительное сальдо: должны НАМ. Отрицательное: должны МЫ.

CREATE OR REPLACE VIEW v_counterparty_settlement_facts AS

-- 1) Денежные приходы (оплата от контрагента)
SELECT
    ('tx:' || t.id::text) AS fact_id,
    'transactions'::text AS source_table,
    t.id AS source_id,
    COALESCE(t.counterparty_id, cp_emp.id) AS counterparty_id,
    t.employee_id,
    'money_income'::text AS fact_type,
    t.transaction_date AS fact_ts,
    ABS(t.amount)::numeric(18, 2) AS amount,
    (-ABS(t.amount))::numeric(18, 2) AS balance_delta,
    'income'::text AS display_transaction_type,
    COALESCE(t.category, '')::text AS category,
    COALESCE(t.description, '')::text AS description,
    'money'::text AS origin,
    COALESCE(t.payment_method, '')::text AS payment_method,
    COALESCE(t.source_module, '')::text AS source_module,
    COALESCE(t.system_type, '')::text AS system_type,
    t.linked_order_id,
    NULL::integer AS linked_order_item_id,
    t.linked_purchase_id,
    (
        t.transaction_type = 'income'
        AND COALESCE(t.source_module, '') = 'sales'
        AND COALESCE(t.system_type, '') = ''
        AND t.linked_order_id IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM transactions sp
            WHERE sp.linked_order_id = t.linked_order_id
              AND sp.system_type = 'salary_payment'
              AND COALESCE(sp.is_deleted, false) = false
        )
    ) AS hide_in_timeline,
    COALESCE(t.reg_is_posted, true) AS reg_is_posted,
    COALESCE(t.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(t.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM transactions t
LEFT JOIN counterparties cp_emp ON cp_emp.employee_id = t.employee_id
WHERE t.transaction_type = 'income'
  AND COALESCE(t.is_deleted, false) = false
  AND COALESCE(t.system_type, '') NOT LIKE 'imprest_%'
  AND COALESCE(t.source_module, '') <> 'transit'
  AND COALESCE(t.counterparty_id, cp_emp.id) IS NOT NULL
  AND (
      t.counterparty_id IS NOT NULL
      OR (
          t.employee_id IS NOT NULL
          AND (
              t.source_module = 'salary'
              OR t.system_type LIKE 'salary_%'
              OR t.salary_adjustment_id IS NOT NULL
          )
      )
  )

UNION ALL

-- 2a) Денежные расходы (наша оплата контрагенту), кроме возврата покупателю
SELECT
    ('tx:' || t.id::text) AS fact_id,
    'transactions'::text AS source_table,
    t.id AS source_id,
    COALESCE(t.counterparty_id, cp_emp.id) AS counterparty_id,
    t.employee_id,
    'money_expense'::text AS fact_type,
    t.transaction_date AS fact_ts,
    ABS(t.amount)::numeric(18, 2) AS amount,
    ABS(t.amount)::numeric(18, 2) AS balance_delta,
    'expense'::text AS display_transaction_type,
    COALESCE(t.category, '')::text AS category,
    COALESCE(t.description, '')::text AS description,
    'money'::text AS origin,
    COALESCE(t.payment_method, '')::text AS payment_method,
    COALESCE(t.source_module, '')::text AS source_module,
    COALESCE(t.system_type, '')::text AS system_type,
    t.linked_order_id,
    NULL::integer AS linked_order_item_id,
    t.linked_purchase_id,
    false AS hide_in_timeline,
    COALESCE(t.reg_is_posted, true) AS reg_is_posted,
    COALESCE(t.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(t.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM transactions t
LEFT JOIN counterparties cp_emp ON cp_emp.employee_id = t.employee_id
WHERE t.transaction_type = 'expense'
  AND COALESCE(t.is_deleted, false) = false
  AND COALESCE(t.system_type, '') NOT LIKE 'imprest_%'
  AND COALESCE(t.source_module, '') <> 'transit'
  AND TRIM(COALESCE(t.category, '')) <> 'Возврат средств покупателю'
  AND COALESCE(t.counterparty_id, cp_emp.id) IS NOT NULL
  AND (
      t.counterparty_id IS NOT NULL
      OR (
          t.employee_id IS NOT NULL
          AND (
              t.source_module = 'salary'
              OR t.system_type LIKE 'salary_%'
              OR t.salary_adjustment_id IS NOT NULL
          )
      )
  )

UNION ALL

-- 2b) Возврат средств покупателю (уменьшает дебиторку, как в profile)
SELECT
    ('tx:' || t.id::text) AS fact_id,
    'transactions'::text AS source_table,
    t.id AS source_id,
    COALESCE(t.counterparty_id, cp_emp.id) AS counterparty_id,
    t.employee_id,
    'money_expense_return_to_client'::text AS fact_type,
    t.transaction_date AS fact_ts,
    ABS(t.amount)::numeric(18, 2) AS amount,
    (-ABS(t.amount))::numeric(18, 2) AS balance_delta,
    'expense'::text AS display_transaction_type,
    COALESCE(t.category, '')::text AS category,
    COALESCE(t.description, '')::text AS description,
    'money'::text AS origin,
    COALESCE(t.payment_method, '')::text AS payment_method,
    COALESCE(t.source_module, '')::text AS source_module,
    COALESCE(t.system_type, '')::text AS system_type,
    t.linked_order_id,
    NULL::integer AS linked_order_item_id,
    t.linked_purchase_id,
    false AS hide_in_timeline,
    COALESCE(t.reg_is_posted, true) AS reg_is_posted,
    COALESCE(t.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(t.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(t.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM transactions t
LEFT JOIN counterparties cp_emp ON cp_emp.employee_id = t.employee_id
WHERE t.transaction_type = 'expense'
  AND TRIM(COALESCE(t.category, '')) = 'Возврат средств покупателю'
  AND COALESCE(t.is_deleted, false) = false
  AND COALESCE(t.system_type, '') NOT LIKE 'imprest_%'
  AND COALESCE(t.source_module, '') <> 'transit'
  AND COALESCE(t.counterparty_id, cp_emp.id) IS NOT NULL

UNION ALL

-- 3) Отгрузка продукции клиенту
SELECT
    ('mv:' || m.id::text) AS fact_id,
    'inventory_movements'::text AS source_table,
    m.id AS source_id,
    co.counterparty_id,
    NULL::integer AS employee_id,
    'sales_shipment'::text AS fact_type,
    COALESCE(m.movement_date, m.created_at) AS fact_ts,
    (ABS(m.quantity) * COALESCE(coi.price, 0))::numeric(18, 2) AS amount,
    (ABS(m.quantity) * COALESCE(coi.price, 0))::numeric(18, 2) AS balance_delta,
    'expense'::text AS display_transaction_type,
    'Отгрузка продукции'::text AS category,
    COALESCE(m.description, '')::text AS description,
    'goods'::text AS origin,
    COALESCE(co.payment_method, '')::text AS payment_method,
    ''::text AS source_module,
    ''::text AS system_type,
    co.id AS linked_order_id,
    m.linked_order_item_id,
    NULL::integer AS linked_purchase_id,
    EXISTS (
        SELECT 1
        FROM transactions sp
        WHERE sp.linked_order_id = co.id
          AND sp.system_type = 'salary_payment'
          AND COALESCE(sp.is_deleted, false) = false
    ) AS hide_in_timeline,
    COALESCE(m.reg_is_posted, true) AS reg_is_posted,
    COALESCE(m.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(m.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM inventory_movements m
JOIN client_order_items coi ON coi.id = m.linked_order_item_id
JOIN client_orders co ON co.id = coi.order_id
WHERE m.movement_type = 'sales_shipment'
  AND co.counterparty_id IS NOT NULL

UNION ALL

-- 4) Сторно отгрузки
SELECT
    ('mv:' || m.id::text) AS fact_id,
    'inventory_movements'::text AS source_table,
    m.id AS source_id,
    co.counterparty_id,
    NULL::integer AS employee_id,
    'shipment_reversal'::text AS fact_type,
    COALESCE(m.movement_date, m.created_at) AS fact_ts,
    (ABS(m.quantity) * COALESCE(coi.price, 0))::numeric(18, 2) AS amount,
    (-(ABS(m.quantity) * COALESCE(coi.price, 0)))::numeric(18, 2) AS balance_delta,
    'income'::text AS display_transaction_type,
    'Сторно отгрузки'::text AS category,
    COALESCE(m.description, '')::text AS description,
    'goods'::text AS origin,
    COALESCE(co.payment_method, '')::text AS payment_method,
    ''::text AS source_module,
    ''::text AS system_type,
    co.id AS linked_order_id,
    m.linked_order_item_id,
    NULL::integer AS linked_purchase_id,
    false AS hide_in_timeline,
    COALESCE(m.reg_is_posted, true) AS reg_is_posted,
    COALESCE(m.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(m.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(m.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM inventory_movements m
JOIN client_order_items coi ON coi.id = m.linked_order_item_id
JOIN client_orders co ON co.id = coi.order_id
WHERE m.movement_type = 'shipment_reversal'
  AND co.counterparty_id IS NOT NULL

UNION ALL

-- 5) Поступление сырья от поставщика (не для контрагентов-сотрудников)
SELECT
    ('mv:' || im.id::text) AS fact_id,
    'inventory_movements'::text AS source_table,
    im.id AS source_id,
    im.supplier_id AS counterparty_id,
    NULL::integer AS employee_id,
    'purchase_receipt'::text AS fact_type,
    COALESCE(im.movement_date, im.created_at) AS fact_ts,
    ABS(im.amount)::numeric(18, 2) AS amount,
    (-ABS(im.amount))::numeric(18, 2) AS balance_delta,
    'income'::text AS display_transaction_type,
    'Поставка сырья'::text AS category,
    COALESCE(im.description, '')::text AS description,
    'goods'::text AS origin,
    ''::text AS payment_method,
    ''::text AS source_module,
    ''::text AS system_type,
    NULL::integer AS linked_order_id,
    NULL::integer AS linked_order_item_id,
    NULL::integer AS linked_purchase_id,
    false AS hide_in_timeline,
    COALESCE(im.reg_is_posted, true) AS reg_is_posted,
    COALESCE(im.reg_is_primary_doc, false) AS reg_is_primary_doc,
    COALESCE(im.reg_document_no, '')::text AS reg_document_no,
    COALESCE(NULLIF(TRIM(im.reg_source_tag), ''), 'legacy')::text AS reg_source_tag,
    false AS is_deleted
FROM inventory_movements im
JOIN counterparties cp ON cp.id = im.supplier_id
WHERE im.movement_type = 'purchase'
  AND im.supplier_id IS NOT NULL
  AND COALESCE(cp.is_employee, false) = false;

COMMENT ON VIEW v_counterparty_settlement_facts IS
    'Атомарные факты взаиморасчётов: money + sales_shipment + reversal + purchase. SUM(balance_delta) = сальдо контрагента.';
