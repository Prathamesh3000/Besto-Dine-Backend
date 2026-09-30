const BlogPost = require('../models/blogPost');
const logger = require('../utils/logger');
const { recordAudit } = require('../utils/audit');
const { triggerMarketingRebuild } = require('../utils/deployHook');
const { compressAndUpload } = require('../utils/cloudinaryUploader');
const { sanitizeBlogContent } = require('../utils/sanitizeBlogContent');

// BlogPost is intrinsically platform-global (no tenant). // AUDIT-EXEMPT: global marketing content, not tenant-scoped

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(input = '') {
    return String(input)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

// Guarantee a unique slug by suffixing -2, -3, ... if needed. `excludeId` lets
// an update keep its own slug without colliding with itself.
async function uniqueSlug(base, excludeId = null) {
    let slug = base || 'post';
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const clash = await BlogPost.findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('_id').lean();
        if (!clash) return slug;
        n += 1;
        slug = `${base}-${n}`;
    }
}

// Shape a post for the Super Admin list/detail (includes drafts + bookkeeping).
function adminPayload(p) {
    return {
        id: p._id,
        title: p.title,
        slug: p.slug,
        description: p.description,
        content: p.content,
        tags: p.tags || [],
        coverUrl: p.coverUrl || '',
        author: p.author,
        keyword: p.keyword || '',
        status: p.status,
        publishedAt: p.publishedAt,
        readingTime: p.readingTime,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
}

// Shape a published post for the public (marketing) read — no internal fields.
function publicPayload(p) {
    return {
        title: p.title,
        slug: p.slug,
        description: p.description,
        content: p.content,
        tags: p.tags || [],
        cover: p.coverUrl || '',
        author: p.author,
        date: p.publishedAt,
        updated: p.updatedAt,
        readingTime: p.readingTime,
    };
}

// ═══════════════════════ SUPER ADMIN — CRUD ═══════════════════════════════

// GET /api/v1/superadmin/blog
exports.listBlogPosts = async (req, res) => {
    try {
        const { status, q, page = 1, limit = 25 } = req.query;
        const filter = {};
        if (status === 'draft' || status === 'published') filter.status = status;
        if (q && q.trim()) {
            const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ title: rx }, { slug: rx }, { keyword: rx }];
        }
        const pg = Math.max(1, parseInt(page, 10) || 1);
        const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

        const [items, total, publishedCount, draftCount] = await Promise.all([
            BlogPost.find(filter).sort({ updatedAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
            BlogPost.countDocuments(filter),
            BlogPost.countDocuments({ status: 'published' }),
            BlogPost.countDocuments({ status: 'draft' }),
        ]);

        return res.status(200).json({
            success: true,
            data: items.map(adminPayload),
            summary: { total: publishedCount + draftCount, published: publishedCount, draft: draftCount },
            pagination: { page: pg, limit: lim, total, pages: Math.max(1, Math.ceil(total / lim)) },
        });
    } catch (err) {
        logger.error('listBlogPosts error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load blog posts' });
    }
};

// GET /api/v1/superadmin/blog/:id
exports.getBlogPost = async (req, res) => {
    try {
        const post = await BlogPost.findById(req.params.id).lean();
        if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });
        return res.status(200).json({ success: true, data: adminPayload(post) });
    } catch (err) {
        logger.error('getBlogPost error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load blog post' });
    }
};

// POST /api/v1/superadmin/blog
exports.createBlogPost = async (req, res) => {
    try {
        const { title, description, content, tags, coverUrl, author, keyword, status, slug } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
        if (!description || !description.trim()) return res.status(400).json({ success: false, message: 'Meta description is required' });
        if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Content is required' });
        // Strip scripts / event handlers / javascript: URLs before storing.
        const safeContent = sanitizeBlogContent(content);
        if (!safeContent.trim()) return res.status(400).json({ success: false, message: 'Content is required' });

        const base = slug && SLUG_REGEX.test(slug) ? slug : slugify(slug || title);
        const finalSlug = await uniqueSlug(base);

        const post = await BlogPost.create({
            title: title.trim(),
            slug: finalSlug,
            description: description.trim(),
            content: safeContent,
            tags: normalizeTags(tags),
            coverUrl: (coverUrl || '').trim(),
            author: (author || '').trim() || 'Team BestoDine',
            keyword: (keyword || '').trim(),
            status: status === 'published' ? 'published' : 'draft',
            createdBy: req.user._id,
        });

        await recordAudit(req, {
            action: 'blog.create',
            targetType: 'blog',
            targetId: post._id,
            targetName: post.title,
            details: {
                slug: post.slug,
                status: post.status,
                author: post.author,
                tags: (post.tags || []).join(', '),
                contentLength: `${String(post.content ?? '').length} chars`,
            },
        });

        // A post born published changes the live site → rebuild.
        if (post.status === 'published') triggerMarketingRebuild('blog.create.published');

        return res.status(201).json({ success: true, data: adminPayload(post) });
    } catch (err) {
        logger.error('createBlogPost error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create blog post' });
    }
};

