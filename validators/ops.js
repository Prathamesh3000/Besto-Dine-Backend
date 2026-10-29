// Request validators for operational / catalog write routes that had none
// (plan 3A.2): orders (type + length checks only), shifts, areas, printing,
// inventory + recipes, halls, event/package/add-on catalog, decorations,
// combos and captain escalation.
//
// Most order routes look an order up by Mongo _id OR the human order number
// (ORD-0001), so their :id is length/charset checked rather than ObjectId
// checked. Routes whose controllers already return 400/404 for malformed ids
// (print jobs/bills, invoice generate, shift staff ids) are not re-guarded.
// Required-field messages stay in the controllers; unknown keys are allowed.
const { validate, param, objectIdParam, optionalObjectId } = require('../middlewares/validate');
const {
    optionalAmount, optionalText, optionalBool, optionalDate, optionalArray,
    lines, ruleOid, ruleNum,
} = require('./common');

const MAX_MONEY = 10000000;
const STOCK_MAX = 1000000000;

// ── Orders ──────────────────────────────────────────────────────────────
const orderRef = (name = 'id') => param(name)
    .isString().isLength({ min: 1, max: 64 }).withMessage(`Invalid ${name}`)
    .bail()
    .matches(/^[\w\-.:]+$/).withMessage(`Invalid ${name}`);

const itemIsObject = (l) => (l && typeof l === 'object' ? null : 'must be an object');

const orderCreate = validate([
    lines('items', itemIsObject, { max: 200, label: 'Items' }),
    optionalAmount('total', { max: 100000000, label: 'Total' }),
    optionalText('note', 2000, { label: 'Note' }),
    optionalText('couponCode', 50, { label: 'Coupon code' }),
]);
const orderDeliveryQuote = validate([
    optionalAmount('lat', { min: -90, max: 90, label: 'Latitude' }),
    optionalAmount('lng', { min: -180, max: 180, label: 'Longitude' }),
    optionalText('address', 500, { label: 'Address' }),
]);
const orderStatus = validate([
    orderRef(),
    optionalText('status', 40, { label: 'Status' }),
    optionalText('paymentStatus', 40, { label: 'Payment status' }),
    optionalText('cancellationReason', 500, { label: 'Cancellation reason' }),
]);
const orderIdOnly = validate([orderRef()]);
const orderDelivery = validate([
    orderRef(),
    optionalText('status', 40, { label: 'Status' }),
    optionalText('partnerName', 100, { label: 'Partner name' }),
]);
const orderAppend = validate([
    orderRef(),
    lines('items', itemIsObject, { max: 200, label: 'Items' }),
]);
const orderCoupon = validate([orderRef(), optionalText('code', 50, { label: 'Coupon code' })]);
const orderBillSave = validate([orderRef(), optionalBool('final', { label: 'final' })]);
const orderBillReopen = validate([orderRef(), optionalText('reason', 500, { label: 'Reason' })]);
const orderPayment = validate([
    orderRef(),
    optionalText('paymentStatus', 40, { label: 'Payment status' }),
    optionalText('paymentMethod', 40, { label: 'Payment method' }),
]);
// 1-5 range + message stay in the service (numeric strings are accepted there).
const orderRating = validate([
    orderRef(),
    optionalText('feedback', 2000, { label: 'Feedback' }),
]);
// The controller queries _id: orderId and items.id(itemId) directly.
const orderRepeatItem = validate([
    objectIdParam('orderId'),
    objectIdParam('itemId'),
    optionalAmount('quantity', { gt: 0, max: 1000, label: 'Quantity' }),
]);
const orderRepeatAll = validate([orderRef(), optionalArray('selections', { max: 500, label: 'selections' })]);
const orderCleanup = validate([
    optionalAmount('minutesOld', { max: 525600, label: 'minutesOld' }),
    optionalText('type', 30, { label: 'type' }),
    optionalBool('dryRun', { label: 'dryRun' }),
]);

// ── Shifts ──────────────────────────────────────────────────────────────
const shiftNote = validate([optionalText('note', 500, { label: 'Note' })]);
const shiftHandover = validate([
    optionalText('note', 500, { label: 'Note' }),
    optionalAmount('cashCounted', { max: MAX_MONEY, label: 'cashCounted' }),
]);

