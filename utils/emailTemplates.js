/**
 * Transactional email templates for the BestoDine SaaS platform.
 *
 * Each template function returns `{ subject, html, text }` so the
 * caller can pass the whole object straight into `sendEmail`. All
 * HTML is self-contained inline CSS — email clients strip <style>
 * blocks and link tags, so classes don't work.
 *
 * Design notes:
 *   - 600px max width, centered (industry standard for Gmail/Outlook)
 *   - Inline styles only
 *   - Dark text on white card, brand orange CTA
 *   - Every email has a plain-text fallback — Gmail's "hide quoted
 *     text" and some accessibility tools only read the text body
 */

// Frontend URL for login links — falls back to localhost for dev.
function frontendUrl() {
    return process.env.FRONTEND_URL || 'http://localhost:5173';
}

function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Restaurant onboarding welcome email.
 *
 * Sent when Super Admin creates a new tenant. Includes the one-time
 * temporary password the owner will use for their first login.
 *
 * Props: { restaurantName, ownerName, email, tempPassword, planName, trialDays }
 */
exports.restaurantWelcome = ({
    restaurantName,
    ownerName,
    email,
    tempPassword,
    planName,
    trialDays,
}) => {
    const loginUrl = `${frontendUrl()}/staff-login`;
    const safeName = escapeHtml(restaurantName || 'your restaurant');
    const safeOwner = escapeHtml(ownerName || 'there');
    const safeEmail = escapeHtml(email || '');
    const safePassword = escapeHtml(tempPassword || '');
    const safePlan = escapeHtml(planName || 'Trial');

    const trialLine = trialDays && trialDays > 0
        ? `You're on a <strong>${trialDays}-day free trial</strong>. No charges until the trial ends.`
        : '';

    const subject = `Welcome to BestoDine — ${safeName}`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A181B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
                    <!-- Header -->
                    <tr>
                        <td style="background-color:#FE8301;padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;font-size:24px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">BestoDine</h1>
                            <p style="margin:4px 0 0;font-size:13px;color:#FFE4CC;">Restaurant Management Platform</p>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="padding:40px;">
                            <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A181B;">Welcome, ${safeOwner}!</h2>
                            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#645E66;">
                                Your restaurant <strong style="color:#1A181B;">${safeName}</strong> has been set up on BestoDine.
                                You're ready to start taking orders, managing your staff, and growing your business.
                            </p>

                            ${trialLine ? `<p style="margin:0 0 24px;padding:12px 16px;background-color:#FFF5EE;border-left:3px solid #FE8301;border-radius:6px;font-size:14px;color:#1A181B;">${trialLine}</p>` : ''}

                            <!-- Credentials card -->
                            <div style="margin:0 0 24px;padding:20px;background-color:#F8F9FA;border-radius:12px;border:1px solid #E5E7EB;">
                                <p style="margin:0 0 16px;font-size:12px;font-weight:600;color:#8D848F;text-transform:uppercase;letter-spacing:0.05em;">Your Login Details</p>

                                <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Email</p>
                                <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#1A181B;word-break:break-all;">${safeEmail}</p>

                                <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Temporary Password</p>
                                <p style="margin:0 0 16px;padding:10px 14px;background-color:#FFFFFF;border-radius:6px;border:1px solid #E5E7EB;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;font-weight:700;color:#1A181B;word-break:break-all;">${safePassword}</p>

                                <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Subscription Plan</p>
                                <p style="margin:0;font-size:14px;font-weight:600;color:#1A181B;">${safePlan}</p>
                            </div>

                            <!-- CTA -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;">
                                <tr>
                                    <td style="background-color:#FE8301;border-radius:10px;">
                                        <a href="${loginUrl}"
                                            style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">
                                            Log in to your dashboard
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <!-- Security notice -->
                            <div style="padding:16px;background-color:#FFF8E1;border-radius:8px;border-left:3px solid #F5B400;">
                                <p style="margin:0;font-size:13px;line-height:1.5;color:#7A5D00;">
                                    <strong>Important:</strong> You'll be asked to change your password on first login.
                                    Keep this email confidential — don't forward it or share the temporary password with anyone.
                                </p>
                            </div>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding:24px 40px;background-color:#FAFAFA;border-top:1px solid #F2F4F7;text-align:center;">
                            <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Need help? Reply to this email and we'll get back to you.</p>
                            <p style="margin:0;font-size:11px;color:#B0ACB5;">© BestoDine · Restaurant Management Platform</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const text = [
        `Welcome to BestoDine, ${ownerName || 'there'}!`,
        ``,
        `Your restaurant "${restaurantName}" has been set up. You're ready to start taking orders and managing your business.`,
        ``,
        trialLine ? `You're on a ${trialDays}-day free trial. No charges until the trial ends.` : '',
        ``,
        `── Login Details ──`,
        `Email: ${email}`,
        `Temporary Password: ${tempPassword}`,
        `Subscription Plan: ${planName || 'Trial'}`,
        ``,
        `Log in here: ${loginUrl}`,
        ``,
        `Important: You'll be asked to change your password on first login. Keep this email confidential — don't forward it or share the temporary password.`,
        ``,
        `Need help? Reply to this email.`,
        ``,
        `— The BestoDine Team`,
    ].filter(l => l !== '').join('\n');

    return { subject, html, text };
};

