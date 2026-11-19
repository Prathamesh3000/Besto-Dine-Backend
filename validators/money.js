// Request validators for money-handling routes that had none (plan 3A.2):
// staff wallet, tip settlement, purchases, suppliers, production batches and
// tenant billing. Required-field / business messages stay in the controllers;
// these only reject wrong types, malformed ids and absurd ranges. Unknown
// extra keys are never rejected.
const { validate, body, objectIdParam, optionalObjectId } = require('../middlewares/validate');
const {
    optionalAmount, optionalText, optionalEnum, optionalDate, optionalStringArray,
    lines, ruleOid, ruleNum,
} = require('./common');

const MAX_MONEY = 10000000; // 1 crore — far above any single legitimate amount

/**
 * Strict plain-decimal amount parser shared by the wallet endpoints.
 * Accepts a finite number or a plain decimal string ("12", "12.5", " 12.50 ").
 * Rejects booleans, arrays, objects, hex ("0x10"), exponent ("1e3"), signs and
 * empty strings by returning null. Does NOT range-check.
 */
function parseStrictAmount(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
        const n = Number(v.trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Optional amount: absent/null passes; otherwise a strict decimal in [0.01, max]. */
const strictOptionalAmount = (field, { max = MAX_MONEY, label } = {}) =>
    body(field)
        .optional({ values: 'null' })
        .custom((v) => {
            const n = parseStrictAmount(v);
            return n !== null && n >= 0.01 && n <= max;
        })
        .withMessage(`${label || field} must be a number between 0.01 and ${max}`);

// Optional trimmed text: must be a string whose TRIMMED length is <= max.
const trimmedText = (field, max, label) =>
    body(field)
        .optional({ values: 'null' })
        .custom((v) => typeof v === 'string' && v.trim().length <= max)
        .withMessage(`${label} must be text of at most ${max} characters`);

// ── Staff wallet ────────────────────────────────────────────────────────
const staffWalletWithdraw = validate([
    strictOptionalAmount('amount', { label: 'Amount' }),
    optionalEnum('method', ['Cash', 'UPI', 'Bank'], { label: 'Method' }),
    optionalText('upiId', 100, { label: 'UPI ID' }),
    optionalText('bankName', 100, { label: 'Bank name' }),
    optionalText('accountHolder', 100, { label: 'Account holder' }),
    optionalText('accountNumber', 30, { label: 'Account number' }),
    optionalText('ifsc', 20, { label: 'IFSC' }),
    optionalText('note', 500, { label: 'Note' }),
]);
const staffWalletApprove = validate([
    objectIdParam('id'),
    trimmedText('txnRef', 100, 'Transaction reference'),
]);
const staffWalletReject = validate([
    objectIdParam('id'),
    optionalText('reason', 500, { label: 'Reason' }),
]);

// ── Tips ────────────────────────────────────────────────────────────────
const tipSettle = validate([
    optionalObjectId('body', 'waiterId', 'Invalid waiterId'),
    optionalEnum('paymentMethod', ['Cash', 'Online'], { label: 'paymentMethod' }),
    optionalText('note', 500, { label: 'Note' }),
]);

// ── Purchases ───────────────────────────────────────────────────────────
const poLineRules = (l) => ruleOid(l, 'inventoryItem')
    || ruleNum(l, 'orderedQty', { gt: 0, max: 1000000 })
    || ruleNum(l, 'rate', { max: MAX_MONEY })
    || ruleNum(l, 'taxPercent', { max: 100 });
const receiveLineRules = (l) => ruleOid(l, 'inventoryItem')
    || ruleNum(l, 'qty', { max: 1000000 });

const poCommon = [
    optionalDate('expectedDate', { label: 'Expected date' }),
    optionalText('notes', 1000, { label: 'Notes' }),
    optionalText('invoiceNumber', 100, { label: 'Invoice number' }),
    lines('lines', poLineRules, { max: 200, label: 'Lines' }),
];
const purchaseCreate = validate([
    optionalObjectId('body', 'supplier', 'Invalid supplier'),
    optionalDate('orderDate', { label: 'Order date' }),
    ...poCommon,
]);
const purchaseUpdate = validate([objectIdParam('id'), ...poCommon]);
const purchaseReceive = validate([
    objectIdParam('id'),
    lines('lines', receiveLineRules, { max: 200, label: 'Lines' }),
    optionalText('note', 1000, { label: 'Note' }),
]);
const purchasePayment = validate([
    objectIdParam('id'),
    optionalAmount('amount', { gt: 0, max: MAX_MONEY, label: 'Payment amount' }),
    optionalText('mode', 30, { label: 'Mode' }),
    optionalText('reference', 200, { label: 'Reference' }),
    optionalDate('paidAt', { label: 'Paid date' }),
    optionalText('note', 1000, { label: 'Note' }),
]);
const purchaseIdOnly = validate([objectIdParam('id')]);

// ── Suppliers ───────────────────────────────────────────────────────────
const supplierBody = [
    optionalText('name', 150, { label: 'Name' }),
    optionalText('contactPerson', 150, { label: 'Contact person' }),
    optionalText('mobile', 30, { label: 'Mobile' }),
    optionalText('email', 200, { label: 'Email' }),
    optionalText('gstNumber', 20, { label: 'GST number' }),
    optionalText('address', 500, { label: 'Address' }),
    optionalText('notes', 1000, { label: 'Notes' }),
    optionalAmount('paymentTermsDays', { max: 365, label: 'Payment terms (days)' }),
    optionalStringArray('categories', { max: 50, maxLen: 100, label: 'Categories' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];
const supplierCreate = validate(supplierBody);
const supplierUpdate = validate([objectIdParam('id'), ...supplierBody]);
const supplierIdOnly = validate([objectIdParam('id')]);

// ── Production ──────────────────────────────────────────────────────────
const productionCreate = validate([
    optionalObjectId('body', 'recipeId', 'Invalid recipeId'),
    optionalObjectId('body', 'menuItemId', 'Invalid menuItemId'),
    optionalAmount('batchQuantity', { gt: 0, max: 100000, label: 'Batch quantity' }),
    optionalAmount('outputQty', { max: 10000000, label: 'Output quantity' }),
    optionalText('notes', 1000, { label: 'Notes' }),
    optionalDate('productionDate', { label: 'Production date' }),
]);

// ── Tenant billing ──────────────────────────────────────────────────────
const billingUpgrade = validate([optionalObjectId('body', 'planId', 'Invalid plan id')]);
const billingVerify = validate([
    optionalText('razorpay_order_id', 200, { label: 'razorpay_order_id' }),
    optionalText('razorpay_payment_id', 200, { label: 'razorpay_payment_id' }),
    optionalText('razorpay_signature', 500, { label: 'razorpay_signature' }),
]);
const billingDowngradeRequest = validate([
    optionalObjectId('body', 'planId', 'A valid plan id is required'),
    optionalText('reason', 1000, { label: 'Reason' }),
]);
const billingIdOnly = validate([objectIdParam('id')]);

module.exports = {
    parseStrictAmount,
    staffWalletWithdraw, staffWalletApprove, staffWalletReject,
    tipSettle,
    purchaseCreate, purchaseUpdate, purchaseReceive, purchasePayment, purchaseIdOnly,
    supplierCreate, supplierUpdate, supplierIdOnly,
    productionCreate,
    billingUpgrade, billingVerify, billingDowngradeRequest, billingIdOnly,
};
