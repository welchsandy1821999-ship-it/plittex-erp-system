// Middleware строгой входной валидации данных (AUDIT-018)
// Zero-dependency подход: собственные функции без Joi/express-validator.

// ==========================================
// УТИЛИТЫ ВАЛИДАЦИИ
// ==========================================

/** Проверка формата email (если передан) */
function _isValidEmail(email) {
    if (!email || String(email).trim() === '') return true; // Пустое = ок (необязательное поле)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/** ИНН: 10 цифр (юрлицо) или 12 цифр (физлицо/ИП) */
function _isValidInn(inn) {
    if (!inn || String(inn).trim() === '') return true; // Пустое = ок (необязательное поле)
    const cleaned = String(inn).trim();
    return /^\d{10}$/.test(cleaned) || /^\d{12}$/.test(cleaned);
}

/** КПП: ровно 9 цифр */
function _isValidKpp(kpp) {
    if (!kpp || String(kpp).trim() === '') return true; // Пустое = ок
    return /^\d{9}$/.test(String(kpp).trim());
}

/** Стандартный ответ ошибки валидации */
function _validationError(res, details) {
    return res.status(400).json({ error: 'Ошибка валидации', details });
}

// ==========================================
// ВАЛИДАТОРЫ (Express Middleware)
// ==========================================

module.exports = {

    // ------------------------------------------
    // СПРАВОЧНИКИ (dictionaries.js)
    // ------------------------------------------

    /** Валидация товара (POST /api/items) */
    validateItem: (req, res, next) => {
        const { name, current_price } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            errors.push('Название товара обязательно.');
        }

        if (current_price !== undefined) {
            const parsedPrice = parseFloat(current_price);
            if (isNaN(parsedPrice) || parsedPrice < 0) {
                errors.push('Цена не может быть отрицательной или нечисловой.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // КАДРЫ (hr.js)
    // ------------------------------------------

    /** Валидация корректировки зарплаты (POST /api/salary/adjustments) */
    validateSalaryAdjustment: (req, res, next) => {
        const { employee_id, amount } = req.body;
        const errors = [];

        if (!employee_id || isNaN(parseInt(employee_id))) {
            errors.push('Некорректный ID сотрудника.');
        }

        if (!amount || isNaN(parseFloat(amount))) {
            errors.push('Сумма корректировки некорректная.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // ФИНАНСЫ (finance.js) — Phase 6.12
    // ------------------------------------------

    /** POST /api/transactions — создание транзакции */
    validateTransaction: (req, res, next) => {
        const { amount, type, category, account_id, employee_mode } = req.body;
        const errors = [];

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            errors.push('Сумма операции должна быть больше нуля.');
        }

        if (!type || !['income', 'expense'].includes(type)) {
            // Допускаем пустой type для специальных режимов (employee_mode)
            if (!employee_mode) {
                errors.push('Тип операции должен быть "income" или "expense".');
            }
        }

        if (!account_id) {
            errors.push('Не указан счёт (касса).');
        }

        // Категория обязательна (кроме переводов и подотчета)
        if (!category && type !== 'transfer' && employee_mode !== 'imprest') {
            errors.push('Не указана категория операции.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** PUT /api/transactions/:id — редактирование транзакции */
    validateTransactionEdit: (req, res, next) => {
        const { amount, category } = req.body;
        const errors = [];

        if (amount !== undefined) {
            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                errors.push('Сумма операции должна быть больше нуля.');
            }
        }

        if (category !== undefined && typeof category === 'string' && category.trim() === '') {
            errors.push('Категория не может быть пустой строкой.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/transactions/transfer — перевод между счетами */
    validateTransfer: (req, res, next) => {
        const { from_account_id, to_account_id, amount } = req.body;
        const errors = [];

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            errors.push('Сумма перевода должна быть больше нуля.');
        }

        if (!from_account_id) {
            errors.push('Не указан счёт-источник.');
        }

        if (!to_account_id) {
            errors.push('Не указан счёт-получатель.');
        }

        if (from_account_id && to_account_id && String(from_account_id) === String(to_account_id)) {
            errors.push('Нельзя перевести деньги на тот же счёт.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST/PUT /api/counterparties — контрагент */
    validateCounterparty: (req, res, next) => {
        const { name, inn, kpp, email } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            errors.push('Название контрагента обязательно (минимум 2 символа).');
        }

        if (inn && !_isValidInn(inn)) {
            errors.push('ИНН должен содержать 10 цифр (юрлицо) или 12 цифр (ИП/физлицо).');
        }

        if (kpp && !_isValidKpp(kpp)) {
            errors.push('КПП должен содержать ровно 9 цифр.');
        }

        if (email && !_isValidEmail(email)) {
            errors.push('Некорректный формат email.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/invoices — создание счёта */
    validateInvoice: (req, res, next) => {
        const { cp_id, amount } = req.body;
        const errors = [];

        if (!cp_id || isNaN(parseInt(cp_id))) {
            errors.push('Не указан контрагент (или некорректный ID).');
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            errors.push('Сумма счёта должна быть больше нуля.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/accounts — создание кассы */
    validateAccount: (req, res, next) => {
        const { name, balance } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            errors.push('Название счёта (кассы) обязательно.');
        }

        if (balance !== undefined && balance !== null) {
            const parsedBalance = parseFloat(balance);
            if (isNaN(parsedBalance) || parsedBalance < 0) {
                errors.push('Начальный баланс не может быть отрицательным.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** PUT /api/accounts/:id — переименование кассы */
    validateAccountEdit: (req, res, next) => {
        const { name } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            errors.push('Название счёта (кассы) обязательно.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/finance/categories — создание категории */
    validateCategory: (req, res, next) => {
        const { name } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            errors.push('Название категории обязательно.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/counterparties/:id/correction — корректировка долга */
    validateCorrection: (req, res, next) => {
        const { amount, type, date } = req.body;
        const errors = [];

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            errors.push('Сумма корректировки должна быть больше нуля.');
        }

        if (!type || !['income', 'expense'].includes(type)) {
            errors.push('Тип корректировки должен быть "income" или "expense".');
        }

        if (!date) {
            errors.push('Не указана дата корректировки.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/finance/planned-expenses/:id/pay, POST /api/invoices/:id/pay — оплата */
    validatePayment: (req, res, next) => {
        const { account_id } = req.body;
        const errors = [];

        if (!account_id) {
            errors.push('Не указан счёт (касса) для проведения оплаты.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** PUT /api/finance/categories/:id/group — обновление группы затрат */
    validateCostGroup: (req, res, next) => {
        const { cost_group } = req.body;
        const errors = [];

        const allowed = ['direct', 'opex', 'capex', 'overhead', null, undefined, ''];
        if (cost_group !== undefined && cost_group !== null && cost_group !== '' && !['direct', 'opex', 'capex', 'overhead'].includes(cost_group)) {
            errors.push('Группа затрат должна быть: direct, opex, capex или overhead.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // СКЛАД (inventory.js) — Phase 6.13
    // ------------------------------------------

    /** POST/PUT /api/inventory/purchase — закупка сырья */
    validatePurchase: (req, res, next) => {
        const { itemId, counterparty_id, quantity, pricePerUnit } = req.body;
        const errors = [];

        if (!itemId || isNaN(parseInt(itemId))) {
            errors.push('Не указан товар (itemId).');
        }

        if (!counterparty_id || isNaN(parseInt(counterparty_id))) {
            errors.push('Не указан поставщик.');
        }

        const parsedQty = parseFloat(quantity);
        if (isNaN(parsedQty) || parsedQty <= 0) {
            errors.push('Количество должно быть положительным числом.');
        }

        if (pricePerUnit !== undefined && pricePerUnit !== null && pricePerUnit !== '') {
            const parsedPrice = parseFloat(pricePerUnit);
            if (isNaN(parsedPrice) || parsedPrice < 0) {
                errors.push('Цена за единицу не может быть отрицательной.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/inventory/sifting — просеивание сырья */
    validateSifting: (req, res, next) => {
        const { sourceId, sourceQty, outputs, date } = req.body;
        const errors = [];

        if (!sourceId || isNaN(parseInt(sourceId))) {
            errors.push('Не указано исходное сырьё (sourceId).');
        }

        const parsedQty = parseFloat(sourceQty);
        if (isNaN(parsedQty) || parsedQty <= 0) {
            errors.push('Количество исходного сырья должно быть больше нуля.');
        }

        // Валидация даты (опциональное поле)
        if (date) {
            const parsedDate = new Date(date);
            if (isNaN(parsedDate.getTime())) {
                errors.push('Некорректный формат даты переработки.');
            } else {
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (parsedDate > today) {
                    errors.push('Дата переработки не может быть в будущем.');
                }
            }
        }

        if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
            errors.push('Не указаны выходные фракции (outputs).');
        } else {
            for (let i = 0; i < outputs.length; i++) {
                const out = outputs[i];
                if (!out.id || isNaN(parseInt(out.id))) {
                    errors.push(`Выход #${i + 1}: не указан ID товара.`);
                }
                if (out.qty !== undefined && out.qty !== 0) {
                    const oQty = parseFloat(out.qty);
                    if (isNaN(oQty) || oQty < 0) {
                        errors.push(`Выход #${i + 1}: количество не может быть отрицательным.`);
                    }
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/inventory/scrap, /api/inventory/dispose — списание / утилизация */
    validateScrap: (req, res, next) => {
        const { itemId, warehouseId, scrapQty, disposeQty } = req.body;
        const errors = [];
        const qty = scrapQty || disposeQty; // Универсальный: оба маршрута

        if (!itemId || isNaN(parseInt(itemId))) {
            errors.push('Не указан товар (itemId).');
        }

        if (!warehouseId || isNaN(parseInt(warehouseId))) {
            errors.push('Не указан склад-источник.');
        }

        const parsedQty = parseFloat(qty);
        if (isNaN(parsedQty) || parsedQty <= 0) {
            errors.push('Количество для списания должно быть больше нуля.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/inventory/audit — инвентаризация (корректировка остатков) */
    validateAudit: (req, res, next) => {
        const { warehouseId, adjustments } = req.body;
        const errors = [];

        if (!warehouseId || isNaN(parseInt(warehouseId))) {
            errors.push('Не указан склад для инвентаризации.');
        }

        if (!adjustments || !Array.isArray(adjustments) || adjustments.length === 0) {
            errors.push('Список корректировок пуст.');
        } else {
            for (let i = 0; i < adjustments.length; i++) {
                const adj = adjustments[i];
                if (!adj.itemId || isNaN(parseInt(adj.itemId))) {
                    errors.push(`Корректировка #${i + 1}: не указан товар.`);
                    continue;
                }
                if (adj.actualQty === undefined || adj.actualQty === null) {
                    errors.push(`Корректировка #${i + 1}: не указан фактический остаток.`);
                } else {
                    const nq = parseFloat(adj.actualQty);
                    if (isNaN(nq) || nq < 0) {
                        errors.push(`Корректировка #${i + 1}: остаток не может быть отрицательным.`);
                    }
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/inventory/reserve-action — управление резервами */
    validateReserveAction: (req, res, next) => {
        const { action, itemId, qty } = req.body;
        const errors = [];

        if (!action || !['release', 'transfer'].includes(action)) {
            errors.push('Действие должно быть "release" или "transfer".');
        }

        if (!itemId || isNaN(parseInt(itemId))) {
            errors.push('Не указан товар (itemId).');
        }

        const parsedQty = parseFloat(qty);
        if (isNaN(parsedQty) || parsedQty <= 0) {
            errors.push('Количество должно быть больше нуля.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // ПРОИЗВОДСТВО (production.js) — Phase 6.14
    // ------------------------------------------

    /** POST /api/production — создание черновика/смены */
    validateProductionDraft: (req, res, next) => {
        const { date, products } = req.body;
        const errors = [];

        if (!date) {
            errors.push('Не указана дата производства.');
        } else {
            // Формат YYYY-MM-DD и не позже сегодня
            const requestDate = new Date(date);
            if (isNaN(requestDate.getTime())) {
                errors.push('Некорректный формат даты.');
            } else {
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (requestDate > today) {
                    errors.push('Нельзя создавать производство будущим числом.');
                }
            }
        }

        if (!products || !Array.isArray(products) || products.length === 0) {
            errors.push('Список продукции пуст.');
        } else {
            for (let i = 0; i < products.length; i++) {
                const p = products[i];
                if (!p.id || isNaN(parseInt(p.id))) {
                    errors.push(`Продукт #${i + 1}: не указан ID товара.`);
                }
                const qty = parseFloat(p.quantity);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Продукт #${i + 1}: количество должно быть больше нуля.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/recipes/save — сохранение рецепта */
    validateRecipeSave: (req, res, next) => {
        const { productId, ingredients } = req.body;
        const errors = [];

        if (!productId || isNaN(parseInt(productId))) {
            errors.push('Не указан товар (productId).');
        }

        if (!Array.isArray(ingredients)) {
            errors.push('Поле ingredients должно быть массивом.');
        } else {
            for (let i = 0; i < ingredients.length; i++) {
                const ing = ingredients[i];
                if (!ing.materialId || isNaN(parseInt(ing.materialId))) {
                    errors.push(`Ингредиент #${i + 1}: не указан ID материала.`);
                }
                const qty = parseFloat(ing.qty);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Ингредиент #${i + 1}: количество должно быть больше нуля.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/recipes/sync-category — синхронизация рецепта на категорию */
    validateRecipeSync: (req, res, next) => {
        const { targetProductIds, materials } = req.body;
        const errors = [];

        if (!targetProductIds || !Array.isArray(targetProductIds) || targetProductIds.length === 0) {
            errors.push('Не выбраны товары для синхронизации.');
        }

        if (!materials || !Array.isArray(materials) || materials.length === 0) {
            errors.push('Список материалов для синхронизации пуст.');
        } else {
            for (let i = 0; i < materials.length; i++) {
                const mat = materials[i];
                if (!mat.materialId || isNaN(parseInt(mat.materialId))) {
                    errors.push(`Материал #${i + 1}: не указан ID.`);
                }
                const qty = parseFloat(mat.qty);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Материал #${i + 1}: количество должно быть больше нуля.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // ПРОДАЖИ (sales.js) — Phase 6.15
    // ------------------------------------------

    /** POST /api/sales/checkout — оформление заказа */
    validateCheckout: (req, res, next) => {
        const { counterparty_id, items } = req.body;
        const errors = [];

        if (!counterparty_id || isNaN(parseInt(counterparty_id))) {
            errors.push('Не указан контрагент.');
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            errors.push('Корзина пуста.');
        } else {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item.id || isNaN(parseInt(item.id))) {
                    errors.push(`Позиция #${i + 1}: не указан ID товара.`);
                }
                const qty = parseFloat(item.qty);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Позиция #${i + 1}: количество должно быть больше нуля.`);
                }
                const price = parseFloat(item.price);
                if (isNaN(price) || price < 0) {
                    errors.push(`Позиция #${i + 1}: цена не может быть отрицательной.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/sales/returns — возврат от клиента */
    validateReturn: (req, res, next) => {
        const { order_id, items } = req.body;
        const errors = [];

        if (!order_id || isNaN(parseInt(order_id))) {
            errors.push('Не указан заказ (order_id).');
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            errors.push('Список возвращаемых позиций пуст.');
        } else {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item.id || isNaN(parseInt(item.id))) {
                    errors.push(`Возврат #${i + 1}: не указан ID товара.`);
                }
                const qty = parseFloat(item.qty);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Возврат #${i + 1}: количество должно быть больше нуля.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/sales/orders/:id/ship — отгрузка */
    validateShipment: (req, res, next) => {
        const { items_to_ship } = req.body;
        const errors = [];

        if (!items_to_ship || !Array.isArray(items_to_ship) || items_to_ship.length === 0) {
            errors.push('Список позиций для отгрузки пуст.');
        } else {
            for (let i = 0; i < items_to_ship.length; i++) {
                const item = items_to_ship[i];
                if (!item.coi_id || isNaN(parseInt(item.coi_id))) {
                    errors.push(`Отгрузка #${i + 1}: не указан ID позиции заказа (coi_id).`);
                }
                const qty = parseFloat(item.qty);
                if (isNaN(qty) || qty <= 0) {
                    errors.push(`Отгрузка #${i + 1}: количество должно быть больше нуля.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/sales/transfer-reserve — переброска резерва */
    validateTransferReserve: (req, res, next) => {
        const { donor_coi_id, recipient_coi_id, transfer_qty } = req.body;
        const errors = [];

        if (!donor_coi_id || isNaN(parseInt(donor_coi_id))) {
            errors.push('Не указан заказ-донор (donor_coi_id).');
        }

        if (!recipient_coi_id || isNaN(parseInt(recipient_coi_id))) {
            errors.push('Не указан заказ-реципиент (recipient_coi_id).');
        }

        const qty = parseFloat(transfer_qty);
        if (isNaN(qty) || qty <= 0) {
            errors.push('Количество для переброски должно быть больше нуля.');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** PUT /api/sales/orders/:id/status — обновление статуса заказа */
    validateOrderStatus: (req, res, next) => {
        const { status } = req.body;
        const errors = [];

        const VALID_STATUSES = ['pending', 'processing', 'completed', 'cancelled'];
        if (!status || !VALID_STATUSES.includes(status)) {
            errors.push(`Статус должен быть одним из: ${VALID_STATUSES.join(', ')}.`);
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // HR & ЗАРПЛАТЫ (hr.js) — Phase 6.16
    // ------------------------------------------

    /** POST /api/timesheet/cell — сохранение ячейки табеля */
    validateTimesheetCell: (req, res, next) => {
        const { employee_id, date, status, bonus, penalty, multiplier } = req.body;
        const errors = [];

        if (!employee_id || isNaN(parseInt(employee_id))) {
            errors.push('Не указан сотрудник (employee_id).');
        }

        if (!date) {
            errors.push('Не указана дата.');
        }

        const VALID_STATUSES = ['present', 'partial', 'weekend', 'absent', 'sick', 'vacation'];
        if (!status || !VALID_STATUSES.includes(status)) {
            errors.push(`Недопустимый статус. Допустимые: ${VALID_STATUSES.join(', ')}.`);
        }

        if (bonus !== undefined && bonus !== null && bonus !== '') {
            const b = parseFloat(bonus);
            if (isNaN(b) || b < 0) {
                errors.push('Премия не может быть отрицательной.');
            }
        }

        if (penalty !== undefined && penalty !== null && penalty !== '') {
            const p = parseFloat(penalty);
            if (isNaN(p) || p < 0) {
                errors.push('Штраф не может быть отрицательным.');
            }
        }

        if (multiplier !== undefined && multiplier !== null) {
            const m = parseFloat(multiplier);
            if (isNaN(m) || m < 0 || m > 1.0) {
                errors.push('Множитель должен быть от 0.0 до 1.0.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/timesheet/mass-bonus — массовое начисление сделки */
    validateMassBonus: (req, res, next) => {
        const { date, workersData } = req.body;
        const errors = [];

        if (!date) {
            errors.push('Не указана дата.');
        }

        if (!workersData || !Array.isArray(workersData) || workersData.length === 0) {
            errors.push('Список рабочих пуст.');
        } else {
            for (let i = 0; i < workersData.length; i++) {
                const w = workersData[i];
                if (!w.employee_id || isNaN(parseInt(w.employee_id))) {
                    errors.push(`Рабочий #${i + 1}: не указан ID сотрудника.`);
                }
                const ktu = parseFloat(w.ktu);
                if (isNaN(ktu) || ktu < 0 || ktu > 5) {
                    errors.push(`Рабочий #${i + 1}: КТУ должно быть от 0 до 5.`);
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/salary/pay — выплата зарплаты */
    validateSalaryPay: (req, res, next) => {
        const { employee_id, amount, date, account_id } = req.body;
        const errors = [];

        if (!employee_id || isNaN(parseInt(employee_id))) {
            errors.push('Не указан сотрудник (employee_id).');
        }

        if (amount === undefined || amount === null) {
            errors.push('Не указана сумма выплаты.');
        } else {
            const a = parseFloat(amount);
            if (isNaN(a) || a < 0) {
                errors.push('Сумма выплаты не может быть отрицательной.');
            }
        }

        if (!date) {
            errors.push('Не указана дата выплаты.');
        }

        if (!account_id || isNaN(parseInt(account_id))) {
            errors.push('Не указан счёт/касса (account_id).');
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    // ------------------------------------------
    // СПРАВОЧНИКИ (dictionaries.js) — Phase 6.17 (FINAL)
    // ------------------------------------------

    /** POST/PUT /api/employees — создание/обновление сотрудника */
    validateEmployee: (req, res, next) => {
        const { full_name, salary_cash, salary_official, tax_rate } = req.body;
        const errors = [];

        if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 3) {
            errors.push('ФИО обязательно и должно содержать не менее 3 символов.');
        }

        if (salary_cash !== undefined && salary_cash !== null) {
            const sc = parseFloat(salary_cash);
            if (isNaN(sc) || sc < 0) {
                errors.push('Зарплата (нал.) не может быть отрицательной.');
            }
        }

        if (salary_official !== undefined && salary_official !== null) {
            const so = parseFloat(salary_official);
            if (isNaN(so) || so < 0) {
                errors.push('Зарплата (офиц.) не может быть отрицательной.');
            }
        }

        if (tax_rate !== undefined && tax_rate !== null) {
            const tr = parseFloat(tax_rate);
            if (isNaN(tr) || tr < 0 || tr > 100) {
                errors.push('Ставка налога должна быть от 0 до 100%.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST/PUT /api/equipment — создание/обновление оборудования */
    validateEquipment: (req, res, next) => {
        const { name, equipment_type, purchase_cost, planned_cycles } = req.body;
        const errors = [];

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            errors.push('Название оборудования обязательно.');
        }

        const VALID_TYPES = ['machine', 'mold', 'pallets'];
        if (!equipment_type || !VALID_TYPES.includes(equipment_type)) {
            errors.push(`Тип оборудования должен быть одним из: ${VALID_TYPES.join(', ')}.`);
        }

        if (purchase_cost !== undefined && purchase_cost !== null) {
            const pc = parseFloat(purchase_cost);
            if (isNaN(pc) || pc < 0) {
                errors.push('Стоимость не может быть отрицательной.');
            }
        }

        if (planned_cycles !== undefined && planned_cycles !== null) {
            const cy = parseFloat(planned_cycles);
            if (isNaN(cy) || cy <= 0) {
                errors.push('Плановый ресурс (циклы) должен быть больше нуля.');
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    },

    /** POST /api/products/update-prices — массовое обновление прайс-листа */
    validateUpdatePrices: (req, res, next) => {
        const { prices } = req.body;
        const errors = [];

        if (!prices || !Array.isArray(prices) || prices.length === 0) {
            errors.push('Список цен пуст.');
        } else {
            for (let i = 0; i < prices.length; i++) {
                const p = prices[i];
                if (!p.id || isNaN(parseInt(p.id))) {
                    errors.push(`Позиция #${i + 1}: не указан ID товара.`);
                }
                if (p.price !== undefined) {
                    const pr = parseFloat(p.price);
                    if (isNaN(pr) || pr < 0) {
                        errors.push(`Позиция #${i + 1}: цена не может быть отрицательной.`);
                    }
                }
            }
        }

        if (errors.length > 0) return _validationError(res, errors);
        next();
    }
};
