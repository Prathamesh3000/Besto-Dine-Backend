const mongoose = require('mongoose');

// One thermal print job (a KOT, a bill or a test page) for one printer
// of one branch. Created by services/printService.js, pushed to the
// branch's print agent over socket.io (`print:job`) and acknowledged
// back (`print:ack`). Persisted so a job raised while the agent is
// offline is still printed when it reconnects (`print:pending`).
//
// `document` is the renderer's neutral receipt document
// (utils/receiptRenderer.js) — plain lines + cut/drawer flags — which
// the agent maps to ESC/POS. Jobs are ephemeral: a TTL index drops them
// after 7 days.
const printerSnapshotSchema = new mongoose.Schema({
    id:           { type: String, default: '' },
    name:         { type: String, default: '' },
    interface:    { type: String, default: 'lan' },
    host:         { type: String, default: '' },
    port:         { type: Number, default: 9100 },
    devicePath:   { type: String, default: '' },
    paperWidth:   { type: String, default: '80' },
    characterSet: { type: String, default: 'PC437_USA' },
    copies:       { type: Number, default: 1 },
}, { _id: false });

const printJobSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    order:      { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    orderId:    { type: String, default: '' },
    kind:       { type: String, enum: ['kot', 'bill', 'test'], required: true },
    station:    { type: String, enum: ['kitchen', 'bar', 'counter'], required: true },
    reason:     { type: String, enum: ['create', 'append', 'reprint', 'manual', 'paid', 'test'], default: 'manual' },
    printer:    { type: printerSnapshotSchema, required: true },
    document:   { type: mongoose.Schema.Types.Mixed, required: true },
    status:     { type: String, enum: ['queued', 'sent', 'done', 'failed'], default: 'queued' },
    attempts:   { type: Number, default: 0 },
    error:      { type: String, default: '' },
    sentAt:     { type: Date, default: null },
    ackedAt:    { type: Date, default: null },
}, { timestamps: true });

printJobSchema.index({ restaurant: 1, branch: 1, status: 1, createdAt: 1 });
printJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Auto-scope queries to the request tenant (utils/tenantScopePlugin.js).
printJobSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('PrintJob', printJobSchema);
