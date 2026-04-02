// Middleware строгой входной валидации данных (AUDIT-018)
// Заменяет Joi/express-validator для быстрого старта без зависимостей.

module.exports = {
    validateItem: (req, res, next) => {
        const { name, current_price, item_type } = req.body;
        
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: "Название товара обязательно (Ошибка валидации)." });
        }
        
        if (current_price !== undefined) {
            const parsedPrice = parseFloat(current_price);
            if (isNaN(parsedPrice) || parsedPrice < 0) {
                return res.status(400).json({ error: "Цена не может быть отрицательной или нечисловой (Ошибка валидации)." });
            }
        }
        
        next();
    },

    validateSalaryAdjustment: (req, res, next) => {
        const { employee_id, amount } = req.body;
        
        if (!employee_id || isNaN(parseInt(employee_id))) {
            return res.status(400).json({ error: "Некорректный ID сотрудника (Ошибка валидации)." });
        }
        
        if (!amount || isNaN(parseFloat(amount))) {
            return res.status(400).json({ error: "Сумма корректировки некорректная (Ошибка валидации)." });
        }
        
        next();
    }
};
