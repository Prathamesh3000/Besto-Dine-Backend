/**
 * Mongo lifecycle for an integration test file. Always connects to the
 * per-file database on the in-memory replica set (helpers/env.js), and
 * refuses any other URI.
 */
const mongoose = require('mongoose');

async function connect() {
    global.assertInMemoryMongo(process.env.MONGO_URL);
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
    global.assertInMemoryMongo(`mongodb://${mongoose.connection.host}:${mongoose.connection.port}/`);
}

/**
 * Create every registered model's collection and build its indexes
 * (unique idempotency keys etc. must exist before the tests race on them,
 * and collections must exist before multi-document transactions write
 * to them). Call after the app (and so every model) has been required.
 */
async function initModels() {
    for (const name of mongoose.modelNames()) {
        const model = mongoose.model(name);
        try { await model.createCollection(); } catch (err) {
            if (err?.codeName !== 'NamespaceExists') throw err;
        }
        await model.init();
    }
}

async function clearDatabase() {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
}

async function disconnect() {
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.dropDatabase();
    }
    await mongoose.disconnect();
}

module.exports = { connect, initModels, clearDatabase, disconnect };