/**
 * Self-signup welcome email — same look as restaurantWelcome but
 * WITHOUT the temp password block, because the owner set their
 * password during signup. Used by Phase 5 step 2 public
 * register-restaurant endpoint.
 *
 * Props: { restaurantName, ownerName, email, planName, trialDays }
 */
exports.restaurantSelfSignupWelcome = ({
    restaurantName,
    ownerName,
    email,
    planName,
    trialDays,
    slug,
}) => {
    const loginUrl = `${frontendUrl()}/staff-login`;
    // Public landing page (/<restaurantSlug>) — only when the slug is known.
    const pageUrl = slug ? `${frontendUrl()}/${slug}` : '';
    const safeName = escapeHtml(restaurantName || 'your restaurant');
    const safeOwner = escapeHtml(ownerName || 'there');
    const safeEmail = escapeHtml(email || '');
    const safePlan = escapeHtml(planName || 'Trial');

    const trialLine = trialDays && trialDays > 0
        ? `You're on a <strong>${trialDays}-day free trial</strong>. No charges until the trial ends.`
        : '';

    const subject = `Welcome to BestoDine — ${safeName}`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A181B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
                    <tr>
                        <td style="background-color:#FE8301;padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;font-size:24px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">BestoDine</h1>
                            <p style="margin:4px 0 0;font-size:13px;color:#FFE4CC;">Restaurant Management Platform</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:40px;">
                            <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A181B;">You're in, ${safeOwner}!</h2>
                            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#645E66;">
                                Your restaurant <strong style="color:#1A181B;">${safeName}</strong> is now live on BestoDine.
                                Log in with the email and password you just created and start taking orders.
                            </p>

                            ${trialLine ? `<p style="margin:0 0 24px;padding:12px 16px;background-color:#FFF5EE;border-left:3px solid #FE8301;border-radius:6px;font-size:14px;color:#1A181B;">${trialLine}</p>` : ''}

                            <div style="margin:0 0 24px;padding:20px;background-color:#F8F9FA;border-radius:12px;border:1px solid #E5E7EB;">
                                <p style="margin:0 0 16px;font-size:12px;font-weight:600;color:#8D848F;text-transform:uppercase;letter-spacing:0.05em;">Your Account</p>

                                <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Email</p>
                                <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#1A181B;word-break:break-all;">${safeEmail}</p>

                                <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Subscription Plan</p>
                                <p style="margin:0;font-size:14px;font-weight:600;color:#1A181B;">${safePlan}</p>

                                <p style="margin:16px 0 6px;font-size:12px;color:#8D848F;">Staff login</p>
                                <p style="margin:0;font-size:14px;font-weight:600;word-break:break-all;"><a href="${escapeHtml(loginUrl)}" style="color:#FE8301;">${escapeHtml(loginUrl)}</a></p>
                                ${pageUrl ? `<p style="margin:16px 0 6px;font-size:12px;color:#8D848F;">Your public page</p>
                                <p style="margin:0;font-size:14px;font-weight:600;word-break:break-all;"><a href="${escapeHtml(pageUrl)}" style="color:#FE8301;">${escapeHtml(pageUrl)}</a></p>` : ''}
                            </div>

                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;">
                                <tr>
                                    <td style="background-color:#FE8301;border-radius:10px;">
                                        <a href="${loginUrl}"
                                            style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">
                                            Log in to your dashboard
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin:0;font-size:13px;line-height:1.5;color:#8D848F;">
                                Need help getting started? Reply to this email — a human from our team will respond within a business day.
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:24px 40px;background-color:#FAFAFA;border-top:1px solid #F2F4F7;text-align:center;">
                            <p style="margin:0;font-size:11px;color:#B0ACB5;">© BestoDine · Restaurant Management Platform</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const text = [
        `You're in, ${ownerName || 'there'}!`,
        ``,
        `Your restaurant "${restaurantName}" is now live on BestoDine. Log in with the email and password you just created and start taking orders.`,
        ``,
        trialLine ? `You're on a ${trialDays}-day free trial. No charges until the trial ends.` : '',
        ``,
        `── Your Account ──`,
        `Email: ${email}`,
        `Subscription Plan: ${planName || 'Trial'}`,
        ``,
        `Log in here: ${loginUrl}`,
        pageUrl ? `Your public page: ${pageUrl}` : '',
        ``,
        `Need help getting started? Reply to this email — a human from our team will respond within a business day.`,
        ``,
        `— The BestoDine Team`,
    ].filter(l => l !== '').join('\n');

    return { subject, html, text };
};

