/**
 * Jest config for the integration suites in __tests__/integration.
 *
 *   npm run test:integration
 *
 * Every suite runs the real Express app (see
 * __tests__/integration/helpers/createTestApp.js) against a throw-away
 * MongoDB replica set from mongodb-memory-server (transactions need a
 * replica set). The replica set is started once in globalSetup; each
 * test file gets its own database on it. The real MONGO_URL from .env is
 * never used — helpers/env.js overrides it before any app code loads and
 * refuses to continue unless it points at the in-memory server.
 *
 * The unit run (`npm test`, package.json "jest" field) ignores this
 * directory.
 */
module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/__tests__/integration/**/*.test.js'],
    globalSetup: '<rootDir>/__tests__/integration/helpers/globalSetup.js',
    globalTeardown: '<rootDir>/__tests__/integration/helpers/globalTeardown.js',
    setupFiles: ['<rootDir>/__tests__/integration/helpers/env.js'],
    setupFilesAfterEnv: ['<rootDir>/__tests__/integration/helpers/mocks.js'],
    // Some dependencies are ESM-only (uuid@13, sanitize-html → htmlparser2
    // …) and Jest's CommonJS runtime cannot require() them. node_modules
    // files go through a transformer that converts ESM syntax to CJS
    // (and passes everything else through untouched); our own files keep
    // the default babel-jest.
    transform: {
        '[\\\\/]node_modules[\\\\/].+\\.m?js$': '<rootDir>/__tests__/integration/helpers/esmTransformer.js',
        '^.+\\.[jt]sx?$': 'babel-jest',
    },
    transformIgnorePatterns: [],
    testTimeout: 60000,
};
