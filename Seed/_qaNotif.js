// TEMP — create a test Order notification tied to QA-DINE-IN02 (ready,
// IN-02, Indoor) so we can verify (B) click-redirect and (A) auto-clear
// on serve.  `node Seed/_qaNotif.js`  |  `... check`  |  `... cleanup`
const mongoose = require('mongoose');
require('dotenv').config();
const TENANT = '69f2eaaa2cd4f64efe65d88e';
const BRANCH = '69f8300f24be77f6adbd9c75';
const ORDER = 'QA-DINE-IN02';
(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const Notification = require('../models/notification');
    const mode = process.argv[2];

    if (mode === 'cleanup') {
        const r = await Notification.deleteMany({ restaurant: TENANT, 'meta.orderId': /^QA-/ });
        console.log(`Cleanup: removed ${r.deletedCount} QA notifications.`);
        await mongoose.connection.close();
        return;
    }
    if (mode === 'check') {
        const n = await Notification.find({ restaurant: TENANT, category: 'Order', recipientRole: 'waiter', 'meta.orderId': ORDER }).lean();
        console.log(`Order notifications for ${ORDER}: ${n.length}`);
        n.forEach(x => console.log(`  ${x.title} | status=${x.status} | branch=${x.branch}`));
        await mongoose.connection.close();
        return;
    }

    await Notification.deleteMany({ restaurant: TENANT, 'meta.orderId': ORDER });
    await Notification.create({
        restaurant: TENANT, branch: BRANCH,
        recipientRole: 'waiter',
        title: 'Order Ready for Pickup',
        description: `Order ${ORDER} (Table IN-02) is ready to serve.`,
        category: 'Order', priority: 'high',
        meta: { orderId: ORDER, table: 'IN-02' },
    });
    console.log(`Created Order notification for ${ORDER}.`);
    await mongoose.connection.close();
})().catch(e => { console.error(e); process.exit(1); });