/** Minimal branded wrapper for short transactional notes. */
function simpleEmailHtml(subject, bodyHtml) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A181B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:32px 16px;">
        <tr><td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;">
                <tr><td style="background-color:#FE8301;padding:24px 40px;text-align:center;">
                    <h1 style="margin:0;font-size:22px;font-weight:700;color:#FFFFFF;">BestoDine</h1>
                </td></tr>
                <tr><td style="padding:32px 40px;font-size:15px;line-height:1.6;color:#1A181B;">${bodyHtml}</td></tr>
                <tr><td style="padding:20px 40px;background-color:#FAFAFA;border-top:1px solid #F2F4F7;text-align:center;">
                    <p style="margin:0;font-size:11px;color:#B0ACB5;">© BestoDine · Restaurant Management Platform</p>
                </td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`;
}

/**
 * Sent to the owner right after a hotel self-signup is submitted.
 * Props: { restaurantName, ownerName, email, slug }
 */
exports.signupApplicationReceived = ({ restaurantName, ownerName, email, slug }) => {
    const pageUrl = `${frontendUrl()}/${slug}`;
    const subject = `We've received your application — ${restaurantName}`;
    const html = simpleEmailHtml(subject, `
        <h2 style="margin:0 0 12px;font-size:20px;">Thanks, ${escapeHtml(ownerName || 'there')}!</h2>
        <p style="margin:0 0 16px;">We've received your application to list <strong>${escapeHtml(restaurantName)}</strong> on BestoDine.
        Our team is reviewing it now — this usually takes <strong>within 1 business day</strong>.</p>
        <p style="margin:0 0 16px;">Once approved, your restaurant page will be live at<br>
        <a href="${escapeHtml(pageUrl)}" style="color:#FE8301;font-weight:600;word-break:break-all;">${escapeHtml(pageUrl)}</a></p>
        <p style="margin:0 0 16px;">We'll email you at <strong>${escapeHtml(email)}</strong> as soon as your account is approved, and you can then log in with the password you chose.</p>
        <p style="margin:0;font-size:13px;color:#8D848F;">Questions? Just reply to this email.</p>`);
    const text = [
        `Thanks, ${ownerName || 'there'}!`,
        '',
        `We've received your application to list "${restaurantName}" on BestoDine.`,
        'Our team is reviewing it now — this usually takes within 1 business day.',
        '',
        `Once approved, your restaurant page will be live at: ${pageUrl}`,
        '',
        `We'll email you at ${email} as soon as your account is approved, and you can then log in with the password you chose.`,
        '',
        '— The BestoDine Team',
    ].join('\n');
    return { subject, html, text };
};

