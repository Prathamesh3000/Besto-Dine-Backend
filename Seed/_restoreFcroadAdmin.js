/**
 * One-shot script to restore the FC Road 2 Branch Admin account that
 * was deleted during E2E Manager-role testing (2026-05-21). Safe to
 * run once and then delete this file.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        const exists = await User.findOne({ email: 'fcroad@hoteltiptop.in' });
        if (exists) {
            console.log('Already exists — id:', exists._id.toString());
            process.exit(0);
        }
        const u = new User({
            name: 'Test Branch Admin',
            email: 'fcroad@hoteltiptop.in',
            password: 'Admin@123',                            // hashed by pre-save hook
            mobile: '8877566512',
            role: 'admin',
            restaurant: '69f2eaaa2cd4f64efe65d88e',           // Hotel Tip Top
            branch: '69f79731fcc9bf228a6bd162',               // FC Road 2
            status: 'active',
            mustChangePassword: false,
            isTenantOwner: false,
            staffId: 'EMP-001',
            permissions: {},                                   // admin auto-bypasses checkPermission
        });
        await u.save();
        console.log('Restored — id:', u._id.toString(), 'password: Admin@123');
    } catch (err) {
        console.error('Restore failed:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
})();
