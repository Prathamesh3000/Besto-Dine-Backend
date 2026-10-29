/* eslint-disable */
/* Generated from packages/types - do not edit. */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthSessionSchema = exports.AuthUserSchema = exports.UserRoleSchema = exports.USER_ROLES = exports.OrderSchema = exports.OrderTypeSchema = exports.BillSchema = exports.PaymentStatusSchema = exports.PAYMENT_STATUSES = exports.OrderStatusSchema = exports.ORDER_STATUSES = exports.OrderItemSchema = exports.TaxConfigSchema = exports.TaxesSettingsSchema = exports.AdditionalChargeSchema = exports.PaymentSchema = exports.TenderSchema = exports.PaymentMethodSchema = exports.PAYMENT_METHODS = void 0;
/**
 * Zod schemas + inferred types, derived from Backend/models/order.js,
 * Backend/models/user.js and the API payloads. Legacy documents lack many
 * fields, so everything that is not guaranteed on every stored document is
 * optional. Object ids and dates travel as strings over JSON; the schemas
 * accept either a string or a Date for dates.
 *
 * Objects use .passthrough(): the real documents carry many more fields than
 * are modelled here and the schemas must not strip them.
 *
 * NOTE: this file needs `zod` at runtime. The bill engine (engine.ts) does
 * not - apps that have no zod installed import only the engine entry.
 */