/**
 * Sent to Super Admins (SUPERADMIN_ALERT_EMAILS) when a new hotel
 * self-signup is waiting in Pending Approvals.
 * Props: { restaurantName, slug, ownerName, email, phone, city, planName, source }
 */
exports.signupAdminAlert = ({ restaurantName, slug, ownerName, email, phone, city, planName, source }) => {
    const reviewUrl = `${frontendUrl()}/superadmin/pending-approvals`;
    const subject = `New hotel signup awaiting approval: ${restaurantName}`;
    const rows = [
        ['Restaurant', restaurantName],
        ['URL', `${frontendUrl()}/${slug}`],
        ['Owner', ownerName],
        ['Email', email],
        ['Phone', phone],
        ['City', city],
        ['Requested plan', planName || '—'],
        ['Source', source || '—'],
    ];
    const html = simpleEmailHtml(subject, `
        <h2 style="margin:0 0 12px;font-size:20px;">New hotel signup</h2>
        <table role="presentation" cellpadding="4" cellspacing="0" border="0" style="font-size:14px;margin:0 0 20px;">
            ${rows.map(([k, v]) => `<tr><td style="color:#8D848F;padding-right:16px;">${escapeHtml(k)}</td><td style="font-weight:600;">${escapeHtml(v || '')}</td></tr>`).join('')}
        </table>
        <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 24px;background-color:#FE8301;border-radius:10px;color:#FFFFFF;font-weight:600;text-decoration:none;">Review in Pending Approvals</a>`);
    const text = [
        'New hotel signup awaiting approval',
        '',
        ...rows.map(([k, v]) => `${k}: ${v || ''}`),
        '',
        `Review: ${reviewUrl}`,
    ].join('\n');
    return { subject, html, text };
};

/**
 * Sent to the owner when a Super Admin rejects a hotel self-signup.
 * Props: { restaurantName, ownerName, reason }
 */
exports.signupRejected = ({ restaurantName, ownerName, reason }) => {
    const subject = `Update on your BestoDine application — ${restaurantName}`;
    const html = simpleEmailHtml(subject, `
        <h2 style="margin:0 0 12px;font-size:20px;">Hi ${escapeHtml(ownerName || 'there')},</h2>
        <p style="margin:0 0 16px;">Thank you for applying to list <strong>${escapeHtml(restaurantName)}</strong> on BestoDine.
        After reviewing your application, we're unable to approve it at this time.</p>
        <p style="margin:0 0 6px;font-size:12px;color:#8D848F;text-transform:uppercase;letter-spacing:0.05em;">Reason</p>
        <p style="margin:0 0 20px;padding:12px 16px;background-color:#FFF5EE;border-left:3px solid #FE8301;border-radius:6px;">${escapeHtml(reason)}</p>
        <p style="margin:0;">If you think this is a mistake or can share more details, just reply to this email — our team will take another look.</p>`);
    const text = [
        `Hi ${ownerName || 'there'},`,
        '',
        `Thank you for applying to list "${restaurantName}" on BestoDine. After reviewing your application, we're unable to approve it at this time.`,
        '',
        `Reason: ${reason}`,
        '',
        'If you think this is a mistake or can share more details, just reply to this email — our team will take another look.',
        '',
        '— The BestoDine Team',
    ].join('\n');
    return { subject, html, text };
};