// PATCH /api/v1/superadmin/blog/:id
exports.updateBlogPost = async (req, res) => {
    try {
        const post = await BlogPost.findById(req.params.id);
        if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

        const wasPublished = post.status === 'published';
        const { title, description, content, tags, coverUrl, author, keyword, status, slug } = req.body;

        // Track field-level changes so the audit log records *what* the editor
        // changed (old → new) rather than just slug/status on every save.
        const changes = {};
        const previewVal = (v) => {
            const s = String(v ?? '');
            return s.length > 120 ? s.slice(0, 117) + '…' : s;
        };
        const noteChange = (field, oldVal, newVal) => {
            if (String(oldVal ?? '') === String(newVal ?? '')) return;
            changes[field] = { from: previewVal(oldVal), to: previewVal(newVal) };
        };

        if (title !== undefined) {
            if (!title.trim()) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
            noteChange('title', post.title, title.trim());
            post.title = title.trim();
        }
        if (description !== undefined) {
            noteChange('description', post.description, description.trim());
            post.description = description.trim();
        }
        if (content !== undefined) {
            const safeContent = sanitizeBlogContent(content);
            // Full article body is too large for an audit row — record the fact
            // it changed plus the length delta, not the prose itself.
            if (String(post.content ?? '') !== String(safeContent ?? '')) {
                changes.content = { from: `${String(post.content ?? '').length} chars`, to: `${String(safeContent ?? '').length} chars` };
            }
            post.content = safeContent;
        }
        if (tags !== undefined) {
            const nextTags = normalizeTags(tags);
            noteChange('tags', (post.tags || []).join(', '), nextTags.join(', '));
            post.tags = nextTags;
        }
        if (coverUrl !== undefined) {
            noteChange('coverUrl', post.coverUrl, (coverUrl || '').trim());
            post.coverUrl = (coverUrl || '').trim();
        }
        if (author !== undefined) {
            const nextAuthor = (author || '').trim() || 'Team BestoDine';
            noteChange('author', post.author, nextAuthor);
            post.author = nextAuthor;
        }
        if (keyword !== undefined) {
            noteChange('keyword', post.keyword, (keyword || '').trim());
            post.keyword = (keyword || '').trim();
        }
        if (status !== undefined && (status === 'draft' || status === 'published')) {
            noteChange('status', post.status, status);
            post.status = status;
        }
        if (slug !== undefined && slug.trim()) {
            const base = SLUG_REGEX.test(slug) ? slug : slugify(slug);
            const nextSlug = await uniqueSlug(base, post._id);
            noteChange('slug', post.slug, nextSlug);
            post.slug = nextSlug;
        }

        await post.save();

        const changedFields = Object.keys(changes);
        await recordAudit(req, {
            action: 'blog.update',
            targetType: 'blog',
            targetId: post._id,
            targetName: post.title,
            details: {
                slug: post.slug,
                status: post.status,
                changedFields,
                ...(changedFields.length ? { changes } : { note: 'Saved with no field changes' }),
            },
        });

        // Rebuild if the post is (or just stopped being) on the live site.
        if (post.status === 'published' || wasPublished) triggerMarketingRebuild('blog.update');

        return res.status(200).json({ success: true, data: adminPayload(post) });
    } catch (err) {
        logger.error('updateBlogPost error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to update blog post' });
    }
};

// DELETE /api/v1/superadmin/blog/:id
exports.deleteBlogPost = async (req, res) => {
    try {
        const post = await BlogPost.findById(req.params.id);
        if (!post) return res.status(404).json({ success: false, message: 'Blog post not found' });

        const wasPublished = post.status === 'published';
        const snapshot = { title: post.title, slug: post.slug };
        await post.deleteOne();

        await recordAudit(req, {
            action: 'blog.delete',
            targetType: 'blog',
            targetId: req.params.id,
            targetName: snapshot.title,
            details: { slug: snapshot.slug },
        });

        // Removing a published post changes the live site → rebuild.
        if (wasPublished) triggerMarketingRebuild('blog.delete');

        return res.status(200).json({ success: true, message: 'Blog post deleted' });
    } catch (err) {
        logger.error('deleteBlogPost error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete blog post' });
    }
};

// POST /api/v1/superadmin/blog/cover  (multipart field: image)
// Uploads a cover image to Cloudinary and returns its URL. Mirrors the
// marketing logo/screenshot upload (superadmin can't use /upload — that's
// adminOnly). The client saves the returned URL onto the post via create/update.
exports.uploadBlogCover = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Please upload an image file' });
        const result = await compressAndUpload({
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            originalname: req.file.originalname,
            folder: 'bestodine/blog',
            maxWidth: 1280,
        });
        return res.status(200).json({ success: true, url: result.secure_url, message: 'Cover uploaded' });
    } catch (err) {
        logger.error('uploadBlogCover error: ' + err.message);
        return res.status(500).json({ success: false, message: err.message || 'Failed to upload cover' });
    }
};

// ═══════════════════════ PUBLIC — READ (marketing build) ═══════════════════

// GET /api/v1/public/blog   → all published posts (full content), newest first.
// Consumed by the marketing site at BUILD time to prerender /blog + each post.
exports.listPublicBlogPosts = async (_req, res) => {
    try {
        const items = await BlogPost.find({ status: 'published' })
            .sort({ publishedAt: -1 })
            .lean();
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).json({ success: true, data: items.map(publicPayload) });
    } catch (err) {
        logger.error('listPublicBlogPosts error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load posts' });
    }
};

// GET /api/v1/public/blog/:slug  → a single published post.
exports.getPublicBlogPost = async (req, res) => {
    try {
        const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' }).lean();
        if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).json({ success: true, data: publicPayload(post) });
    } catch (err) {
        logger.error('getPublicBlogPost error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to load post' });
    }
};

function normalizeTags(tags) {
    if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
    if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
    return [];
}
