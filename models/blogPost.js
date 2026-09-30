const mongoose = require('mongoose');

/**
 * BlogPost — content for the standalone marketing site's /blog section.
 *
 * Platform-GLOBAL, like Lead / SubscriptionPlan / AuditLog — there is no
 * `restaurant` field. Blog posts are authored by Super Admins and consumed by
 * the marketing site at BUILD TIME via the public read endpoints
 * (`/public/blog`), then prerendered to static HTML for SEO. Editing/publishing
 * from Super Admin triggers a marketing-site rebuild (see utils/deployHook.js).
 *
 * `content` holds raw Markdown — the marketing site renders it (it already
 * bundles `marked`), so the backend stays parser-free. `readingTime` is derived
 * from the content on save so the marketing UI doesn't have to recompute it.
 */
const WORDS_PER_MIN = 220;

const blogPostSchema = new mongoose.Schema(
    {
        title:       { type: String, required: true, trim: true, maxlength: 200 },
        slug:        { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
        // Meta description — written for the SERP snippet (~150-160 chars).
        description: { type: String, required: true, trim: true, maxlength: 320 },
        // Raw Markdown body. Rendered to HTML by the marketing site.
        content:     { type: String, required: true },
        tags:        [{ type: String, trim: true }],
        coverUrl:    { type: String, trim: true, maxlength: 600, default: '' },
        // Display author name (free text — marketing shows it verbatim).
        author:      { type: String, trim: true, maxlength: 120, default: 'Team BestoDine' },
        // Editorial note: the primary keyword this post targets. Not rendered.
        keyword:     { type: String, trim: true, maxlength: 160, default: '' },
        status:      { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
        // Set the first time the post flips to published; drives sort + the
        // article:published_time / datePublished SEO signals.
        publishedAt: { type: Date, default: null },
        readingTime: { type: Number, default: 1 },
        // Bookkeeping — which Super Admin created the post (for the audit trail).
        createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

// Newest-published-first is the marketing list's default order.
blogPostSchema.index({ status: 1, publishedAt: -1 });

// Derive readingTime from the body, and stamp publishedAt the first time the
// post becomes published.
blogPostSchema.pre('save', async function deriveFields() {
    if (this.isModified('content')) {
        const words = String(this.content || '').trim().split(/\s+/).filter(Boolean).length;
        this.readingTime = Math.max(1, Math.round(words / WORDS_PER_MIN));
    }
    if (this.status === 'published' && !this.publishedAt) {
        this.publishedAt = new Date();
    }
});

module.exports = mongoose.model('BlogPost', blogPostSchema);