const zod_1 = require("zod");
const objectId = zod_1.z.string();
const dateLike = zod_1.z.union([zod_1.z.string(), zod_1.z.date()]);
exports.PAYMENT_METHODS = ['cash', 'upi', 'card', 'wallet', 'razorpay', 'other'];
exports.PaymentMethodSchema = zod_1.z.enum(exports.PAYMENT_METHODS);
/** One tender line: what was collected, by which method (Order.payments[]). */
exports.TenderSchema = zod_1.z.object({
    method: exports.PaymentMethodSchema,
    amount: zod_1.z.number().min(0),
    reference: zod_1.z.string().max(80).optional(),
    receivedBy: objectId.nullable().optional(),
    at: dateLike.optional(),
    source: zod_1.z.string().max(30).optional(),
}).passthrough();
exports.PaymentSchema = exports.TenderSchema;
exports.AdditionalChargeSchema = zod_1.z.object({
    name: zod_1.z.string().optional(),
    type: zod_1.z.enum(['Flat', 'Percentage']).optional(),
    value: zod_1.z.number().optional(),
    amount: zod_1.z.number().optional(),
}).passthrough();
const AdditionalChargeConfigSchema = exports.AdditionalChargeSchema.extend({ enabled: zod_1.z.boolean().optional() });
/** Settings.taxes (the editable tax configuration). */
exports.TaxesSettingsSchema = zod_1.z.object({
    gst: zod_1.z.object({ enabled: zod_1.z.boolean().optional(), value: zod_1.z.number().optional() }).passthrough().nullable().optional(),
    serviceCharge: zod_1.z.object({ enabled: zod_1.z.boolean().optional(), value: zod_1.z.number().optional() }).passthrough().nullable().optional(),
    additionalCharges: zod_1.z.array(AdditionalChargeConfigSchema).nullable().optional(),
}).passthrough();
/** Flat tax config consumed by computeBill (output of toTaxConfig). */
exports.TaxConfigSchema = zod_1.z.object({
    gstPct: zod_1.z.number(),
    servicePct: zod_1.z.number(),
    additionalCharges: zod_1.z.array(AdditionalChargeConfigSchema),
}).passthrough();
exports.OrderItemSchema = zod_1.z.object({
    _id: objectId.optional(),
    menuItem: zod_1.z.string().optional(),
    name: zod_1.z.string(),
    price: zod_1.z.number(),
    quantity: zod_1.z.number().default(1),
    category: zod_1.z.string().optional(),
    vegType: zod_1.z.enum(['veg', 'non-veg', '']).optional(),
    categoryKind: zod_1.z.enum(['food', 'beverages', '']).optional(),
    prepStation: zod_1.z.enum(['kitchen', 'bar', 'counter']).optional(),
    prepTimeMinutes: zod_1.z.number().min(0).optional(),
    selectedSizes: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string().optional(), name: zod_1.z.string().optional(), priceDetails: zod_1.z.unknown().optional() }).passthrough()).optional(),
    selectedToppings: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string().optional(), name: zod_1.z.string().optional(), price: zod_1.z.number().optional() }).passthrough()).optional(),
    instructions: zod_1.z.string().optional(),
    addedAt: dateLike.optional(),
    kotNo: zod_1.z.number().min(1).optional(),
}).passthrough();
exports.ORDER_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served', 'cancelled'];
exports.OrderStatusSchema = zod_1.z.enum(exports.ORDER_STATUSES);
exports.PAYMENT_STATUSES = ['Pending', 'Partially Paid', 'Paid', 'Refunded'];
exports.PaymentStatusSchema = zod_1.z.enum(exports.PAYMENT_STATUSES);
/** Order.bill - the counter-side bill sub-document. */
exports.BillSchema = zod_1.z.object({
    status: zod_1.z.enum(['draft', 'final']).optional(),
    billNo: zod_1.z.number().nullable().optional(),
    /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
    financialYear: zod_1.z.string().nullable().optional(),
    savedAt: dateLike.nullable().optional(),
    savedBy: objectId.nullable().optional(),
    reopenedAt: dateLike.nullable().optional(),
    reopenedBy: objectId.nullable().optional(),
    reopenReason: zod_1.z.string().max(300).optional(),
    total: zod_1.z.number().optional(),
    history: zod_1.z.array(zod_1.z.object({
        action: zod_1.z.enum(['save', 'finalize', 'reopen']).optional(),
        at: dateLike.optional(),
        by: objectId.optional(),
        reason: zod_1.z.string().optional(),
        total: zod_1.z.number().optional(),
    }).passthrough()).optional(),
}).passthrough();
exports.OrderTypeSchema = zod_1.z.enum(['dine-in', 'takeaway']);
exports.OrderSchema = zod_1.z.object({
    _id: objectId.optional(),
    restaurant: objectId,
    branch: objectId.nullable().optional(),
    orderId: zod_1.z.string(),
    type: exports.OrderTypeSchema.optional(),
    source: zod_1.z.enum(['web-customer', 'qr-scan', 'kiosk', 'staff', 'pos', 'admin']).optional(),
    user: objectId.optional(),
    customerName: zod_1.z.string().optional(),
    phone: zod_1.z.string().optional(),
    table: objectId.optional(),
    tokenNumber: zod_1.z.string().optional(),
    items: zod_1.z.array(exports.OrderItemSchema),
    total: zod_1.z.number().min(0),
    gst: zod_1.z.number().min(0).optional(),
    gstPercentage: zod_1.z.number().min(0).max(100).optional(),
    serviceCharge: zod_1.z.number().min(0).optional(),
    serviceChargePercentage: zod_1.z.number().min(0).max(100).optional(),
    additionalCharges: zod_1.z.array(exports.AdditionalChargeSchema).optional(),
    additionalChargesTotal: zod_1.z.number().min(0).optional(),
    couponDiscount: zod_1.z.number().optional(),
    manualDiscount: zod_1.z.number().optional(),
    pointsRedeemed: zod_1.z.number().optional(),
    tipAmount: zod_1.z.number().optional(),
    delivery: zod_1.z.object({
        requested: zod_1.z.boolean().optional(),
        fee: zod_1.z.number().min(0).optional(),
    }).passthrough().optional(),
    status: exports.OrderStatusSchema.optional(),
    paymentStatus: exports.PaymentStatusSchema.optional(),
    paymentMethod: zod_1.z.string().optional(),
    amountPaid: zod_1.z.number().min(0).optional(),
    walletAmountPaid: zod_1.z.number().min(0).optional(),
    /** Per-tender lines; absent on legacy orders (derive from paymentMethod/amountPaid). */
    payments: zod_1.z.array(exports.TenderSchema).optional(),
    bill: exports.BillSchema.optional(),
    note: zod_1.z.string().max(500).optional(),
    createdAt: dateLike.optional(),
    updatedAt: dateLike.optional(),
}).passthrough();
exports.USER_ROLES = ['customer', 'admin', 'manager', 'chef', 'waiter', 'captain', 'superadmin'];
exports.UserRoleSchema = zod_1.z.enum(exports.USER_ROLES);
/** The user object the API returns to clients (never carries the password). */
exports.AuthUserSchema = zod_1.z.object({
    _id: objectId.optional(),
    id: objectId.optional(),
    name: zod_1.z.string(),
    email: zod_1.z.string().optional(),
    mobile: zod_1.z.string().optional(),
    role: exports.UserRoleSchema,
    superadminLevel: zod_1.z.enum(['', 'full', 'support']).optional(),
    restaurant: objectId.nullable().optional(),
    branch: objectId.nullable().optional(),
    isTenantOwner: zod_1.z.boolean().optional(),
    permissions: zod_1.z.unknown().optional(),
    authProviders: zod_1.z.array(zod_1.z.enum(['password', 'google'])).optional(),
}).passthrough();
/** Login / session response shape. */
exports.AuthSessionSchema = zod_1.z.object({
    token: zod_1.z.string(),
    user: exports.AuthUserSchema,
}).passthrough();
