/**
 * The ONE bill engine. Pure, dependency-free (no zod, no Node/DOM APIs) so it
 * runs unchanged in the Express backend, the React frontend and React Native.
 *
 * It reproduces, to the paisa, what Backend/utils/billing.js computed when
 * this file was written (the behaviour is frozen by golden-vectors.json).
 * Do NOT "improve" the arithmetic here without regenerating the vectors on
 * purpose and agreeing the change - see README.md.
 *
 * Rules (unchanged from the three copies this replaces):
 *  - GST is levied on max(0, subtotal - coupon); points are a payment method
 *    and never reduce the GST base.
 *  - Service charge applies to dine-in only, on the gross subtotal.
 *  - Additional charges (Flat | Percentage) are on the gross subtotal; a
 *    zero/negative subtotal attracts none; zero-amount charges are dropped.
 *  - total = subtotal + gst + service + additional - coupon - points + tip
 *    + delivery, floored at 0. Tip and delivery fee are outside the tax base.
 *  - There is no tax-inclusive pricing mode: every price is tax-exclusive.
 */
export type OrderType = 'dine-in' | 'takeaway' | 'delivery' | 'kiosk' | (string & {});
/** Order types that attract a service charge. Dine-in only. */
export declare const SERVICE_CHARGE_TYPES: ReadonlySet<string>;
/** Anything a caller may hand us as an amount (strings, null, junk). */
export type NumericInput = number | string | null | undefined;
export interface AdditionalChargeConfig {
    name?: string;
    type?: 'Flat' | 'Percentage' | (string & {});
    value?: NumericInput;
    enabled?: boolean;
}
/** Flat shape computeBill wants (output of toTaxConfig). */
export interface TaxConfigInput {
    gstPct?: NumericInput;
    servicePct?: NumericInput;
    additionalCharges?: AdditionalChargeConfig[];
}
export interface AppliedCharge {
    name: string | undefined;
    type: string | undefined;
    value: number;
    amount: number;
}
export interface ComputeBillInput {
    subtotal?: NumericInput;
    taxConfig?: TaxConfigInput;
    orderType?: string | null;
    couponDiscount?: NumericInput;
    pointsRedeemed?: NumericInput;
    tipAmount?: NumericInput;
    deliveryFee?: NumericInput;
}
export interface ComputedBill {
    subtotal: number;
    gst: number;
    gstPct: number;
    serviceCharge: number;
    serviceChargePct: number;
    serviceChargeApplies: boolean;
    additionalCharges: AppliedCharge[];
    additionalChargesTotal: number;
    couponDiscount: number;
    pointsRedeemed: number;
    tipAmount: number;
    deliveryFee: number;
    total: number;
}
/** Settings.taxes sub-document (see TaxesSettingsSchema). */
export interface TaxesSettingsInput {
    gst?: {
        enabled?: boolean;
        value?: NumericInput;
    } | null;
    serviceCharge?: {
        enabled?: boolean;
        value?: NumericInput;
    } | null;
    additionalCharges?: AdditionalChargeConfig[] | null;
}
export declare function num(v: unknown): number;
export declare function round2(n: unknown): number;
/** Normalise the order-type spellings in play across the codebase. */
export declare function normaliseOrderType(orderType?: string | null): string;
/** Flatten a Settings.taxes sub-document; disabled charges are dropped. */
export declare function toTaxConfig(taxes?: TaxesSettingsInput | null): Required<TaxConfigInput>;
export declare function computeBill(input?: ComputeBillInput): ComputedBill;
