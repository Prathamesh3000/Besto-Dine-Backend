/**
 * Module mocks shared by every integration suite (setupFilesAfterEnv).
 *
 *  - razorpay: never talk to the real gateway; tests stub the shared
 *    instance (helpers/razorpayMock.js).
 *  - utils/rateLimitStore: limiters become pass-through. Rate limiting is
 *    per-IP / per-actor and every supertest request comes from 127.0.0.1,
 *    so the real limits (e.g. 5 order creates per minute per table) would
 *    make the suites order-dependent. The limiter wiring itself is not
 *    what these suites exercise.
 *  - utils/logger: silent (the real one writes to Backend/logs). Every
 *    call is recorded in `logger.__records` so a test can read dev-only
 *    log lines (the OTP suite reads the "[DEV] OTP for ..." line).
 *    Set INTEGRATION_LOGS=1 to also print warn/error lines.
 */

jest.mock('razorpay', () => require('./razorpayMock').Razorpay);

jest.mock('../../../utils/rateLimitStore', () => {
    const passThrough = (req, res, next) => next();
    return {
        makeLimiter: () => passThrough,
        close: async () => {},
    };
});

jest.mock('../../../utils/logger', () => {
    const records = [];
    const verbose = process.env.INTEGRATION_LOGS === '1';
    const make = (level) => (...args) => {
        records.push({ level, args });
        if (records.length > 5000) records.splice(0, records.length - 5000);
        if (verbose && (level === 'error' || level === 'warn')) {
            // eslint-disable-next-line no-console
            console.log(`[app ${level}]`, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
        }
    };
    const logger = {
        error: make('error'),
        warn: make('warn'),
        info: make('info'),
        http: make('http'),
        verbose: make('verbose'),
        debug: make('debug'),
        silly: make('silly'),
        log: (level, ...args) => make(level)(...args),
        child: () => logger,
        __records: records,
    };
    return logger;
});
