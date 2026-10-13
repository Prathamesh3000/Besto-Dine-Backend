/**
 * Mongo lifecycle for an integration test file. Always connects to the
 * per-file database on the in-memory replica set (helpers/env.js), and
 * refuses any other URI.
 */
const os = require('os');
const mongoose = require('mongoose');

// mongodb >= 7.7 loads its default `os` adapter with a dynamic `import()`
// (lib/runtime_adapters.js). Jest's CommonJS runtime cannot perform that
// import, the rejection is squashed, the client metadata resolves to {}
// and every connect fails with "Missing required sub-document 'driver'
// in the client metadata document". Supplying the adapter explicitly
// (a documented MongoClient option, passed through by mongoose) skips
// the dynamic import. Harmless on older drivers.
const DRIVER_RUNTIME_ADAPTERS = { runtimeAdapters: { os } };

async function connect() {
    global.assertInMemoryMongo(process.env.MONGO_URL);
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000, ...DRIVER_RUNTIME_ADAPTERS });
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
