/**
 * Stable, allow-listed JSON shapes for the public API and webhook
 * payloads. Fields are picked explicitly — never spread a document — so
 * internal fields (tokens, hashes, idempotency keys, guest access, user
 * ids, other tenants' ids) can never leak by accident, and a schema change
 * cannot silently change the public contract.
 */
'use strict';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const idStr = (v) => (v ? String(v._id || v) : null);

function serializeOrder(o) {
    if (!o) return null;
    return {
        id: o.orderId,
        type: o.type || null,
        source: o.source || null,
        status: o.status,
        payment_status: o.paymentStatus,
        payment_method: o.paymentMethod || null,
        branch_id: idStr(o.branch),
        table_id: idStr(o.table),
        token_number: o.tokenNumber || null,
        customer_name: o.customerName || null,
        items: (o.items || []).map((i) => ({
            name: i.name,
            quantity: num(i.quantity),
            price: num(i.price),
            category: i.category || null,
        })),
        total: num(o.total),
        gst: num(o.gst),
        service_charge: num(o.serviceCharge),
        additional_charges_total: num(o.additionalChargesTotal),
        amount_paid: num(o.amountPaid),
        refunded_amount: num(o.refundedAmount),
        cancel_reason: o.cancelReason || null,
        created_at: iso(o.createdAt),
        paid_at: iso(o.paidAt),
        cancelled_at: iso(o.cancelledAt),
    };
}

function serializeMenuItem(m, categoryName = null) {
    if (!m) return null;
    return {
        id: idStr(m._id),
        name: m.name,
        category_id: idStr(m.category),
        category: categoryName,
        description: m.description || '',
        veg_type: m.vegType || null,
        base_price: num(m.basePrice),
        offer_percentage: num(m.offerPercentage),
        final_price: num(m.finalPrice != null ? m.finalPrice : m.basePrice),
        unit: m.unit || null,
        in_stock: m.inStock !== false,
        branch_id: idStr(m.branch),
        images: Array.isArray(m.images) ? m.images.slice(0, 5) : [],
        sizes: (m.sizes || []).map((s) => ({ name: s.name, price: num(s.price) })),
    };
}

function serializeInventoryItem(i) {
    if (!i) return null;
    return {
        id: i.itemId,
        name: i.name,
        category: i.category,
        unit: i.unit,
        current_stock: num(i.currentStock),
        min_stock: num(i.minStock),
        status: i.status,
        branch_id: idStr(i.branch),
        updated_at: iso(i.updatedAt),
    };
}

function serializeBooking(b) {
    if (!b) return null;
    return {
        id: b.bookingId,
        type: b.bookingType || 'table',
        status: b.status,
        date: iso(b.bookingDate),
        time: b.bookingTime || null,
        time_slot: b.timeSlot || null,
        guest_count: num(b.guestCount),
        special_event: b.specialEvent || null,
        branch_id: idStr(b.branch),
        created_at: iso(b.createdAt),
    };
}

module.exports = { serializeOrder, serializeMenuItem, serializeInventoryItem, serializeBooking };
