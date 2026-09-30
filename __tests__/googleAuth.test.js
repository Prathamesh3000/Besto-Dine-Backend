/**
 * Google ID-token verification.
 *
 * These tests generate a real RSA keypair, mint real JWTs with it, and
 * stub Google's JWKS endpoint to publish the matching public key. So
 * the signature path exercised here is the genuine one — not a mock of
 * our own logic.
 *
 * The audience test is the important one. `aud` is what ties a token to
 * THIS application. Without that check, an ID token issued to any other
 * Google app — including one an attacker registers in two minutes —
 * would be accepted, and anyone could sign in as anyone. Every other
 * check in the file is a defence in depth; that one is the lock.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

jest.mock('../utils/logger', () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const { verifyGoogleIdToken, isGoogleAuthConfigured, _resetJwksCache } =
    require('../utils/googleAuth');

const OUR_CLIENT_ID = '1234567890-ours.apps.googleusercontent.com';
const KID = 'test-key-1';

// One keypair for the whole suite — generation is the slow part.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
});

/** Google publishes public keys as JWKs; mirror that shape exactly. */
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

function mintToken(claims = {}, { kid = KID, alg = 'RS256', key = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
        {
            iss: 'https://accounts.google.com',
            aud: OUR_CLIENT_ID,
            sub: '110000000000000000001',
            email: 'diner@example.com',
            email_verified: true,
            name: 'Test Diner',
            iat: now,
            exp: now + 3600,
            ...claims,
        },
        key,
        { algorithm: alg, header: { kid, alg } },
    );
}

/** Stub the JWKS endpoint. */
function stubJwks(keys = [publicJwk]) {
    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ keys }),
        headers: { get: () => 'max-age=3600' },
    });
}

beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = OUR_CLIENT_ID;
    _resetJwksCache();
    stubJwks();
});

afterEach(() => {
    delete global.fetch;
});

describe('configuration', () => {
    test('reports configured when a client id is present', () => {
        expect(isGoogleAuthConfigured()).toBe(true);
    });

    test('reports unconfigured when the client id is missing', () => {
        delete process.env.GOOGLE_CLIENT_ID;
        expect(isGoogleAuthConfigured()).toBe(false);
    });

    test('refuses to verify anything when unconfigured', async () => {
        delete process.env.GOOGLE_CLIENT_ID;
        await expect(verifyGoogleIdToken(mintToken())).rejects.toThrow(/not configured/i);
    });
});

describe('a genuine token', () => {
    test('is accepted and its claims normalised', async () => {
        const profile = await verifyGoogleIdToken(mintToken());
        expect(profile).toMatchObject({
            googleId: '110000000000000000001',
            email: 'diner@example.com',
            emailVerified: true,
            name: 'Test Diner',
        });
    });

    test('lower-cases the email', async () => {
        // Google may echo the address as the user typed it; downstream
        // lookups assume lower-case because that's how User stores it.
        const profile = await verifyGoogleIdToken(mintToken({ email: 'Diner@Example.COM' }));
        expect(profile.email).toBe('diner@example.com');
    });

    test('treats the string "true" as verified', async () => {
        // Some Google surfaces send email_verified as a string.
        const profile = await verifyGoogleIdToken(mintToken({ email_verified: 'true' }));
        expect(profile.emailVerified).toBe(true);
    });

    test('reports an unverified email as unverified rather than throwing', async () => {
        // The token is valid; it's the LINKING decision that cares.
        // googleLogin owns that call, so verification must pass it on.
        const profile = await verifyGoogleIdToken(mintToken({ email_verified: false }));
        expect(profile.emailVerified).toBe(false);
    });

    test('accepts the bare accounts.google.com issuer form', async () => {
        const profile = await verifyGoogleIdToken(mintToken({ iss: 'accounts.google.com' }));
        expect(profile.googleId).toBeTruthy();
    });
});

describe('audience — the check that stops impersonation', () => {
    test('rejects a token minted for a DIFFERENT Google app', async () => {
        // The attack this prevents: register your own Google app, sign
        // a victim in, and replay their ID token here. Valid signature,
        // valid issuer, real Google — wrong audience.
        const attackerToken = mintToken({ aud: '9999-attacker.apps.googleusercontent.com' });
        await expect(verifyGoogleIdToken(attackerToken)).rejects.toThrow();
    });

    test('accepts any client id in a comma-separated list', async () => {
        // Lets one backend serve web + Android + iOS client ids.
        process.env.GOOGLE_CLIENT_ID = `other.apps.googleusercontent.com, ${OUR_CLIENT_ID}`;
        const profile = await verifyGoogleIdToken(mintToken());
        expect(profile.googleId).toBeTruthy();
    });
});

describe('forged and malformed tokens', () => {
    test('rejects a token signed by a key Google never published', async () => {
        const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const forged = mintToken({}, { key: attacker.privateKey });
        await expect(verifyGoogleIdToken(forged)).rejects.toThrow();
    });

    test('rejects an HS256 token — no algorithm confusion', async () => {
        // The classic attack: re-sign using the PUBLIC key as an HMAC
        // secret. Only possible if the verifier honours the token's own
        // alg header instead of pinning RS256.
        const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
        const forged = jwt.sign(
            { iss: 'https://accounts.google.com', aud: OUR_CLIENT_ID, sub: 'x', email: 'a@b.com' },
            pubPem,
            { algorithm: 'HS256', header: { kid: KID, alg: 'HS256' } },
        );
        await expect(verifyGoogleIdToken(forged)).rejects.toThrow();
    });

    test('rejects an expired token', async () => {
        const past = Math.floor(Date.now() / 1000) - 7200;
        await expect(
            verifyGoogleIdToken(mintToken({ iat: past, exp: past + 3600 })),
        ).rejects.toThrow();
    });

    test('rejects a token from the wrong issuer', async () => {
        await expect(
            verifyGoogleIdToken(mintToken({ iss: 'https://evil.example.com' })),
        ).rejects.toThrow();
    });

    test('rejects a token whose kid matches no published key', async () => {
        await expect(
            verifyGoogleIdToken(mintToken({}, { kid: 'unknown-kid' })),
        ).rejects.toThrow(/signing key/i);
    });

    test.each([
        ['empty string', ''],
        ['null', null],
        ['a non-JWT string', 'not-a-token'],
    ])('rejects %s', async (_label, value) => {
        await expect(verifyGoogleIdToken(value)).rejects.toThrow();
    });

    test('rejects a token with no subject claim', async () => {
        await expect(verifyGoogleIdToken(mintToken({ sub: undefined }))).rejects.toThrow(/subject/i);
    });

    test('rejects a token carrying no email', async () => {
        await expect(verifyGoogleIdToken(mintToken({ email: undefined }))).rejects.toThrow(/email/i);
    });
});

describe('key rotation', () => {
    test('caches the key set instead of refetching per verification', async () => {
        await verifyGoogleIdToken(mintToken());
        await verifyGoogleIdToken(mintToken());
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('refetches once when a token arrives signed by an unseen key', async () => {
        // Warm the cache with a key set that lacks our kid…
        stubJwks([{ ...publicJwk, kid: 'stale-key' }]);
        await expect(verifyGoogleIdToken(mintToken())).rejects.toThrow();
        // …two calls: the initial fetch, then one cache-bust retry.
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('surfaces a JWKS outage as a failure, never as a pass', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({}),
            headers: { get: () => null },
        });
        await expect(verifyGoogleIdToken(mintToken())).rejects.toThrow(/JWKS/i);
    });
});
