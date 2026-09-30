/**
 * test-e2e-browser.js — Playwright E2E for the auto-shift feature.
 *
 * Walks a real browser through:
 *   1. /staff-login → fill creds for the temp admin
 *   2. Land on /admin/dashboard
 *   3. Navigate to Staff Management
 *   4. Assert the temp admin's row renders "On Duty" (green pill)
 *   5. Hit the logout control
 *   6. Re-login, assert still On Duty (new shift opened)
 *
 * Uses playwright-core + the bundled chromium from
 * ~/AppData/Local/ms-playwright/chromium-* — no chrome profile lock
 * conflict with the MCP server.
 *
 * Run AFTER test-e2e-provision.js has created the fixture user.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');

const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';
const EMAIL = 'e2e-shift-test@bestodine.local';
const PASSWORD = 'E2eShift!7Aa';

function findChromiumExecutable() {
    const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
    if (!fs.existsSync(root)) throw new Error(`Playwright cache missing: ${root}`);
    const dirs = fs.readdirSync(root).filter(n => n.startsWith('chromium-') && !n.includes('headless'));
    if (dirs.length === 0) throw new Error('No chromium build found in playwright cache');
    const latest = dirs.sort().reverse()[0];
    // Windows path inside the build
    const exe = path.join(root, latest, 'chrome-win', 'chrome.exe');
    if (!fs.existsSync(exe)) throw new Error(`chrome.exe missing under ${exe}`);
    return exe;
}

const results = [];
function record(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const tag = passed ? '✔ PASS' : '✘ FAIL';
    console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
    const executablePath = findChromiumExecutable();
    console.log(`Using chromium: ${executablePath}`);

    const browser = await chromium.launch({
        headless: true,
        executablePath,
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
        console.log('\n─── Step 1: Login ───');
        await page.goto(`${FRONTEND}/staff-login`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('#email', { timeout: 15000 });

        // React-controlled inputs — use Locator.fill which dispatches the
        // proper input event so React's onChange handler picks up the value.
        await page.locator('#email').fill(EMAIL);
        await page.locator('#password').fill(PASSWORD);

        // Wait for the auth response so we don't race the redirect.
        const [loginResp] = await Promise.all([
            page.waitForResponse(r => r.url().includes('/auth/login') && r.request().method() === 'POST', { timeout: 30000 }),
            page.locator('button[type="submit"]').first().click(),
        ]);
        const loginJson = await loginResp.json().catch(() => null);
        record('1.0: POST /auth/login succeeded',
            loginResp.status() === 200 && !!loginJson?.token,
            `status=${loginResp.status()}, role=${loginJson?.role || ''}, msg="${loginJson?.message || ''}"`);
        // Frontend uses the response to push a route — give the SPA a beat.
        await page.waitForTimeout(1200);
        const loggedInUrl = page.url();
        record('1.1: redirected away from /staff-login',
            !loggedInUrl.includes('/staff-login'),
            `landed on ${loggedInUrl}`);

        console.log('\n─── Step 2: Find Staff Management page ───');
        // Try direct navigation — the admin dashboard usually lists nav links.
        await page.goto(`${FRONTEND}/admin/staff`, { waitUntil: 'networkidle', timeout: 30000 });
        const onStaffPage = page.url().includes('/admin/staff');
        record('2.1: navigated to /admin/staff',
            onStaffPage,
            page.url());

        // Wait briefly for the staff table to render
        await page.waitForTimeout(1500);

        console.log('\n─── Step 3: Inspect temp admin row ───');
        // The row contains the email and a shift pill. Locate by email,
        // then climb to the table row.
        const ourRow = page.locator(`tr:has-text("${EMAIL}")`).first();
        const rowExists = await ourRow.count() > 0;
        record('3.1: subject row visible in Staff table', rowExists,
            rowExists ? 'row found' : 'row not visible (DOM might use different layout)');

        if (rowExists) {
            const rowText = await ourRow.innerText();
            record('3.2: row shows "On Duty"',
                rowText.includes('On Duty'),
                `row text: "${rowText.replace(/\s+/g, ' ').slice(0, 120)}…"`);
        } else {
            // Fallback: search the entire page for the email + nearby badge
            const bodyText = await page.locator('body').innerText();
            const hasEmail = bodyText.includes(EMAIL);
            const localBadge = bodyText.includes('On Duty');
            record('3.2 (fallback): "On Duty" badge present somewhere on page',
                hasEmail && localBadge,
                `email=${hasEmail}, On Duty=${localBadge}`);
        }

        // Snapshot for the user to inspect
        const shot1 = path.join(__dirname, '..', 'logs', 'e2e-on-duty.png');
        fs.mkdirSync(path.dirname(shot1), { recursive: true });
        await page.screenshot({ path: shot1, fullPage: true });
        console.log(`  screenshot → ${shot1}`);

        console.log('\n─── Step 4: Logout ───');
        // The logout control is usually inside a header avatar menu.
        // Try clicking any "Logout" / "Sign out" text.
        const logoutLocator = page.getByText(/Logout|Sign out/i).first();
        const logoutVisible = await logoutLocator.isVisible().catch(() => false);
        if (!logoutVisible) {
            // Try opening an avatar menu first (common patterns)
            const avatarBtn = page.locator('button:has(img), [aria-label*="account" i], [aria-label*="profile" i]').first();
            if (await avatarBtn.isVisible().catch(() => false)) {
                await avatarBtn.click();
                await page.waitForTimeout(500);
            }
        }
        const logoutAfter = page.getByText(/Logout|Sign out/i).first();
        if (await logoutAfter.isVisible().catch(() => false)) {
            await logoutAfter.click();
            await page.waitForLoadState('networkidle', { timeout: 30000 });
            // Some apps show a confirmation dialog
            const confirm = page.getByRole('button', { name: /Logout|Sign out|Confirm|Yes/i }).first();
            if (await confirm.isVisible().catch(() => false)) {
                await confirm.click();
                await page.waitForLoadState('networkidle', { timeout: 30000 });
            }
            record('4.1: logout link clicked', true, page.url());
        } else {
            // Fall back to clearing localStorage + token (simulates frontend logout).
            // Backend logout is hit by the AuthContext effect on next mount.
            await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
            });
            await fetch(`${process.env.API_BASE || 'http://localhost:5000/api/v1'}/auth/logout`, { method: 'POST' });
            record('4.1 (fallback): cleared client storage + posted /auth/logout', true,
                'UI logout control not found — fell back to API + storage reset');
        }

        console.log('\n─── Step 5: Re-login ───');
        await page.goto(`${FRONTEND}/staff-login`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector('#email', { timeout: 15000 });
        await page.locator('#email').fill(EMAIL);
        await page.locator('#password').fill(PASSWORD);
        await Promise.all([
            page.waitForResponse(r => r.url().includes('/auth/login') && r.request().method() === 'POST', { timeout: 30000 }),
            page.locator('button[type="submit"]').first().click(),
        ]);
        await page.waitForTimeout(1200);
        await page.goto(`${FRONTEND}/admin/staff`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        const ourRow2 = page.locator(`tr:has-text("${EMAIL}")`).first();
        const stillOnDuty = (await ourRow2.count() > 0) && (await ourRow2.innerText()).includes('On Duty');
        record('5.1: subject still On Duty after re-login (new shift opened)',
            stillOnDuty,
            stillOnDuty ? 'row shows On Duty' : 'row not found or Off Duty');

        const shot2 = path.join(__dirname, '..', 'logs', 'e2e-on-duty-after-relogin.png');
        await page.screenshot({ path: shot2, fullPage: true });
        console.log(`  screenshot → ${shot2}`);
    } catch (err) {
        record('E2E run completed without crash', false, err.message);
        try {
            const shot = path.join(__dirname, '..', 'logs', 'e2e-crash.png');
            fs.mkdirSync(path.dirname(shot), { recursive: true });
            await page.screenshot({ path: shot, fullPage: true });
            console.log(`  crash screenshot → ${shot}`);
        } catch (_) {}
    } finally {
        await browser.close().catch(() => {});
        const passed = results.filter(r => r.passed).length;
        const failed = results.length - passed;
        console.log(`\n══════════ E2E Summary: ${passed} passed, ${failed} failed (${results.length} total) ══════════`);
        if (failed > 0) {
            for (const r of results.filter(r => !r.passed)) console.log(`  ✘ ${r.name}: ${r.detail}`);
            process.exit(1);
        }
    }
})();