/**
 * Suspension notice email.
 *
 * Sent when a Super Admin suspends a tenant (manual suspension, not
 * automatic Razorpay halts). The reason entered by the operator is
 * included verbatim so the owner knows exactly why access was paused.
 *
 * Props: { restaurantName, ownerName, reason }
 */
exports.restaurantSuspended = ({
    restaurantName,
    ownerName,
    reason,
}) => {
    const safeName   = escapeHtml(restaurantName || 'your restaurant');
    const safeOwner  = escapeHtml(ownerName || 'there');
    const safeReason = escapeHtml(reason || '').replace(/\n/g, '<br>');

    const subject = `Your BestoDine account has been suspended — ${safeName}`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A181B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
                    <!-- Header (muted red to signal suspension) -->
                    <tr>
                        <td style="background-color:#B91C1C;padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;font-size:24px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">BestoDine</h1>
                            <p style="margin:4px 0 0;font-size:13px;color:#FECACA;">Account Suspended</p>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="padding:40px;">
                            <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A181B;">Hi ${safeOwner},</h2>
                            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#645E66;">
                                Your BestoDine account for <strong style="color:#1A181B;">${safeName}</strong> has been
                                <strong style="color:#B91C1C;">suspended</strong>. Your staff will not be able to log in until the account is reactivated.
                            </p>

                            <!-- Reason card -->
                            <div style="margin:0 0 24px;padding:20px;background-color:#FEF2F2;border-radius:12px;border:1px solid #FECACA;border-left:4px solid #B91C1C;">
                                <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#991B1B;text-transform:uppercase;letter-spacing:0.05em;">Reason for suspension</p>
                                <p style="margin:0;font-size:15px;line-height:1.5;color:#1A181B;">${safeReason}</p>
                            </div>

                            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#645E66;">
                                If you believe this was done in error, or you've addressed the issue above,
                                please reply to this email so our team can review and reactivate your account.
                            </p>

                            <p style="margin:0;font-size:14px;line-height:1.6;color:#645E66;">
                                Your data is safe and remains intact — suspension only locks staff login, it does not delete any records.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding:24px 40px;background-color:#FAFAFA;border-top:1px solid #F2F4F7;text-align:center;">
                            <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Questions? Reply to this email — we're here to help.</p>
                            <p style="margin:0;font-size:11px;color:#B0ACB5;">© BestoDine · Restaurant Management Platform</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const text = [
        `Hi ${ownerName || 'there'},`,
        ``,
        `Your BestoDine account for "${restaurantName}" has been SUSPENDED.`,
        `Your staff will not be able to log in until the account is reactivated.`,
        ``,
        `── Reason for suspension ──`,
        reason || '(no reason provided)',
        ``,
        `If you believe this was done in error, or you've addressed the issue, please reply to this email so our team can review.`,
        ``,
        `Your data is safe and remains intact — suspension only locks staff login.`,
        ``,
        `— The BestoDine Team`,
    ].filter(l => l !== '').join('\n');

    return { subject, html, text };
};

/**
 * Reactivation notice email.
 *
 * Sent when a Super Admin reactivates a previously suspended tenant.
 * The reason (context for why access was restored) is included so the
 * owner has a written record of the decision.
 *
 * Props: { restaurantName, ownerName, reason }
 */
