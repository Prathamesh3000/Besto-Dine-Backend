const logger = require('./logger');

/**
 * Trigger a rebuild of the standalone marketing site.
 *
 * The marketing site is statically prerendered (vite-react-ssg) for SEO, so a
 * blog post created/edited/deleted in Super Admin only goes live after the site
 * is rebuilt. Render exposes a "Deploy Hook" URL per service — POST to it and
 * Render kicks off a fresh build, which re-fetches the published posts from
 * `/public/blog` and regenerates the static HTML + sitemap.
 *
 * Wire it up by setting MARKETING_DEPLOY_HOOK_URL in the backend .env to the
 * hook URL from Render → marketing static site → Settings → Deploy Hook.
 *
 * Best-effort and NON-FATAL: a failed (or unconfigured) hook must never break
 * the Super Admin action that triggered it. If the URL isn't set we just log a
 * debug line — useful in local dev where there's no marketing deploy to poke.
 *
 * @param {string} reason  short label for the logs, e.g. 'blog.publish'
 */
async function triggerMarketingRebuild(reason = 'content.change') {
    const hookUrl = process.env.MARKETING_DEPLOY_HOOK_URL;
    if (!hookUrl) {
        logger.debug(`Marketing rebuild skipped (${reason}) — MARKETING_DEPLOY_HOOK_URL not set`);
        return { triggered: false, reason: 'not-configured' };
    }
    try {
        const res = await fetch(hookUrl, { method: 'POST' });
        if (!res.ok) {
            logger.warn(`Marketing deploy hook returned ${res.status} (${reason})`);
            return { triggered: false, reason: `http-${res.status}` };
        }
        logger.info(`Marketing rebuild triggered (${reason})`);
        return { triggered: true };
    } catch (err) {
        logger.error(`Marketing deploy hook error (${reason}): ${err.message}`);
        return { triggered: false, reason: 'error' };
    }
}

module.exports = { triggerMarketingRebuild };
