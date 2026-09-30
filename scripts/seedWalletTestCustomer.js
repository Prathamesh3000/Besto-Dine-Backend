// One-off: ensure a test customer exists with wallet balance >= 100 at hotel-tip-top.
// Used by Playwright CUS-041 (concurrent wallet redeem) test.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const Wallet = require('../models/wallet');
const Restaurant = require('../models/restaurant');

const SLUG = 'hotel-tip-top';
const EMAIL = 'wallet.race.test@example.com';
const PASSWORD = 'WalletRace@2026';
const MOBILE = '9876500041';
const NAME = 'Wallet Race Tester';
const TARGET_BALANCE = 250; // generous so we can redeem twice and still inspect

(async () => {
  await mongoose.connect(process.env.MONGO_URL);
  const tenant = await Restaurant.findOne({ slug: SLUG }).lean();
  if (!tenant) { console.error('Tenant not found:', SLUG); process.exit(1); }

  // Pre-save hook in the User model bcrypt-hashes `password` automatically;
  // pass the plain text and let the hook hash once.
  let user = await User.findOne({ email: EMAIL });
  if (!user) {
    user = new User({
      name: NAME,
      email: EMAIL,
      password: PASSWORD,
      mobile: MOBILE,
      role: 'customer',
      isVerified: true,
    });
    await user.save();
    console.log('CREATED user', user._id.toString());
  } else {
    user.password = PASSWORD;
    user.isVerified = true;
    await user.save();
    console.log('UPDATED user (password reset)', user._id.toString());
  }

  let wallet = await Wallet.findOne({ user: user._id, restaurant: tenant._id });
  if (!wallet) {
    wallet = await Wallet.create({
      user: user._id,
      restaurant: tenant._id,
      balance: TARGET_BALANCE,
      loyaltyPoints: 0,
      status: 'active',
    });
    console.log('CREATED wallet, balance =', wallet.balance);
  } else {
    wallet.balance = TARGET_BALANCE;
    wallet.status = 'active';
    await wallet.save();
    console.log('UPDATED wallet, balance =', wallet.balance);
  }

  console.log('\n--- TEST CREDENTIALS ---');
  console.log('email   :', EMAIL);
  console.log('password:', PASSWORD);
  console.log('slug    :', SLUG);
  console.log('balance :', wallet.balance);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
