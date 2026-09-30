/**
 * Tenant backup controller (Phase 7.2).
 *
 * Gives a Super Admin the ability to:
 *   1. Trigger an on-demand backup of a specific tenant's data
 *      (saved as a timestamped JSON file on the server's disk).
 *   2. List existing backups for a tenant.
 *   3. Download a specific backup file.
 *   4. Delete old backups.
 *
 * The backup content is identical to the Phase 7.1 self-service
 * export (tenant-scoped, no cross-tenant leakage) so we reuse the
 * same query pattern. The difference is:
 *   - The actor is a Super Admin, not the tenant admin.
 *   - The backup is written to server-side storage, not streamed to
 *     the requester's browser.
 *   - Retention is managed by the Super Admin (list + delete).
 *
 * Storage: `Backend/backups/<restaurant-slug>/<timestamp>.json`.
 * Not in git — add `backups/` to .gitignore.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Restaurant = require('../models/restaurant');
const Order = require('../models/order');
const MenuItem = require('../models/menuItem');
const Category = require('../models/category');
const Table = require('../models/table');
const User = require('../models/user');
const Branch = require('../models/branch');
const logger = require('../utils/logger');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function tenantDir(slug) {
    return path.join(BACKUP_DIR, slug || 'unknown');
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * POST /api/v1/superadmin/restaurants/:id/backup
 *
 * Creates a point-in-time JSON snapshot of the tenant's data and
 * saves it to disk. Returns the filename + byte size.
 */
exports.createBackup = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }

        const restaurant = await Restaurant.findById(id).lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const scope = { restaurant: restaurant._id };
        const [
            orders, menuItems, categories, tables, branches, staff,
        ] = await Promise.all([
            Order.find(scope).sort({ createdAt: -1 }).limit(50000).lean(),
            MenuItem.find(scope).lean(),
            Category.find(scope).lean(),
            Table.find(scope).lean(),
            Branch.find(scope).lean(),
            User.find({ ...scope, role: { $nin: ['customer', 'superadmin'] } })
                .select('-password').lean(),
        ]);

        const payload = {
            backupVersion: '1.0',
            createdAt: new Date().toISOString(),
            restaurant: {
                _id: restaurant._id,
                name: restaurant.name,
                slug: restaurant.slug,
                contactEmail: restaurant.contactEmail,
                status: restaurant.status,
            },
            counts: {
                orders: orders.length,
                menuItems: menuItems.length,
                categories: categories.length,
                tables: tables.length,
                branches: branches.length,
                staff: staff.length,
            },
            orders, menuItems, categories, tables, branches, staff,
        };

        const dir = tenantDir(restaurant.slug);
        ensureDir(dir);

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${stamp}.json`;
        const filePath = path.join(dir, filename);
        const body = JSON.stringify(payload, null, 2);
        fs.writeFileSync(filePath, body, 'utf-8');

        const bytes = Buffer.byteLength(body, 'utf-8');
        logger.info(`tenant backup created for ${restaurant.slug}: ${filename} (${bytes} bytes)`);

        return res.status(201).json({
            success: true,
            data: {
                filename,
                size: bytes,
                createdAt: payload.createdAt,
                counts: payload.counts,
            },
        });
    } catch (err) {
        logger.error('createBackup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to create backup' });
    }
};

/**
 * GET /api/v1/superadmin/restaurants/:id/backups
 *
 * Lists existing backup files for a tenant, sorted newest-first.
 */
exports.listBackups = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const restaurant = await Restaurant.findById(id).select('slug').lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const dir = tenantDir(restaurant.slug);
        if (!fs.existsSync(dir)) {
            return res.json({ success: true, data: [] });
        }

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const stat = fs.statSync(path.join(dir, f));
                return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        return res.json({ success: true, data: files });
    } catch (err) {
        logger.error('listBackups error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to list backups' });
    }
};

/**
 * GET /api/v1/superadmin/restaurants/:id/backups/:filename
 *
 * Downloads a specific backup file.
 */
exports.downloadBackup = async (req, res) => {
    try {
        const { id, filename } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        // Sanitize filename to prevent path traversal
        const safeName = path.basename(filename);
        if (!safeName.endsWith('.json')) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        const restaurant = await Restaurant.findById(id).select('slug').lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const filePath = path.join(tenantDir(restaurant.slug), safeName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'Backup file not found' });
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        logger.error('downloadBackup error: ' + err.message);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: 'Failed to download backup' });
        }
    }
};

/**
 * DELETE /api/v1/superadmin/restaurants/:id/backups/:filename
 *
 * Deletes a specific backup file from disk.
 */
exports.deleteBackup = async (req, res) => {
    try {
        const { id, filename } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
        }
        const safeName = path.basename(filename);
        if (!safeName.endsWith('.json')) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        const restaurant = await Restaurant.findById(id).select('slug').lean();
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const filePath = path.join(tenantDir(restaurant.slug), safeName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'Backup file not found' });
        }

        fs.unlinkSync(filePath);
        logger.info(`backup deleted for ${restaurant.slug}: ${safeName}`);

        return res.json({ success: true, message: 'Backup deleted' });
    } catch (err) {
        logger.error('deleteBackup error: ' + err.message);
        return res.status(500).json({ success: false, message: 'Failed to delete backup' });
    }
};
