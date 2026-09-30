/**
 * Invoice PDF rendering for SaaS subscription charges.
 *
 * Phase 5 step 5. Uses pdfkit's STANDALONE build
 * (`pdfkit/js/pdfkit.standalone`) — the standalone bundle ships all
 * fonts + virtual FS inline, so we sidestep the transitive tslib /
 * @swc/helpers dependency that the regular build requires but
 * npm install sometimes fails to materialize on Windows.
 *
 * The output is a single-page A4 invoice with a professional layout:
 *   • Brand band header (logo / wordmark + invoice meta)
 *   • Side-by-side Bill To / From blocks
 *   • Invoice metadata bar (date / period / status)
 *   • Line-item table with banded rows
 *   • Subtotal / tax / total summary
 *   • Boxed payment-details block
 *   • Footer with contact + computer-generated notice
 *
 * Important: pdfkit's bundled Helvetica is WinAnsi-encoded and CANNOT
 * render Unicode arrows (→), em-dashes (–), the Rupee sign (₹), etc.
 * Those silently collapse to nonsense glyphs ("!'", "¹", etc) which
 * is why the previous version had garbled date separators and
 * mis-printed currency. We use ASCII-only ("to", "-", "INR") and let
 * Intl.NumberFormat group the digits.
 */

const PDFDocument = require('pdfkit/js/pdfkit.standalone');

// ─── Layout constants ───────────────────────────────────────────────
const PAGE_MARGIN = 40;
const PAGE_WIDTH  = 595.28;      // A4 width in pt (pdfkit unit)
const CONTENT_LEFT  = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const COLOR_BRAND   = '#FE8301';   // BestoDine orange
const COLOR_INK     = '#1A181B';
const COLOR_BODY    = '#3F3A41';
const COLOR_MUTED   = '#8D848F';
const COLOR_LINE    = '#E5E7EB';
const COLOR_PANEL   = '#F8F7F9';
const COLOR_SUCCESS = '#047857';
const COLOR_DANGER  = '#B91C1C';

// ─── Platform identity (env-configurable) ───────────────────────────
function platformProfile() {
    return {
        name:    process.env.PLATFORM_NAME    || 'BestoDine',
        line1:   process.env.PLATFORM_ADDRESS_LINE1 || 'BestoDine Platform',
        line2:   process.env.PLATFORM_ADDRESS_LINE2 || '',
        city:    process.env.PLATFORM_CITY    || '',
        country: process.env.PLATFORM_COUNTRY || 'India',
        email:   process.env.PLATFORM_EMAIL   || 'billing@bestodine.com',
        phone:   process.env.PLATFORM_PHONE   || '',
        gstin:   process.env.PLATFORM_GSTIN   || '',
        website: process.env.PLATFORM_WEBSITE || 'bestodine.com',
    };
}

// ─── Formatting helpers ─────────────────────────────────────────────
// Amounts in invoice rows are stored in paise (Razorpay convention).
// 100 paise = ₹1. The ₹ glyph isn't in WinAnsi so we print the ISO
// currency code instead (INR 10,000.00).
function formatAmount(amountInSmallestUnit, currency = 'INR') {
    const n = (Number(amountInSmallestUnit) || 0) / 100;
    let grouped;
    try {
        grouped = new Intl.NumberFormat('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(n);
    } catch {
        grouped = n.toFixed(2);
    }
    return `${(currency || 'INR').toUpperCase()} ${grouped}`;
}

function formatDate(d) {
    if (!d) return '-';
    try {
        return new Date(d).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
    } catch { return '-'; }
}

function formatDateTime(d) {
    if (!d) return '-';
    try {
        const dt = new Date(d);
        const date = dt.toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
        const time = dt.toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit',
        });
        return `${date} at ${time}`;
    } catch { return '-'; }
}

function statusBadge(status) {
    const s = (status || 'paid').toLowerCase();
    if (s === 'refunded')            return { label: 'REFUNDED',          color: COLOR_DANGER };
    if (s === 'partially_refunded')  return { label: 'PARTIALLY REFUNDED', color: COLOR_BRAND };
    return                                  { label: 'PAID',              color: COLOR_SUCCESS };
}

