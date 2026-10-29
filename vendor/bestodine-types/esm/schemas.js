/* eslint-disable */
/* Generated from packages/types - do not edit. */
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
import { z } from 'zod';
const objectId = z.string();
const dateLike = z.union([z.string(), z.date()]);
export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'wallet', 'razorpay', 'other'];
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
/** One tender line: what was collected, by which method (Order.payments[]). */
export const TenderSchema = z.object({
    method: PaymentMethodSchema,
    amount: z.number().min(0),
    reference: z.string().max(80).optional(),
    receivedBy: objectId.nullable().optional(),
    at: dateLike.optional(),
    source: z.string().max(30).optional(),
}).passthrough();
export const PaymentSchema = TenderSchema;
export const AdditionalChargeSchema = z.object({
    name: z.string().optional(),
    type: z.enum(['Flat', 'Percentage']).optional(),
    value: z.number().optional(),
    amount: z.number().optional(),
}).passthrough();
const AdditionalChargeConfigSchema = AdditionalChargeSchema.extend({ enabled: z.boolean().optional() });
/** Settings.taxes (the editable tax configuration). */
export const TaxesSettingsSchema = z.object({
    gst: z.object({ enabled: z.boolean().optional(), value: z.number().optional() }).passthrough().nullable().optional(),
    serviceCharge: z.object({ enabled: z.boolean().optional(), value: z.number().optional() }).passthrough().nullable().optional(),
    additionalCharges: z.array(AdditionalChargeConfigSchema).nullable().optional(),
}).passthrough();
/** Flat tax config consumed by computeBill (output of toTaxConfig). */
export const TaxConfigSchema = z.object({
    gstPct: z.number(),
    servicePct: z.number(),
    additionalCharges: z.array(AdditionalChargeConfigSchema),
}).passthrough();
export const OrderItemSchema = z.object({
    _id: objectId.optional(),
    menuItem: z.string().optional(),
    name: z.string(),
    price: z.number(),
    quantity: z.number().default(1),
    category: z.string().optional(),
    vegType: z.enum(['veg', 'non-veg', '']).optional(),
    categoryKind: z.enum(['food', 'beverages', '']).optional(),
    prepStation: z.enum(['kitchen', 'bar', 'counter']).optional(),
    prepTimeMinutes: z.number().min(0).optional(),
    selectedSizes: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), priceDetails: z.unknown().optional() }).passthrough()).optional(),
    selectedToppings: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), price: z.number().optional() }).passthrough()).optional(),
    instructions: z.string().optional(),
    addedAt: dateLike.optional(),
    kotNo: z.number().min(1).optional(),
}).passthrough();
export const ORDER_STATUSES = ['awaiting-payment', 'new', 'preparing', 'ready', 'served', 'cancelled'];
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export const PAYMENT_STATUSES = ['Pending', 'Partially Paid', 'Paid', 'Refunded'];
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
/** Order.bill - the counter-side bill sub-document. */
export const BillSchema = z.object({
    status: z.enum(['draft', 'final']).optional(),
    billNo: z.number().nullable().optional(),
    /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
    financialYear: z.string().nullable().optional(),
    savedAt: dateLike.nullable().optional(),
    savedBy: objectId.nullable().optional(),
    reopenedAt: dateLike.nullable().optional(),
    reopenedBy: objectId.nullable().optional(),
    reopenReason: z.string().max(300).optional(),
    total: z.number().optional(),
    history: z.array(z.object({
        action: z.enum(['save', 'finalize', 'reopen']).optional(),
        at: dateLike.optional(),
        by: objectId.optional(),
        reason: z.string().optional(),
        total: z.number().optional(),
    }).passthrough()).optional(),
}).passthrough();
export const OrderTypeSchema = z.enum(['dine-in', 'takeaway']);
export const OrderSchema = z.object({
    _id: objectId.optional(),
    restaurant: objectId,
    branch: objectId.nullable().optional(),
    orderId: z.string(),
    type: OrderTypeSchema.optional(),
    source: z.enum(['web-customer', 'qr-scan', 'kiosk', 'staff', 'pos', 'admin']).optional(),
    user: objectId.optional(),
    customerName: z.string().optional(),
    phone: z.string().optional(),
    table: objectId.optional(),
    tokenNumber: z.string().optional(),
    items: z.array(OrderItemSchema),
    total: z.number().min(0),
    gst: z.number().min(0).optional(),
    gstPercentage: z.number().min(0).max(100).optional(),
    serviceCharge: z.number().min(0).optional(),
    serviceChargePercentage: z.number().min(0).max(100).optional(),
    additionalCharges: z.array(AdditionalChargeSchema).optional(),
    additionalChargesTotal: z.number().min(0).optional(),
    couponDiscount: z.number().optional(),
    manualDiscount: z.number().optional(),
    pointsRedeemed: z.number().optional(),
    tipAmount: z.number().optional(),
    delivery: z.object({
        requested: z.boolean().optional(),
        fee: z.number().min(0).optional(),
    }).passthrough().optional(),
    status: OrderStatusSchema.optional(),
    paymentStatus: PaymentStatusSchema.optional(),
    paymentMethod: z.string().optional(),
    amountPaid: z.number().min(0).optional(),
    walletAmountPaid: z.number().min(0).optional(),
    /** Per-tender lines; absent on legacy orders (derive from paymentMethod/amountPaid). */
    payments: z.array(TenderSchema).optional(),
    bill: BillSchema.optional(),
    note: z.string().max(500).optional(),
    createdAt: dateLike.optional(),
    updatedAt: dateLike.optional(),
}).passthrough();
export const USER_ROLES = ['customer', 'admin', 'manager', 'chef', 'waiter', 'captain', 'superadmin'];
export const UserRoleSchema = z.enum(USER_ROLES);
/** The user object the API returns to clients (never carries the password). */
export const AuthUserSchema = z.object({
    _id: objectId.optional(),
    id: objectId.optional(),
    name: z.string(),
    email: z.string().optional(),
    mobile: z.string().optional(),
    role: UserRoleSchema,
    superadminLevel: z.enum(['', 'full', 'support']).optional(),
    restaurant: objectId.nullable().optional(),
    branch: objectId.nullable().optional(),
    isTenantOwner: z.boolean().optional(),
    permissions: z.unknown().optional(),
    authProviders: z.array(z.enum(['password', 'google'])).optional(),
}).passthrough();
/** Login / session response shape. */
export const AuthSessionSchema = z.object({
    token: z.string(),
    user: AuthUserSchema,
}).passthrough();
