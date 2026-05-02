const Big = require('big.js');

/**
 * Согласовано с распалубкой (routes/inventory.js): perUnitNeed = recipes.quantity_per_unit
 * для строки упаковки «поддон» — доля поддона на 1 ед. готового товара; ёмкость поддона = 1/perUnit.
 */
function calcPalletWriteoff(perUnitNeed, outputQty, carryInUnits) {
    const perUnit = new Big(perUnitNeed || 0);
    const out = new Big(outputQty || 0);
    if (perUnit.lte(0.00000001) || out.lte(0.00000001)) {
        return {
            needToWriteoff: new Big(0),
            carryOutUnits: Number(new Big(carryInUnits || 0).round(4)),
            palletsWriteoff: 0,
        };
    }

    const capacity = new Big(1).div(perUnit);
    let carry = new Big(carryInUnits || 0);
    if (carry.lt(0)) carry = new Big(0);
    if (carry.gte(capacity)) carry = carry.mod(capacity);

    let remaining = out;
    let pallets = 0;

    if (carry.gt(0) && remaining.gt(0)) {
        const freeOnOpened = capacity.minus(carry);
        const putToOpened = remaining.lt(freeOnOpened) ? remaining : freeOnOpened;
        carry = carry.plus(putToOpened);
        remaining = remaining.minus(putToOpened);
        if (carry.gte(capacity.minus(0.00000001))) {
            pallets += 1;
            carry = new Big(0);
        }
    }

    if (remaining.gt(0)) {
        const fullPallets = Number(remaining.div(capacity).round(0, 0));
        if (fullPallets > 0) {
            pallets += fullPallets;
            remaining = remaining.minus(capacity.times(fullPallets));
        }
        if (remaining.gt(0.00000001)) {
            pallets += 1;
            carry = remaining;
            if (carry.gte(capacity.minus(0.00000001))) {
                carry = new Big(0);
            }
        } else {
            carry = new Big(0);
        }
    }

    return {
        needToWriteoff: new Big(pallets),
        carryOutUnits: Number(carry.round(4)),
        palletsWriteoff: pallets,
    };
}

module.exports = { calcPalletWriteoff };