// Compose a tenant's address into 1-N display lines, skipping empty parts.
function composeTenantAddress(tenant) {
    if (!tenant) return [];
    const lines = [];
    const a = tenant.address || {};
    if (a.line1)   lines.push(String(a.line1).trim());
    if (a.line2)   lines.push(String(a.line2).trim());
    const cityState = [tenant.city || '', a.state || ''].filter(Boolean).join(', ');
    const cityLine  = [cityState, a.pincode || ''].filter(Boolean).join(' - ');
    if (cityLine)  lines.push(cityLine);
    if (a.country) lines.push(String(a.country).trim());
    return lines.filter(Boolean);
}

function composePlatformAddress(p) {
    return [p.line1, p.line2, p.city, p.country].filter(Boolean);
}

// ─── Drawing primitives ─────────────────────────────────────────────

function fillRect(doc, x, y, w, h, color) {
    doc.save().rect(x, y, w, h).fill(color).restore();
}

function strokeLine(doc, x1, y1, x2, y2, color = COLOR_LINE, width = 0.75) {
    doc.save().lineWidth(width).strokeColor(color).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

function panelBox(doc, x, y, w, h, { fill = COLOR_PANEL, stroke = COLOR_LINE, radius = 6 } = {}) {
    doc.save()
        .roundedRect(x, y, w, h, radius)
        .fillAndStroke(fill, stroke)
        .restore();
}

function label(doc, text, x, y, { width, color = COLOR_MUTED, size = 8 } = {}) {
    doc.font('Helvetica-Bold')
        .fontSize(size)
        .fillColor(color)
        .text(String(text).toUpperCase(), x, y, width ? { width, characterSpacing: 0.6 } : { characterSpacing: 0.6 });
}

function value(doc, text, x, y, { width, color = COLOR_INK, size = 10, bold = false } = {}) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(size)
        .fillColor(color)
        .text(String(text), x, y, width ? { width } : {});
}

// ─── Core rendering ─────────────────────────────────────────────────

