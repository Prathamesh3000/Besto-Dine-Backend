/**
 * Starts ONE single-node MongoMemoryReplSet for the whole integration
 * run (the app uses multi-document transactions, which need a replica
 * set). Each test file then uses its own database on it (helpers/env.js).
 *
 * The URI is handed to test files through process.env.INTEGRATION_MONGO_URI.
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
    const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await replSet.waitUntilRunning();
    const uri = replSet.getUri();
    if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri)) {
        await replSet.stop();
        throw new Error(`Refusing to run integration tests: unexpected in-memory URI ${uri}`);
    }
    globalThis.__BD_MONGO_REPLSET__ = replSet;
    process.env.INTEGRATION_MONGO_URI = uri;
};
