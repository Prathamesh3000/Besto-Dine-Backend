'use strict';
/**
 * Daily cash-closing arithmetic (Plan 3B.5). Pure, no DB.
 *
 *   expectedCash = openingCash + cashSales - cashRefunds - cashPaidOuts
 *   variance     = countedCash - expectedCash   (negative = drawer is short)
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function computeCash({ openingCash = 0, cashSales = 0, cashRefunds = 0, cashPaidOuts = 0, countedCash = null } = {}) {
    const expectedCash = round2(round2(openingCash) + round2(cashSales) - round2(cashRefunds) - round2(cashPaidOuts));
    const counted = countedCash === null || countedCash === undefined || countedCash === '' ? null : round2(countedCash);
    return {
        openingCash: round2(openingCash),
        cashSales: round2(cashSales),
        cashRefunds: round2(cashRefunds),
        cashPaidOuts: round2(cashPaidOuts),
        expectedCash,
        countedCash: counted,
        variance: counted === null ? null : round2(counted - expectedCash),
    };
}

module.exports = { computeCash, round2 };
