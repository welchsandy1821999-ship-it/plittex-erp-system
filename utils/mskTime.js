/** Europe/Moscow (UTC+3, без перехода на летнее время с 2011 г.). */

const MSK_TZ_OFFSET = '+03:00';

function isCalendarDateString(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

/** Конец календарного дня по Москве: YYYY-MM-DD → ISO timestamptz 23:59:59+03:00 */
function mskEndOfDayIsoFromDateInput(input) {
    const datePart = String(input || '').trim();
    if (!isCalendarDateString(datePart)) return null;
    return `${datePart}T23:59:59${MSK_TZ_OFFSET}`;
}

/** Отгрузка: дата из <input type="date"> → конец дня MSK; иначе null (в SQL — NOW()). */
function resolveShipmentMovementTimestamp(shipDate) {
    if (shipDate == null || shipDate === '') return null;
    return mskEndOfDayIsoFromDateInput(shipDate);
}

/** Ревизия: ручная дата → конец дня MSK; иначе null (в SQL — CURRENT_TIMESTAMP). */
function resolveAuditMovementTimestamp(auditDate) {
    if (auditDate == null || auditDate === '') return null;
    return mskEndOfDayIsoFromDateInput(auditDate);
}

module.exports = {
    MSK_TZ_OFFSET,
    isCalendarDateString,
    mskEndOfDayIsoFromDateInput,
    resolveShipmentMovementTimestamp,
    resolveAuditMovementTimestamp
};
