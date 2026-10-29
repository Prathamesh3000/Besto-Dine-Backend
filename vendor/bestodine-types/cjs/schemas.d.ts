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
export declare const PAYMENT_METHODS: readonly ["cash", "upi", "card", "wallet", "razorpay", "other"];
export declare const PaymentMethodSchema: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
/** One tender line: what was collected, by which method (Order.payments[]). */
export declare const TenderSchema: z.ZodObject<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
export type Tender = z.infer<typeof TenderSchema>;
export declare const PaymentSchema: z.ZodObject<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
    amount: z.ZodNumber;
    reference: z.ZodOptional<z.ZodString>;
    receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    source: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
export type Payment = Tender;
export declare const AdditionalChargeSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
    value: z.ZodOptional<z.ZodNumber>;
    amount: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    name: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
    value: z.ZodOptional<z.ZodNumber>;
    amount: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    name: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
    value: z.ZodOptional<z.ZodNumber>;
    amount: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
export type AdditionalCharge = z.infer<typeof AdditionalChargeSchema>;
/** Settings.taxes (the editable tax configuration). */
export declare const TaxesSettingsSchema: z.ZodObject<{
    gst: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    serviceCharge: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    additionalCharges: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    gst: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    serviceCharge: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    additionalCharges: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    gst: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    serviceCharge: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        value: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>>;
    additionalCharges: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">>>;
}, z.ZodTypeAny, "passthrough">>;
export type TaxesSettings = z.infer<typeof TaxesSettingsSchema>;
/** Flat tax config consumed by computeBill (output of toTaxConfig). */
export declare const TaxConfigSchema: z.ZodObject<{
    gstPct: z.ZodNumber;
    servicePct: z.ZodNumber;
    additionalCharges: z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    gstPct: z.ZodNumber;
    servicePct: z.ZodNumber;
    additionalCharges: z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    gstPct: z.ZodNumber;
    servicePct: z.ZodNumber;
    additionalCharges: z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    } & {
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
}, z.ZodTypeAny, "passthrough">>;
export type TaxConfig = z.infer<typeof TaxConfigSchema>;
export declare const OrderItemSchema: z.ZodObject<{
    _id: z.ZodOptional<z.ZodString>;
    menuItem: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    price: z.ZodNumber;
    quantity: z.ZodDefault<z.ZodNumber>;
    category: z.ZodOptional<z.ZodString>;
    vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
    categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
    prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
    prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
    selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    instructions: z.ZodOptional<z.ZodString>;
    addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    kotNo: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    _id: z.ZodOptional<z.ZodString>;
    menuItem: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    price: z.ZodNumber;
    quantity: z.ZodDefault<z.ZodNumber>;
    category: z.ZodOptional<z.ZodString>;
    vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
    categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
    prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
    prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
    selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    instructions: z.ZodOptional<z.ZodString>;
    addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    kotNo: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    _id: z.ZodOptional<z.ZodString>;
    menuItem: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    price: z.ZodNumber;
    quantity: z.ZodDefault<z.ZodNumber>;
    category: z.ZodOptional<z.ZodString>;
    vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
    categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
    prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
    prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
    selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        priceDetails: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        price: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    instructions: z.ZodOptional<z.ZodString>;
    addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    kotNo: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
export declare const ORDER_STATUSES: readonly ["awaiting-payment", "new", "preparing", "ready", "served", "cancelled"];
export declare const OrderStatusSchema: z.ZodEnum<["awaiting-payment", "new", "preparing", "ready", "served", "cancelled"]>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export declare const PAYMENT_STATUSES: readonly ["Pending", "Partially Paid", "Paid", "Refunded"];
export declare const PaymentStatusSchema: z.ZodEnum<["Pending", "Partially Paid", "Paid", "Refunded"]>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
/** Order.bill - the counter-side bill sub-document. */
export declare const BillSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
    billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
    financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenReason: z.ZodOptional<z.ZodString>;
    total: z.ZodOptional<z.ZodNumber>;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
    billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
    financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenReason: z.ZodOptional<z.ZodString>;
    total: z.ZodOptional<z.ZodNumber>;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
    billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
    financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
    reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    reopenReason: z.ZodOptional<z.ZodString>;
    total: z.ZodOptional<z.ZodNumber>;
    history: z.ZodOptional<z.ZodArray<z.ZodObject<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        by: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
}, z.ZodTypeAny, "passthrough">>;
export type Bill = z.infer<typeof BillSchema>;
export declare const OrderTypeSchema: z.ZodEnum<["dine-in", "takeaway"]>;
export declare const OrderSchema: z.ZodObject<{
    _id: z.ZodOptional<z.ZodString>;
    restaurant: z.ZodString;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    orderId: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["dine-in", "takeaway"]>>;
    source: z.ZodOptional<z.ZodEnum<["web-customer", "qr-scan", "kiosk", "staff", "pos", "admin"]>>;
    user: z.ZodOptional<z.ZodString>;
    customerName: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
    table: z.ZodOptional<z.ZodString>;
    tokenNumber: z.ZodOptional<z.ZodString>;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    total: z.ZodNumber;
    gst: z.ZodOptional<z.ZodNumber>;
    gstPercentage: z.ZodOptional<z.ZodNumber>;
    serviceCharge: z.ZodOptional<z.ZodNumber>;
    serviceChargePercentage: z.ZodOptional<z.ZodNumber>;
    additionalCharges: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    additionalChargesTotal: z.ZodOptional<z.ZodNumber>;
    couponDiscount: z.ZodOptional<z.ZodNumber>;
    manualDiscount: z.ZodOptional<z.ZodNumber>;
    pointsRedeemed: z.ZodOptional<z.ZodNumber>;
    tipAmount: z.ZodOptional<z.ZodNumber>;
    delivery: z.ZodOptional<z.ZodObject<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>;
    status: z.ZodOptional<z.ZodEnum<["awaiting-payment", "new", "preparing", "ready", "served", "cancelled"]>>;
    paymentStatus: z.ZodOptional<z.ZodEnum<["Pending", "Partially Paid", "Paid", "Refunded"]>>;
    paymentMethod: z.ZodOptional<z.ZodString>;
    amountPaid: z.ZodOptional<z.ZodNumber>;
    walletAmountPaid: z.ZodOptional<z.ZodNumber>;
    /** Per-tender lines; absent on legacy orders (derive from paymentMethod/amountPaid). */
    payments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    bill: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
    note: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    updatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    _id: z.ZodOptional<z.ZodString>;
    restaurant: z.ZodString;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    orderId: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["dine-in", "takeaway"]>>;
    source: z.ZodOptional<z.ZodEnum<["web-customer", "qr-scan", "kiosk", "staff", "pos", "admin"]>>;
    user: z.ZodOptional<z.ZodString>;
    customerName: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
    table: z.ZodOptional<z.ZodString>;
    tokenNumber: z.ZodOptional<z.ZodString>;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    total: z.ZodNumber;
    gst: z.ZodOptional<z.ZodNumber>;
    gstPercentage: z.ZodOptional<z.ZodNumber>;
    serviceCharge: z.ZodOptional<z.ZodNumber>;
    serviceChargePercentage: z.ZodOptional<z.ZodNumber>;
    additionalCharges: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    additionalChargesTotal: z.ZodOptional<z.ZodNumber>;
    couponDiscount: z.ZodOptional<z.ZodNumber>;
    manualDiscount: z.ZodOptional<z.ZodNumber>;
    pointsRedeemed: z.ZodOptional<z.ZodNumber>;
    tipAmount: z.ZodOptional<z.ZodNumber>;
    delivery: z.ZodOptional<z.ZodObject<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>;
    status: z.ZodOptional<z.ZodEnum<["awaiting-payment", "new", "preparing", "ready", "served", "cancelled"]>>;
    paymentStatus: z.ZodOptional<z.ZodEnum<["Pending", "Partially Paid", "Paid", "Refunded"]>>;
    paymentMethod: z.ZodOptional<z.ZodString>;
    amountPaid: z.ZodOptional<z.ZodNumber>;
    walletAmountPaid: z.ZodOptional<z.ZodNumber>;
    /** Per-tender lines; absent on legacy orders (derive from paymentMethod/amountPaid). */
    payments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    bill: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
    note: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    updatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    _id: z.ZodOptional<z.ZodString>;
    restaurant: z.ZodString;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    orderId: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["dine-in", "takeaway"]>>;
    source: z.ZodOptional<z.ZodEnum<["web-customer", "qr-scan", "kiosk", "staff", "pos", "admin"]>>;
    user: z.ZodOptional<z.ZodString>;
    customerName: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
    table: z.ZodOptional<z.ZodString>;
    tokenNumber: z.ZodOptional<z.ZodString>;
    items: z.ZodArray<z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        menuItem: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
        category: z.ZodOptional<z.ZodString>;
        vegType: z.ZodOptional<z.ZodEnum<["veg", "non-veg", ""]>>;
        categoryKind: z.ZodOptional<z.ZodEnum<["food", "beverages", ""]>>;
        prepStation: z.ZodOptional<z.ZodEnum<["kitchen", "bar", "counter"]>>;
        prepTimeMinutes: z.ZodOptional<z.ZodNumber>;
        selectedSizes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            priceDetails: z.ZodOptional<z.ZodUnknown>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        selectedToppings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
            price: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        instructions: z.ZodOptional<z.ZodString>;
        addedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        kotNo: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    total: z.ZodNumber;
    gst: z.ZodOptional<z.ZodNumber>;
    gstPercentage: z.ZodOptional<z.ZodNumber>;
    serviceCharge: z.ZodOptional<z.ZodNumber>;
    serviceChargePercentage: z.ZodOptional<z.ZodNumber>;
    additionalCharges: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["Flat", "Percentage"]>>;
        value: z.ZodOptional<z.ZodNumber>;
        amount: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    additionalChargesTotal: z.ZodOptional<z.ZodNumber>;
    couponDiscount: z.ZodOptional<z.ZodNumber>;
    manualDiscount: z.ZodOptional<z.ZodNumber>;
    pointsRedeemed: z.ZodOptional<z.ZodNumber>;
    tipAmount: z.ZodOptional<z.ZodNumber>;
    delivery: z.ZodOptional<z.ZodObject<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        requested: z.ZodOptional<z.ZodBoolean>;
        fee: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">>>;
    status: z.ZodOptional<z.ZodEnum<["awaiting-payment", "new", "preparing", "ready", "served", "cancelled"]>>;
    paymentStatus: z.ZodOptional<z.ZodEnum<["Pending", "Partially Paid", "Paid", "Refunded"]>>;
    paymentMethod: z.ZodOptional<z.ZodString>;
    amountPaid: z.ZodOptional<z.ZodNumber>;
    walletAmountPaid: z.ZodOptional<z.ZodNumber>;
    /** Per-tender lines; absent on legacy orders (derive from paymentMethod/amountPaid). */
    payments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        method: z.ZodEnum<["cash", "upi", "card", "wallet", "razorpay", "other"]>;
        amount: z.ZodNumber;
        reference: z.ZodOptional<z.ZodString>;
        receivedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
        source: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    bill: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        status: z.ZodOptional<z.ZodEnum<["draft", "final"]>>;
        billNo: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        /** Indian FY the billNo counter belongs to, e.g. '2026-27'; null/absent on pre-FY bills. */
        financialYear: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        savedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        savedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenedAt: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodDate]>>>;
        reopenedBy: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        reopenReason: z.ZodOptional<z.ZodString>;
        total: z.ZodOptional<z.ZodNumber>;
        history: z.ZodOptional<z.ZodArray<z.ZodObject<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            action: z.ZodOptional<z.ZodEnum<["save", "finalize", "reopen"]>>;
            at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
            by: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
            total: z.ZodOptional<z.ZodNumber>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
    note: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    updatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
}, z.ZodTypeAny, "passthrough">>;
export type Order = z.infer<typeof OrderSchema>;
export declare const USER_ROLES: readonly ["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"];
export declare const UserRoleSchema: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
export type UserRole = z.infer<typeof UserRoleSchema>;
/** The user object the API returns to clients (never carries the password). */
export declare const AuthUserSchema: z.ZodObject<{
    _id: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    mobile: z.ZodOptional<z.ZodString>;
    role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
    superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
    restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isTenantOwner: z.ZodOptional<z.ZodBoolean>;
    permissions: z.ZodOptional<z.ZodUnknown>;
    authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    _id: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    mobile: z.ZodOptional<z.ZodString>;
    role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
    superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
    restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isTenantOwner: z.ZodOptional<z.ZodBoolean>;
    permissions: z.ZodOptional<z.ZodUnknown>;
    authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    _id: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    mobile: z.ZodOptional<z.ZodString>;
    role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
    superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
    restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isTenantOwner: z.ZodOptional<z.ZodBoolean>;
    permissions: z.ZodOptional<z.ZodUnknown>;
    authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
}, z.ZodTypeAny, "passthrough">>;
export type AuthUser = z.infer<typeof AuthUserSchema>;
/** Login / session response shape. */
export declare const AuthSessionSchema: z.ZodObject<{
    token: z.ZodString;
    user: z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    token: z.ZodString;
    user: z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    token: z.ZodString;
    user: z.ZodObject<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        _id: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        mobile: z.ZodOptional<z.ZodString>;
        role: z.ZodEnum<["customer", "admin", "manager", "chef", "waiter", "captain", "superadmin"]>;
        superadminLevel: z.ZodOptional<z.ZodEnum<["", "full", "support"]>>;
        restaurant: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isTenantOwner: z.ZodOptional<z.ZodBoolean>;
        permissions: z.ZodOptional<z.ZodUnknown>;
        authProviders: z.ZodOptional<z.ZodArray<z.ZodEnum<["password", "google"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>;
}, z.ZodTypeAny, "passthrough">>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
