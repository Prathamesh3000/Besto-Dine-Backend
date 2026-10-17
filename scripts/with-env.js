#!/usr/bin/env node
/**
 * with-env.js — run a command with an env file pre-loaded.
 *
 *   node scripts/with-env.js <envfile> <command> [args...]
 *   node scripts/with-env.js .env.staging node server.js
 *
 * Why: config/index.js loads Backend/.env with dotenv, and dotenv never
 * overrides a variable that is already in process.env. Loading another
 * file FIRST therefore wins over .env without any code change, and it
 * works identically from PowerShell, cmd and Git Bash (no `VAR=x cmd`).
 *
 * Rules:
 *   - `override: false` — a variable already set in the shell still wins
 *     over the file (so `PORT=5002 npm run start:staging` works in bash).
 *   - The env file path is resolved relative to Backend/ (this script's
 *     parent), so the cwd does not matter.
 *   - stdio is inherited and the child's exit code / signal is forwarded.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

const BACKEND = path.join(__dirname, '..');
const [envFileArg, command, ...args] = process.argv.slice(2);

if (!envFileArg || !command) {
    console.error('usage: node scripts/with-env.js <envfile> <command> [args...]');
    process.exit(2);
}

const envFile = path.isAbsolute(envFileArg) ? envFileArg : path.join(BACKEND, envFileArg);
if (!fs.existsSync(envFile)) {
    console.error(`with-env: env file not found: ${envFile}`);
    process.exit(2);
}

const result = dotenv.config({ path: envFile, override: false });
if (result.error) {
    console.error(`with-env: failed to load ${envFile}: ${result.error.message}`);
    process.exit(2);
}
process.env.WITH_ENV_FILE = envFile;

// On Windows, `npm`, `nodemon` etc. are .cmd shims — spawn needs a shell
// for those. `node` is a real executable everywhere.
const needsShell = process.platform === 'win32' && !/^node(\.exe)?$/i.test(path.basename(command));
const child = spawn(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
    shell: needsShell,
});

// Forward termination signals so Ctrl+C stops the child cleanly.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { if (!child.killed) child.kill(sig); });
}

child.on('error', (err) => {
    console.error(`with-env: failed to start "${command}": ${err.message}`);
    process.exit(1);
});
child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code == null ? 1 : code);
});