exports.restaurantReactivated = ({
    restaurantName,
    ownerName,
    reason,
}) => {
    const loginUrl = `${frontendUrl()}/staff-login`;
    const safeName   = escapeHtml(restaurantName || 'your restaurant');
    const safeOwner  = escapeHtml(ownerName || 'there');
    const safeReason = escapeHtml(reason || '').replace(/\n/g, '<br>');

    const subject = `Your BestoDine account has been reactivated — ${safeName}`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A181B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F5F7;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
                    <!-- Header (emerald green to signal restoration) -->
                    <tr>
                        <td style="background-color:#059669;padding:32px 40px;text-align:center;">
                            <h1 style="margin:0;font-size:24px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">BestoDine</h1>
                            <p style="margin:4px 0 0;font-size:13px;color:#D1FAE5;">Account Reactivated</p>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="padding:40px;">
                            <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A181B;">Welcome back, ${safeOwner}!</h2>
                            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#645E66;">
                                Your BestoDine account for <strong style="color:#1A181B;">${safeName}</strong> has been
                                <strong style="color:#059669;">reactivated</strong>. Your staff can now log in and resume operations.
                            </p>

                            <!-- Reason card -->
                            <div style="margin:0 0 24px;padding:20px;background-color:#ECFDF5;border-radius:12px;border:1px solid #A7F3D0;border-left:4px solid #059669;">
                                <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#065F46;text-transform:uppercase;letter-spacing:0.05em;">Note from our team</p>
                                <p style="margin:0;font-size:15px;line-height:1.5;color:#1A181B;">${safeReason}</p>
                            </div>

                            <!-- CTA -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;">
                                <tr>
                                    <td style="background-color:#FE8301;border-radius:10px;">
                                        <a href="${loginUrl}"
                                            style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">
                                            Log in to your dashboard
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin:0;font-size:14px;line-height:1.6;color:#645E66;">
                                All your data, orders and settings are exactly as you left them.
                                If anything looks off, just reply to this email.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding:24px 40px;background-color:#FAFAFA;border-top:1px solid #F2F4F7;text-align:center;">
                            <p style="margin:0 0 6px;font-size:12px;color:#8D848F;">Need help? Reply to this email and we'll get back to you.</p>
                            <p style="margin:0;font-size:11px;color:#B0ACB5;">© BestoDine · Restaurant Management Platform</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    const text = [
        `Welcome back, ${ownerName || 'there'}!`,
        ``,
        `Your BestoDine account for "${restaurantName}" has been REACTIVATED. Your staff can now log in and resume operations.`,
        ``,
        `── Note from our team ──`,
        reason || '(no reason provided)',
        ``,
        `Log in here: ${loginUrl}`,
        ``,
        `All your data, orders and settings are exactly as you left them. If anything looks off, just reply to this email.`,
        ``,
        `— The BestoDine Team`,
    ].filter(l => l !== '').join('\n');

    return { subject, html, text };
};

/**
 * Customer password-reset email.
 *
 * Kept deliberately plain: a reset mail that looks like marketing gets
 * filtered, and a customer who is already confused about their login
 * does not need a hero image. Every reassurance a phishing-wary
 * recipient needs is in the body — who it's from, that ignoring it is
 * safe, and when it stops working.
 */
exports.customerPasswordReset = ({ customerName, resetUrl, restaurantName, expiryMinutes = 30 }) => {
    const safeName = escapeHtml(customerName || 'there');
    const safeBrand = escapeHtml(restaurantName || 'BestoDine');
    const subject = `Reset your ${safeBrand} password`;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#F6F6F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;color:#1A181B;">Reset your password</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#645E66;">
      Hi ${safeName}, we received a request to reset the password for your ${safeBrand} account.
    </p>
    <p style="margin:0 0 24px;">
      <a href="${resetUrl}"
         style="display:inline-block;background:#FE8301;color:#ffffff;text-decoration:none;
                padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">
        Choose a new password
      </a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#8D848F;">
      This link expires in ${expiryMinutes} minutes and can only be used once.
    </p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#8D848F;">
      If you didn't ask for this, you can safely ignore this email — your password
      will not change until you open the link above and set a new one.
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#A8A2AB;word-break:break-all;">
      Button not working? Paste this into your browser:<br>${escapeHtml(resetUrl)}
    </p>
  </div>
</body>
</html>`;

    const text = [
        `Hi ${customerName || 'there'},`,
        ``,
        `We received a request to reset the password for your ${restaurantName || 'BestoDine'} account.`,
        ``,
        `Choose a new password here:`,
        resetUrl,
        ``,
        `This link expires in ${expiryMinutes} minutes and can only be used once.`,
        ``,
        `If you didn't ask for this, you can safely ignore this email — your password will not change until you open the link above and set a new one.`,
    ].join('\n');

    return { subject, html, text };
};
