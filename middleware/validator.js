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
    }
};