// ── Areas ───────────────────────────────────────────────────────────────
const areaBody = [
    optionalText('name', 100, { label: 'Name' }),
    optionalText('note', 500, { label: 'Note' }),
    optionalText('description', 1000, { label: 'Description' }),
    optionalBool('isActive', { label: 'isActive' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];
const areaCreate = validate(areaBody);
const areaUpdate = validate([objectIdParam('id'), ...areaBody]);
const areaIdOnly = validate([objectIdParam('id')]);

// ── Printing ────────────────────────────────────────────────────────────
const printTest = validate([
    optionalText('printerId', 100, { label: 'printerId' }),
    optionalBool('openDrawer', { label: 'openDrawer' }),
]);

// ── Inventory ───────────────────────────────────────────────────────────
const inventoryFields = [
    optionalText('name', 150, { label: 'Name' }),
    optionalText('category', 60, { label: 'Category' }),
    optionalText('unit', 20, { label: 'Unit' }),
    optionalAmount('currentStock', { max: STOCK_MAX, label: 'Current stock' }),
    optionalAmount('minStock', { max: STOCK_MAX, label: 'Min stock' }),
    optionalAmount('maxStock', { max: STOCK_MAX, label: 'Max stock' }),
    optionalAmount('costPerUnit', { max: MAX_MONEY, label: 'Cost per unit' }),
    optionalText('supplier', 200, { label: 'Supplier' }),
    optionalDate('expiryDate', { label: 'Expiry date' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
    optionalBool('expiryTracking', { label: 'expiryTracking' }),
    optionalAmount('shelfLifeDays', { max: 36500, label: 'Shelf life (days)' }),
];
const inventoryCreate = validate(inventoryFields);
const inventoryUpdate = validate([objectIdParam('id'), ...inventoryFields]);
const inventoryAdjust = validate([
    objectIdParam('id'),
    optionalText('type', 30, { label: 'Type' }),
    optionalAmount('quantity', { max: STOCK_MAX, label: 'Quantity' }),
    optionalText('reason', 500, { label: 'Reason' }),
]);
const inventoryIdOnly = validate([objectIdParam('id')]);
const ingredientRules = (l) => ruleOid(l, 'inventoryItem', false)
    || ruleNum(l, 'quantity', { max: STOCK_MAX })
    || (l.unit != null && typeof l.unit !== 'string' ? 'unit must be text' : null);
const recipeSave = validate([
    optionalObjectId('body', 'menuItemId', 'Invalid menuItemId'),
    lines('ingredients', ingredientRules, { max: 200, label: 'Ingredients' }),
    optionalAmount('yield', { gt: 0, max: 100000, label: 'Yield' }),
    optionalText('notes', 2000, { label: 'Notes' }),
    optionalText('recipeType', 40, { label: 'Recipe type' }),
    optionalAmount('prepLossPercent', { max: 100, label: 'Prep loss %' }),
]);
const recipeDelete = validate([objectIdParam('menuItemId')]);

// ── Halls ───────────────────────────────────────────────────────────────
const hallBody = [
    optionalText('name', 150, { label: 'Name' }),
    optionalText('type', 60, { label: 'Type' }),
    optionalText('description', 5000, { label: 'Description' }),
    optionalAmount('minCapacity', { max: 100000, label: 'Minimum capacity' }),
    optionalAmount('maxCapacity', { max: 100000, label: 'Maximum capacity' }),
    optionalAmount('optimalCapacity', { max: 100000, label: 'Optimal capacity' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];
const hallCreate = validate(hallBody);
const hallUpdate = validate([objectIdParam('id'), ...hallBody]);
const hallIdOnly = validate([objectIdParam('id')]);

// ── Booking catalog: event types, packages, add-ons ─────────────────────
const catalogBody = [
    optionalText('name', 150, { label: 'Name' }),
    optionalText('title', 150, { label: 'Title' }),
    optionalText('description', 5000, { label: 'Description' }),
    optionalAmount('price', { max: MAX_MONEY, label: 'Price' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];
const catalogCreate = validate(catalogBody);
const catalogUpdate = validate([objectIdParam('id'), ...catalogBody]);
const catalogIdOnly = validate([objectIdParam('id')]);

// ── Decoration packages ─────────────────────────────────────────────────
const decorBody = [
    optionalText('name', 150, { label: 'Name' }),
    optionalText('category', 100, { label: 'Category' }),
    optionalText('description', 5000, { label: 'Description' }),
    optionalAmount('basePrice', { max: MAX_MONEY, label: 'Base price' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
];
const decorCreate = validate(decorBody);
const decorUpdate = validate([objectIdParam('id'), ...decorBody]);
const decorIdOnly = validate([objectIdParam('id')]);

// ── Combos ──────────────────────────────────────────────────────────────
const comboBody = [
    optionalText('name', 150, { label: 'Name' }),
    optionalAmount('price', { max: MAX_MONEY, label: 'Price' }),
    optionalAmount('discount', { max: MAX_MONEY, label: 'Discount' }),
    optionalText('discountType', 30, { label: 'Discount type' }),
    optionalObjectId('body', 'branch', 'Invalid branch'),
    optionalArray('categories', { max: 100, label: 'Categories' }),
];
const comboCreate = validate(comboBody);
const comboUpdate = validate([objectIdParam('id'), ...comboBody]);
const comboIdOnly = validate([objectIdParam('id')]);

// ── Captain ─────────────────────────────────────────────────────────────
const captainEscalate = validate([
    optionalText('reason', 1000, { label: 'Reason' }),
    optionalText('orderId', 64, { label: 'orderId' }),
    optionalText('tableName', 100, { label: 'tableName' }),
    optionalText('severity', 20, { label: 'severity' }),
]);

module.exports = {
    orderCreate, orderDeliveryQuote, orderStatus, orderIdOnly, orderDelivery, orderAppend,
    orderCoupon, orderBillSave, orderBillReopen, orderPayment, orderRating,
    orderRepeatItem, orderRepeatAll, orderCleanup,
    shiftNote, shiftHandover,
    areaCreate, areaUpdate, areaIdOnly,
    printTest,
    inventoryCreate, inventoryUpdate, inventoryAdjust, inventoryIdOnly, recipeSave, recipeDelete,
    hallCreate, hallUpdate, hallIdOnly,
    catalogCreate, catalogUpdate, catalogIdOnly,
    decorCreate, decorUpdate, decorIdOnly,
    comboCreate, comboUpdate, comboIdOnly,
    captainEscalate,
};
