const mongoose = require('mongoose');

// One row per table sitting, from the FIRST CONFIRMED order until the table
// is released (see utils/tableTimer.js, docs/TABLE_TIMER.md). Source of truth
// for "how long did a table stay occupied" reports. The live timer shown on
// the floor reads Table.sessionStartedAt; this row is the durable record.
const tableSessionSchema = new mongoose.Schema({
    restaurant: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true, index: true },
    branch:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    // The table holding the timer. Re-pointed when the party is moved
    // (services/tableMoveService.js); the merge-group leader for a group.
    table:      { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
    startedAt:  { type: Date, required: true },
    endedAt:    { type: Date, default: null },
    durationMinutes: { type: Number, default: null, min: 0 },
    endReason:  { type: String, enum: ['paid', 'freed', 'forced', 'cleared'], default: null },
    firstOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    // true while the session is open; the partial unique index below keys on it.
    open:       { type: Boolean, default: true },
    orderCount: { type: Number, default: 1, min: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

// At most ONE open session per table.
tableSessionSchema.index(
    { restaurant: 1, table: 1 },
    { unique: true, name: 'one_open_session_per_table', partialFilterExpression: { open: true } },
);
// Reports: sessions of a branch by start time.
tableSessionSchema.index({ restaurant: 1, branch: 1, startedAt: -1 });

tableSessionSchema.plugin(require('../utils/tenantScopePlugin'));

module.exports = mongoose.model('TableSession', tableSessionSchema);
