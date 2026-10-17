/**
 * utils/stagingGuard — the check that keeps seedStaging / staging-db /
 * staging-health off the production Atlas cluster.
 *
 *   isStagingMongoUrl(url)  true only for db "bestodine_staging" on a local
 *                           host (or a host whose name contains "staging"),
 *                           never when the URL mentions "bestodine-in"
 *   assertStagingDb(url)    throws a loud error otherwise
 *
 * Pure functions — no DB, no network, no env.
 */
const {
    isStagingMongoUrl,
    assertStagingDb,
    parseMongoUrl,
    redactMongoUrl,
    STAGING_DB_NAME,
} = require('../utils/stagingGuard');

describe('utils/stagingGuard', () => {
    describe('isStagingMongoUrl — accepts', () => {
        test.each([
            ['the documented local URL', 'mongodb://127.0.0.1:27018/bestodine_staging'],
            ['localhost', 'mongodb://localhost:27018/bestodine_staging'],
            ['default port', 'mongodb://127.0.0.1/bestodine_staging'],
            ['query string', 'mongodb://127.0.0.1:27018/bestodine_staging?replicaSet=staging&directConnection=true'],
            ['credentials', 'mongodb://user:p%40ss@127.0.0.1:27018/bestodine_staging'],
            ['IPv6 loopback', 'mongodb://[::1]:27018/bestodine_staging'],
            ['surrounding whitespace', '  mongodb://127.0.0.1:27018/bestodine_staging \n'],
            ['an Atlas cluster whose host contains "staging"',
                'mongodb+srv://app:secret@bestodine-staging.ab1cd.mongodb.net/bestodine_staging?retryWrites=true&w=majority'],
            ['a replica-set host list that is all local',
                'mongodb://127.0.0.1:27018,localhost:27019/bestodine_staging?replicaSet=rs0'],
        ])('%s', (_label, url) => {
            expect(isStagingMongoUrl(url)).toBe(true);
        });
    });

    describe('isStagingMongoUrl — rejects', () => {
        test.each([
            ['the production cluster', 'mongodb+srv://app:secret@bestodine-in.ab1cd.mongodb.net/bestodine?retryWrites=true'],
            ['the production cluster even with the staging db name',
                'mongodb+srv://app:secret@bestodine-in.ab1cd.mongodb.net/bestodine_staging'],
            ['production marker anywhere in the URL',
                'mongodb://127.0.0.1:27018/bestodine_staging?appName=bestodine-in'],
            ['local host but the production/dev db name', 'mongodb://127.0.0.1:27017/bestodine'],
            ['local host with no db name', 'mongodb://127.0.0.1:27018/'],
            ['local host with no path at all', 'mongodb://127.0.0.1:27018'],
            ['db name that merely starts with the staging name', 'mongodb://127.0.0.1:27018/bestodine_staging2'],
            ['db name with different case', 'mongodb://127.0.0.1:27018/Bestodine_Staging'],
            ['a remote host without "staging" in its name',
                'mongodb+srv://app:secret@cluster0.ab1cd.mongodb.net/bestodine_staging'],
            ['a public IP', 'mongodb://203.0.113.10:27017/bestodine_staging'],
            ['a host list where one member is remote',
                'mongodb://127.0.0.1:27018,db.example.com:27017/bestodine_staging'],
            ['"staging" only in the db name, not the host', 'mongodb://db.example.com/bestodine_staging'],
            ['"staging" only in the credentials', 'mongodb://staging:pw@db.example.com/bestodine_staging'],
            ['a non-mongo URL', 'postgres://127.0.0.1/bestodine_staging'],
            ['garbage', 'not a url'],
            ['empty string', ''],
        ])('%s', (_label, url) => {
            expect(isStagingMongoUrl(url)).toBe(false);
        });

        test.each([undefined, null, 42, {}, []])('non-string input %p', (input) => {
            expect(isStagingMongoUrl(input)).toBe(false);
        });
    });

    describe('assertStagingDb', () => {
        test('returns the url when it is staging', () => {
            const url = 'mongodb://127.0.0.1:27018/bestodine_staging';
            expect(assertStagingDb(url, 'test')).toBe(url);
        });

        test('throws a loud, descriptive error for production', () => {
            const url = 'mongodb+srv://app:secret@bestodine-in.ab1cd.mongodb.net/bestodine';
            expect(() => assertStagingDb(url, 'seedStaging')).toThrow(/REFUSING TO RUN/);
            expect(() => assertStagingDb(url, 'seedStaging')).toThrow(/seedStaging/);
            expect(() => assertStagingDb(url, 'seedStaging')).toThrow(new RegExp(STAGING_DB_NAME));
        });

        test('never echoes credentials in the error', () => {
            const url = 'mongodb+srv://app:TOPSECRET@bestodine-in.ab1cd.mongodb.net/bestodine';
            let message = '';
            try { assertStagingDb(url); } catch (err) { message = err.message; }
            expect(message).not.toContain('TOPSECRET');
            expect(message).toContain('***@');
        });

        test('throws for a missing MONGO_URL', () => {
            expect(() => assertStagingDb(undefined, 'x')).toThrow(/\(empty\)/);
        });
    });

    describe('helpers', () => {
        test('parseMongoUrl splits hosts and db name', () => {
            expect(parseMongoUrl('mongodb://u:p@a.example.com:1,b.example.com:2/mydb?x=1')).toEqual({
                protocol: 'mongodb',
                hosts: ['a.example.com', 'b.example.com'],
                dbName: 'mydb',
            });
            expect(parseMongoUrl('mongodb+srv://h.example.net/db')).toMatchObject({ protocol: 'mongodb+srv', hosts: ['h.example.net'] });
            expect(parseMongoUrl('http://x')).toBeNull();
            expect(parseMongoUrl(null)).toBeNull();
        });

        test('redactMongoUrl hides user:pass', () => {
            expect(redactMongoUrl('mongodb://u:p@h/db')).toBe('mongodb://***@h/db');
            expect(redactMongoUrl('mongodb://h/db')).toBe('mongodb://h/db');
        });
    });
});
