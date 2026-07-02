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
    'плён',
    'плен',
    'стретч',
    'стрейч',
    'стреч',
    'лента',
    'этикет',
    'ярлык',
    'короб',
    'ящик',
    'поддон',
    'паллета',
    'паллет',
    'тара',
    'скоб',
    'скотч'
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