function drawInvoice(doc, invoice, tenant) {
    const platform     = platformProfile();
    const badge        = statusBadge(invoice.status);
    const platformAddr = composePlatformAddress(platform);
    const tenantAddr   = composeTenantAddress(tenant);

    // ── Brand band ──────────────────────────────────────────────────
    fillRect(doc, 0, 0, PAGE_WIDTH, 6, COLOR_BRAND);

    // ── Header: wordmark (left) + invoice meta (right) ──────────────
    // Both sides use explicit absolute positioning. The previous version
    // mixed pdfkit `continued: true` with `align: 'right'`, which draws
    // the value and the label on top of each other ("INV-...  No." and
    // "15 May 2026  Issued" overlapping). Two parallel columns of
    // right-aligned labels + values fix that cleanly.
    const headerTop = 30;

    // Left: wordmark + subtitle
    doc.font('Helvetica-Bold').fontSize(22).fillColor(COLOR_INK)
        .text(platform.name, CONTENT_LEFT, headerTop, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_MUTED)
        .text('Subscription Invoice', CONTENT_LEFT, headerTop + 28, {
            characterSpacing: 0.6, lineBreak: false,
        });

    // Right: INVOICE title + 3-row meta (label col + value col)
    const valueColW = 150;
    const labelColW = 70;
    const valueColX = CONTENT_RIGHT - valueColW;
    const labelColX = valueColX - labelColW - 8;

    doc.font('Helvetica-Bold').fontSize(20).fillColor(COLOR_INK)
        .text('INVOICE', valueColX - 200, headerTop, {
            width: 200 + valueColW, align: 'right', lineBreak: false,
        });

    let metaRowY = headerTop + 30;
    const drawMetaRow = (rowLabel, rowValueText, { bold = false, color = COLOR_INK } = {}) => {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR_MUTED)
            .text(rowLabel, labelColX, metaRowY, { width: labelColW, align: 'right', lineBreak: false });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color)
            .text(rowValueText, valueColX, metaRowY, { width: valueColW, align: 'right', lineBreak: false });
        metaRowY += 14;
    };

    drawMetaRow('Invoice No.', invoice.invoiceNumber || '-', { bold: true });
    drawMetaRow('Issued',      formatDate(invoice.createdAt));

    // Status row — label in left col, pill in right col, both vertically
    // centered against each other so the pill sits on the same baseline
    // as the text in the rows above.
    doc.font('Helvetica').fontSize(9).fillColor(COLOR_MUTED)
        .text('Status', labelColX, metaRowY + 3, { width: labelColW, align: 'right', lineBreak: false });

    // Pill auto-widens to the label so longer values (PARTIALLY REFUNDED)
    // don't get clipped or run off the page.
    const badgeLabelW = doc.font('Helvetica-Bold').fontSize(9).widthOfString(badge.label);
    const pillPadX = 12;
    const pillW    = Math.max(64, badgeLabelW + pillPadX * 2);
    const pillH    = 18;
    const pillX    = CONTENT_RIGHT - pillW;
    const pillY    = metaRowY;
    doc.save()
        .roundedRect(pillX, pillY, pillW, pillH, 9)
        .fillAndStroke(badge.color, badge.color)
        .restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
        .text(badge.label, pillX, pillY + 5, {
            width: pillW, align: 'center', characterSpacing: 0.4, lineBreak: false,
        });
    metaRowY = pillY + pillH;

    // Divider sits below BOTH the left wordmark+subtitle block AND the
    // right meta block, whichever ends lower. headerTop+28 (subtitle
    // baseline) + 4pt margin is the left side; metaRowY is the right.
    let y = Math.max(headerTop + 28 + 12, metaRowY) + 14;
    strokeLine(doc, CONTENT_LEFT, y, CONTENT_RIGHT, y);

    // ── Bill To / From side-by-side ─────────────────────────────────
    y += 18;
    const colGap   = 16;
    const colWidth = (CONTENT_WIDTH - colGap) / 2;
    const billX    = CONTENT_LEFT;
    const fromX    = CONTENT_LEFT + colWidth + colGap;
    const blockTop = y;

    label(doc, 'Bill To', billX, blockTop);
    let billY = blockTop + 14;
    value(doc, tenant?.name || invoice.restaurantName || '-', billX, billY, { width: colWidth, size: 13, bold: true });
    billY += 18;

    if (tenant?.legal?.legalBusinessName && tenant.legal.legalBusinessName !== tenant.name) {
        value(doc, tenant.legal.legalBusinessName, billX, billY, { width: colWidth, size: 9, color: COLOR_MUTED });
        billY += 12;
    }
    for (const line of tenantAddr) {
        value(doc, line, billX, billY, { width: colWidth, size: 9, color: COLOR_BODY });
        billY += 12;
    }
    if (tenant?.contactEmail) {
        value(doc, tenant.contactEmail, billX, billY, { width: colWidth, size: 9, color: COLOR_BODY });
        billY += 12;
    }
    if (tenant?.contactPhone) {
        value(doc, tenant.contactPhone, billX, billY, { width: colWidth, size: 9, color: COLOR_BODY });
        billY += 12;
    }
    if (tenant?.legal?.gstin) {
        billY += 4;
        value(doc, `GSTIN: ${tenant.legal.gstin}`, billX, billY, { width: colWidth, size: 9, color: COLOR_INK, bold: true });
        billY += 12;
    }

    label(doc, 'From', fromX, blockTop);
    let fromY = blockTop + 14;
    value(doc, platform.name, fromX, fromY, { width: colWidth, size: 13, bold: true });
    fromY += 18;
    for (const line of platformAddr) {
        value(doc, line, fromX, fromY, { width: colWidth, size: 9, color: COLOR_BODY });
        fromY += 12;
    }
    if (platform.email) {
        value(doc, platform.email, fromX, fromY, { width: colWidth, size: 9, color: COLOR_BODY });
        fromY += 12;
    }
    if (platform.phone) {
        value(doc, platform.phone, fromX, fromY, { width: colWidth, size: 9, color: COLOR_BODY });
        fromY += 12;
    }
    if (platform.gstin) {
        fromY += 4;
        value(doc, `GSTIN: ${platform.gstin}`, fromX, fromY, { width: colWidth, size: 9, color: COLOR_INK, bold: true });
        fromY += 12;
    }

    y = Math.max(billY, fromY) + 16;

    // ── Period summary bar ──────────────────────────────────────────
    const barH = 48;
    panelBox(doc, CONTENT_LEFT, y, CONTENT_WIDTH, barH);
    const padX = 18;
    const cellW = (CONTENT_WIDTH - padX * 2) / 3;
    const cellY = y + 10;
    // Cell 1: Invoice date
    label(doc, 'Invoice Date', CONTENT_LEFT + padX, cellY);
    value(doc, formatDate(invoice.createdAt), CONTENT_LEFT + padX, cellY + 14, { size: 11, bold: true });
    // Cell 2: Billing period
    label(doc, 'Billing Period', CONTENT_LEFT + padX + cellW, cellY);
    value(doc, `${formatDate(invoice.periodStart)} to ${formatDate(invoice.periodEnd)}`,
        CONTENT_LEFT + padX + cellW, cellY + 14, { size: 11, bold: true, width: cellW - 8 });
    // Cell 3: Payment method
    label(doc, 'Payment Method', CONTENT_LEFT + padX + cellW * 2, cellY);
    value(doc, 'Razorpay', CONTENT_LEFT + padX + cellW * 2, cellY + 14, { size: 11, bold: true });

    y += barH + 20;

    // ── Line items table ────────────────────────────────────────────
    const tableX   = CONTENT_LEFT;
    const tableW   = CONTENT_WIDTH;
    const headerH  = 28;
    const rowH     = 44;

    // Column widths: Description (flex), Qty, Unit, Amount
    const colAmount = 110;
    const colUnit   = 100;
    const colQty    = 40;
    const colDesc   = tableW - colAmount - colUnit - colQty;

    // Header
    fillRect(doc, tableX, y, tableW, headerH, COLOR_INK);
    const colDescX   = tableX + 14;
    const colQtyX    = tableX + colDesc;
    const colUnitX   = tableX + colDesc + colQty;
    const colAmtX    = tableX + colDesc + colQty + colUnit;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
    doc.text('DESCRIPTION', colDescX, y + 10, { characterSpacing: 0.6 });
    doc.text('QTY',          colQtyX,  y + 10, { width: colQty - 6,  align: 'right', characterSpacing: 0.6 });
    doc.text('UNIT PRICE',   colUnitX, y + 10, { width: colUnit - 6, align: 'right', characterSpacing: 0.6 });
    doc.text('AMOUNT',       colAmtX,  y + 10, { width: colAmount - 14, align: 'right', characterSpacing: 0.6 });

    y += headerH;

    // Body row
    fillRect(doc, tableX, y, tableW, rowH, '#FFFFFF');
    strokeLine(doc, tableX, y + rowH, tableX + tableW, y + rowH);

    value(doc, `${invoice.planName || 'Subscription'} Plan`, colDescX, y + 10, {
        width: colDesc - 20, size: 11, bold: true,
    });
    value(doc,
        `Covers ${formatDate(invoice.periodStart)} to ${formatDate(invoice.periodEnd)}`,
        colDescX, y + 26, { width: colDesc - 20, size: 8.5, color: COLOR_MUTED });

    doc.font('Helvetica').fontSize(11).fillColor(COLOR_BODY)
        .text('1', colQtyX, y + 16, { width: colQty - 6, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(11).fillColor(COLOR_BODY)
        .text(formatAmount(invoice.amount, invoice.currency),
            colUnitX, y + 16, { width: colUnit - 6, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR_INK)
        .text(formatAmount(invoice.amount, invoice.currency),
            colAmtX, y + 16, { width: colAmount - 14, align: 'right' });

    y += rowH + 14;

    // ── Totals block (right-aligned) ────────────────────────────────
    const totalsW = 230;
    const totalsX = CONTENT_RIGHT - totalsW;

    const drawTotalRow = (rowLabel, rowValue, { bold = false, large = false } = {}) => {
        const size = large ? 12 : 10;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
            .fillColor(bold ? COLOR_INK : COLOR_BODY)
            .text(rowLabel, totalsX, y, { width: totalsW * 0.5 });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
            .fillColor(bold ? COLOR_INK : COLOR_INK)
            .text(rowValue, totalsX + totalsW * 0.5, y, { width: totalsW * 0.5, align: 'right' });
        y += size + 8;
    };

    drawTotalRow('Subtotal', formatAmount(invoice.amount, invoice.currency));
    drawTotalRow('Tax', formatAmount(0, invoice.currency));   // SaaS billing — tax handled out-of-band today
    strokeLine(doc, totalsX, y, totalsX + totalsW, y, COLOR_LINE, 1);
    y += 8;
    drawTotalRow('Total Paid', formatAmount(invoice.amount, invoice.currency), { bold: true, large: true });

    y += 12;

    // ── Payment details panel ───────────────────────────────────────
    const payH = 96;
    panelBox(doc, CONTENT_LEFT, y, CONTENT_WIDTH, payH);
    label(doc, 'Payment Details', CONTENT_LEFT + padX, y + 12);

    const rowGap = 14;
    const labelW = 110;
    let payRowY = y + 30;

    const drawPayRow = (k, v) => {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR_MUTED)
            .text(k, CONTENT_LEFT + padX, payRowY, { width: labelW });
        doc.font('Helvetica').fontSize(9).fillColor(COLOR_INK)
            .text(v, CONTENT_LEFT + padX + labelW, payRowY, { width: CONTENT_WIDTH - padX * 2 - labelW });
        payRowY += rowGap;
    };

    drawPayRow('Status',          badge.label);
    drawPayRow('Payment ID',      invoice.razorpayPaymentId      || '-');
    if (invoice.razorpaySubscriptionId) {
        drawPayRow('Subscription ID', invoice.razorpaySubscriptionId);
    }
    drawPayRow('Paid On',         formatDateTime(invoice.paidAt || invoice.createdAt));

    y += payH + 18;

    // ── Footer ──────────────────────────────────────────────────────
    strokeLine(doc, CONTENT_LEFT, y, CONTENT_RIGHT, y);
    y += 8;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_MUTED)
        .text('This is a computer-generated invoice and does not require a signature.',
            CONTENT_LEFT, y, { width: CONTENT_WIDTH, align: 'center' });
    y += 10;
    const contact = [
        platform.email ? `Email: ${platform.email}` : null,
        platform.phone ? `Phone: ${platform.phone}` : null,
        platform.website ? `Web: ${platform.website}` : null,
    ].filter(Boolean).join('   |   ');
    if (contact) {
        doc.text(contact, CONTENT_LEFT, y, { width: CONTENT_WIDTH, align: 'center' });
    }
}

/**
 * Stream a PDF invoice directly to an HTTP response. The handler
 * should NOT call res.send() / res.json() — PDFKit writes to the
 * response and ends it when drawInvoice + doc.end() finish.
 */
function streamInvoicePdf(invoice, tenant, res) {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    const filename = `${invoice.invoiceNumber || 'invoice'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);
    drawInvoice(doc, invoice, tenant);
    doc.end();
}

/**
 * Build a Buffer for the invoice. Useful for tests and for future
 * email-attachment flows where we need the file in memory rather
 * than streamed to a client.
 */
function renderInvoicePdfBuffer(invoice, tenant) {
    return new Promise((resolve, reject) => {
        try {
            const chunks = [];
            const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            drawInvoice(doc, invoice, tenant);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { streamInvoicePdf, renderInvoicePdfBuffer };
