module.exports = async function globalTeardown() {
    const replSet = globalThis.__BD_MONGO_REPLSET__;
    if (replSet) await replSet.stop();
};
