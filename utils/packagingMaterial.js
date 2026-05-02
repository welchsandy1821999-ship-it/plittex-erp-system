function normalizeText(v) {
    return String(v || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

const PACKAGING_KEYWORDS = [
    'упаков',
    'пакет',
    'пленк',
    'стретч',
    'лента',
    'этикет',
    'ярлык',
    'короб',
    'ящик',
    'поддон',
    'паллета',
    'паллет',
    'тара'
];

function hasPackagingKeyword(text) {
    if (!text) return false;
    return PACKAGING_KEYWORDS.some((kw) => text.includes(kw));
}

function isPackagingItem(name, category) {
    const n = normalizeText(name);
    const c = normalizeText(category);
    if (!n && !c) return false;
    return hasPackagingKeyword(n) || hasPackagingKeyword(c);
}

module.exports = {
    isPackagingItem
};
/**
 * Материалы, учитываемые как «упаковка»: в формовке — только план/себестоимость, списание со склада — при распалубке.
 * Дублирование с клиентом (production.js) избегаем — везде этот helper на сервере; на клиенте — зеркальная эвристика.
 */
function isPackagingItem(name, category) {
    const c = (category && String(category).toLowerCase()) || '';
    if (c.includes('упаков')) return true;
    const n = (name && String(name).toLowerCase()) || '';
    if (/(скоб|лент|стрейч|стреч|стретч|плён|плен|поддон|паллет|короб|скотч|пакет)/i.test(n)) return true;
    return false;
}

module.exports = { isPackagingItem };
