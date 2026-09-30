const mongoose = require('mongoose');

// #35 — cluster-wide lease for scheduled background jobs.
//
// One document per job name. An instance "holds" the job while
// `lockedUntil` is in the future and `owner` is its instance id. Leases
// are taken with an atomic findOneAndUpdate + upsert (see
// utils/jobLock.js): the unique index on `name` is what makes two
// instances racing to create the first document safe — the loser gets
// E11000 and treats it as "someone else holds the lock".
//
// This collection is platform-level (not tenant-scoped): it carries no
// `restaurant` field and must never be added to the tenant assertion
// list.
const jobLockSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    owner: { type: String, default: null },
    lockedUntil: { type: Date, required: true, default: () => new Date(0) },
    lockedAt: { type: Date, default: null },
    // Diagnostics only — when the holder last finished a run and how.
    lastRunAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
}, {
    timestamps: true,
    collection: 'joblocks',
});

module.exports = mongoose.models.JobLock || mongoose.model('JobLock', jobLockSchema);
