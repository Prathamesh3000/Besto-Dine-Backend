/**
 * orderTenderService — staff split-tender settlement (Plan task 2.3).
 *
 * resolveTenderedBody turns `payments: [{ method, amount, reference? }]` on
 * PATCH /orders/:id/status into the legacy body fields applyPaymentFields
 * already understands (paymentStatus / paymentMethod / amountPaid), and
 * returns the full payments[] to persist plus the cumulative amountPaid.
 * Manual discount / tip / overpayment semantics stay with applyPaymentFields.
 */
const Order = require('../models/order');
const { httpError } = require('./orderErrors');
const {
  getTenders, sumTenders, summarizeTenders, parseCounterTenders, round2,
} = require('../utils/tenders');

const BILLING_ROLES = ['captain', 'admin', 'manager'];
// Same ₹1 settle tolerance as the single-method flow.
const PAID_TOLERANCE = 1;

function resolveTenderedBody(oldOrder, body, { userId = null, role = null, siblingDue = 0 } = {}) {
  if (!BILLING_ROLES.includes(role)) {
    throw httpError(403, { success: false, code: 'BILLING_CAPTAIN_ONLY', message: 'Billing and payment are handled by the captain' });
  }
  const parsed = parseCounterTenders(body.payments);
  if (parsed.error) throw httpError(400, { success: false, ...parsed.error });
  if (oldOrder.paymentStatus === 'Paid' || oldOrder.paymentStatus === 'Refunded') {
    throw httpError(400, { success: false, code: 'ALREADY_PAID', message: 'This order is already settled.' });
  }
  const askedStatus = body.paymentStatus;
  if (askedStatus !== undefined && askedStatus !== 'Paid' && askedStatus !== 'Partially Paid') {
    throw httpError(400, { success: false, code: 'INVALID_PAYMENT_STATUS', message: "With payments, paymentStatus must be 'Paid' or 'Partially Paid'." });
  }

  const effDiscount = body.manualDiscount !== undefined && Number.isFinite(Number(body.manualDiscount))
    ? Math.max(0, Number(body.manualDiscount)) : Math.max(0, Number(oldOrder.manualDiscount) || 0);
  const alreadyPaid = Math.max(0, Number(oldOrder.amountPaid) || 0);
  const due = round2(Math.max(0, (Number(oldOrder.total) || 0) - effDiscount - alreadyPaid));
  const oldTip = Math.max(0, Number(oldOrder.tipAmount) || 0);
  const extraTip = body.tipAmount !== undefined && Number.isFinite(Number(body.tipAmount))
    ? Math.max(0, Number(body.tipAmount) - oldTip) : 0;
  // siblingDue: the table's other unpaid rounds, settled together with this one.
  const required = round2(due + extraTip + Math.max(0, Number(siblingDue) || 0));

  const newSum = sumTenders(parsed.lines);
  const cashSum = sumTenders(parsed.lines.filter((l) => l.method === 'cash'));
  const covers = newSum >= required - PAID_TOLERANCE;

  if (askedStatus === 'Paid' && !covers) {
    throw httpError(400, {
      success: false,
      code: 'AMOUNT_TOO_LOW',
      message: `Payments total ₹${newSum.toFixed(2)} is less than the amount due ₹${required.toFixed(2)}. `
        + 'Marking an order Paid cannot reduce the bill — use the Discount option to give a discount, then settle.',
      amountDue: required,
    });
  }
  // Change can only be given back out of cash.
  const excess = round2(Math.max(0, newSum - required));
  if (excess > 0.01 && excess > cashSum + 0.01) {
    throw httpError(400, {
      success: false,
      code: 'OVERPAYMENT_NOT_CASH',
      message: `Payments total ₹${newSum.toFixed(2)} exceeds the amount due ₹${required.toFixed(2)} by more than the cash given.`,
      amountDue: required,
    });
  }

  const at = new Date();
  const priorLines = getTenders(oldOrder).map((l) => ({
    method: l.method, amount: l.amount, reference: l.reference, receivedBy: l.receivedBy, at: l.at || at, source: l.source || 'legacy',
  }));
  const newLines = parsed.lines.map((l) => ({ ...l, receivedBy: userId || null, at, source: 'counter' }));
  const all = [...priorLines, ...newLines];
  const summary = summarizeTenders(all, { due: round2(alreadyPaid + due + extraTip) });

  return {
    // Fed to applyPaymentFields in place of the raw body. amountPaid here is
    // the money collected NOW (the single-method meaning); the cumulative
    // figure is `amountPaid` below.
    body: {
      ...body,
      paymentStatus: covers ? 'Paid' : 'Partially Paid',
      paymentMethod: summary.method,
      amountPaid: newSum,
    },
    payments: all,
    amountPaid: summary.amountPaid,
    cashReceived: cashSum > 0 ? cashSum : null,
    changeDue: cashSum > 0 ? excess : null,
    covers,
  };
}

/**
 * What the table's OTHER unpaid dine-in rounds still owe. A dine-in settle
 * clears the whole table (settleSiblingDineInRounds), so the tenders must
 * cover them too. Mirrors that function's sibling query / pay-first rule.
 */
async function siblingDueFor(req, oldOrder, tf) {
  if (oldOrder.type !== 'dine-in' || !oldOrder.table || oldOrder.holdReason) return 0;
  const { resolveOperations, orderIsPayFirst } = require('../utils/operationsProfile');
  const ops = req.restaurant ? resolveOperations(req.restaurant) : null;
  if (orderIsPayFirst(oldOrder, ops)) return 0;
  const siblings = await Order.find({
    table: oldOrder.table,
    _id: { $ne: oldOrder._id },
    status: { $in: ['new', 'preparing', 'ready', 'served'] },
    paymentStatus: { $ne: 'Paid' },
    ...tf,
  }).select('total manualDiscount amountPaid type holdReason source').lean();
  return round2(siblings
    .filter((sib) => !orderIsPayFirst(sib, ops))
    .reduce((sum, sib) => sum + Math.max(0,
      (Number(sib.total) || 0) - (Number(sib.manualDiscount) || 0) - (Number(sib.amountPaid) || 0)), 0));
}

module.exports = { resolveTenderedBody, siblingDueFor, BILLING_ROLES };
