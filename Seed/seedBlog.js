/**
 * seedBlog.js
 *
 * One-shot, idempotent seed for the marketing blog. Migrates the original
 * file-based articles (authored as Markdown in the standalone marketing repo)
 * into the BlogPost collection so Super Admin → Blog has content to manage and
 * the marketing site can fetch published posts from /public/blog at build time.
 *
 * Re-running is safe: a post whose slug already exists is left untouched.
 *
 * Usage:
 *   cd Backend
 *   node Seed/seedBlog.js
 *
 * Source dir can be overridden with BLOG_SEED_DIR (absolute path to a folder of
 * *.md files); defaults to the sibling marketing repo's content/blog folder.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();

const BlogPost = require('../models/blogPost');

const SEED_DIR =
    process.env.BLOG_SEED_DIR ||
    path.join(__dirname, '..', '..', 'BestoDine-Marketing', 'Frontend', 'src', 'content', 'blog');

// Tiny frontmatter parser (matches the marketing site's own parser): handles
// `key: value`, quoted strings and [a, b] arrays.
function parse(raw, fallbackSlug) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    const data = {};
    let body = raw;
    if (m) {
        body = m[2];
        for (const line of m[1].split(/\r?\n/)) {
            const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
            if (!kv) continue;
            let v = kv[2].trim();
            if (v.startsWith('[') && v.endsWith(']')) {
                v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
            } else {
                v = v.replace(/^["']|["']$/g, '');
            }
            data[kv[1]] = v;
        }
    }
    return {
        slug: data.slug || fallbackSlug,
        title: data.title || fallbackSlug,
        description: data.description || '',
        content: body.trim(),
        tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
        coverUrl: data.cover || '',
        author: data.author || 'Team BestoDine',
        keyword: data.keyword || '',
        publishedAt: data.date ? new Date(data.date) : new Date(),
    };
}

async function run() {
    const uri = process.env.MONGO_URL;
    if (!uri) {
        console.error('MONGO_URL is not set in .env');
        process.exit(1);
    }
    if (!fs.existsSync(SEED_DIR)) {
        console.error(`Blog seed dir not found: ${SEED_DIR}`);
        console.error('Set BLOG_SEED_DIR to a folder of *.md articles, or run from the monorepo root.');
        process.exit(1);
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, family: 4 });
    console.log('✔ Connected to MongoDB');

    const files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.md'));
    if (!files.length) console.log('• No .md files found — nothing to seed');

    for (const file of files) {
        const fallbackSlug = file.replace(/\.md$/, '');
        const raw = fs.readFileSync(path.join(SEED_DIR, file), 'utf-8');
        const post = parse(raw, fallbackSlug);

        const existing = await BlogPost.findOne({ slug: post.slug }).select('_id').lean();
        if (existing) {
            console.log(`• Post "${post.slug}" already exists — skipping`);
            continue;
        }
        await BlogPost.create({ ...post, status: 'published' });
        console.log(`✔ Seeded post: ${post.slug}`);
    }

    await mongoose.disconnect();
    console.log('✔ Done');
}

run().catch((err) => {
    console.error('Blog seed failed:', err);
    process.exit(1);
});
