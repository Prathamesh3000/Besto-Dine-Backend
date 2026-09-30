require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Shift = require('../models/shift');

const TEMP_EMAIL = 'e2e-shift-test@bestodine.local';
(async () => {
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 30000, family: 4 });
    const u = await User.findOne({ email: TEMP_EMAIL });
    if (u) {
        await Shift.deleteMany({ staff: u._id });
        await User.deleteOne({ _id: u._id });
        console.log(`✔ removed ${TEMP_EMAIL} + shifts`);
    } else {
        console.log(`= ${TEMP_EMAIL} already gone`);
    }
    await mongoose.disconnect();
})();
