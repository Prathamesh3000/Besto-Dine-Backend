require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Branch = require('../models/branch');

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const admins = await User.find({ role: { $in: ['admin', 'manager', 'superadmin'] } })
        .select('name email role isTenantOwner branch status mustChangePassword')
        .populate('branch', 'name slug')
        .lean();
    for (const u of admins) {
        console.log(`${u.role.padEnd(10)} ${(u.email || '').padEnd(40)} owner=${!!u.isTenantOwner} pin=${u.branch?.name || '(none)'} status=${u.status} mustChange=${!!u.mustChangePassword}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
