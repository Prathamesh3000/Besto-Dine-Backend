/**
 * Test app factory — builds the REAL app through Backend/app.js
 * createApp() (the same wiring server.js uses: middleware stack, /api/v1
 * router, /api catch-all, health probes, error handlers), attaches
 * socket.io through the real utils/socket.init() and listens on an
 * ephemeral 127.0.0.1 port.
 *
 * Not involved (they live in server.js, not app.js): mongoose.connect +
 * boot migrations (tests connect via helpers/db.js), dns.setServers,
 * every background scheduler, server.listen(PORT) and the process-level
 * signal / unhandledRejection handlers.
 *
 * Test-only overrides are module mocks (helpers/mocks.js, applied before
 * app.js is required): rate limiters are pass-through, the logger is
 * silent + recorded, razorpay is stubbed.
 */
const http = require('http');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..', '..');
const app_ = (rel) => require(path.join(BACKEND, rel));

function buildApp() {
    // server.js runs this boot check (and exits on failure); keep the
    // test env honest the same way.
    app_('config').assertProductionConfig();
    return app_('app').createApp();
}

/**
 * Build the app, attach socket.io exactly like server.js, and listen on
 * an ephemeral 127.0.0.1 port. Returns { app, server, io, baseUrl, close }.
 */
async function createTestApp() {
    const { app, allowedOrigins } = buildApp();
    const server = http.createServer(app);
    const socketUtil = app_('utils/socket');
    const io = socketUtil.init(server, allowedOrigins);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    async function close() {
        await socketUtil.close();                       // closes io + the http server
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }

    return { app, server, io, baseUrl, close };
}

module.exports = { createTestApp, buildApp };
