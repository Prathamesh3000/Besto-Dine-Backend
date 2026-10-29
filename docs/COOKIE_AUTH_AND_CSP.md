# Cookie web sessions, CSRF and Content-Security-Policy (plan task 3A.4)

Decision D9: the WEB app keeps its session in httpOnly cookies; mobile-waiter
and the desktop shell keep bearer tokens. Everything below is behind env flags
that default OFF (cookies) or to report-only (CSP).

## 1. What changes

| Layer | Flag off (default) | Flag on |
|---|---|---|
| Backend login / 2FA verify / refresh | tokens in JSON body only | **also** `Set-Cookie` (access, refresh, CSRF) |
| `protect` / `optionalAuth` | `Authorization: Bearer` only | bearer first, else the audience's cookie |
| State-changing requests | unchanged | cookie-authenticated ones need CSRF proof |
| Web app | tokens in localStorage | no tokens in localStorage (httpOnly cookies) |
| CSP | `Content-Security-Policy-Report-Only` | `CSP_MODE=enforce` blocks |

### Backend flags
- `USE_COOKIE_AUTH=true` turns the cookie path on.
- `COOKIE_SAMESITE=lax|strict|none` (default `lax`), `COOKIE_SECURE` (default true in production; `none` forces it), `COOKIE_DOMAIN` (default host-only), `COOKIE_REFRESH_PATH` (default `/api/v1/auth`), `CSRF_SECRET` (default `JWT_SECRET`).
- `CSP_MODE=off|report-only|enforce` (default `report-only`), `CSP_API_ORIGINS`, `CSP_REPORT_URI` (default `/csp-report`), `CSP_EXTRA_{SCRIPT,STYLE,FONT,IMG,CONNECT,FRAME}_SRC`.

### Frontend flag
- `VITE_USE_COOKIE_AUTH=true` (build time, default off). If the backend flag is still off the server keeps returning tokens in the body and the app falls back to localStorage for that session, so the web flag can ship first.

## 2. Cookies

One pair per **audience** (`platform` = super admin, `staff` = tenant staff, `customer`), because the web app deliberately runs those sessions side by side in one browser (`Frontend/src/utils/authStorage.js`). The audience comes from the user's role, same mapping as the frontend.

| Cookie | httpOnly | Path | Max-Age |
|---|---|---|---|
| `bd_at_<aud>` access JWT | yes | `/` | time left to the login's absolute cap (`SESSION_MAX_HOURS_*`: superadmin 8h, staff 12h, customer 1h) |
| `bd_rt_<aud>` opaque refresh token | yes | `/api/v1/auth` | same absolute cap left |
| `bd_csrf` signed CSRF token | **no** | `/` | same absolute cap left |

All: `SameSite=Lax`, `Secure` in production, optional `Domain`.

- **Why the access cookie lives as long as the session, not the 30 min JWT:** when the JWT lapses the browser still sends it, the API answers 401 (socket: `AUTH_EXPIRED`) and the existing refresh flow runs. A cookie that vanished with the JWT would look like "no credentials" and skip that path. JWT expiry/revocation (tokenVersion) is still enforced server-side.
- **Why the access cookie is `Path=/`:** the socket.io handshake is at `/socket.io`, outside `/api`.
- **Why the refresh cookie is path-scoped:** it is only sent to `/api/v1/auth/*` (refresh, logout), never with ordinary API calls. Rotation, reuse detection, family ceilings and tokenVersion revocation are unchanged (`authController.refresh`).
- **Which audience's cookie is used:** the web client sends `X-Auth-Audience: <aud>` (and `auth.audience` on the socket handshake; `none` = guest). Without the hint, a cookie is used only when exactly one audience has one.
- **SameSite=Lax rather than Strict:** Strict also works for XHR from the same site, but Lax additionally lets cookies ride top-level GET navigations (invoice/export links opened in a new tab or from an email) while still withholding them on cross-site POST/PUT/DELETE. CSRF protection below does not rely on SameSite. Production serves `/api` same-origin (`VITE_API_URL=/api/v1`), so cookies are first-party. Use `COOKIE_SAMESITE=none` (forces Secure) only if you ever host SPA and API on different **sites** (e.g. `*.vercel.app` + `*.onrender.com`); then third-party-cookie blocking in Safari/Chrome may still break it, which is why same-site hosting is recommended.

### Response bodies
- Every client still gets `token` + `refreshToken` in the body (cookies are additional), so mobile / desktop / old web builds are untouched.
- A web build with the flag sends `X-Auth-Mode: cookie`; it then gets **no tokens** in the body, only `{ cookieAuth: true, csrfToken, accessExpiresAt, sessionExpiresAt }` (non-secret timing hints so the SPA can refresh proactively and end a fixed-hour customer login on time).

## 3. Endpoints
- `POST /auth/login`, `/auth/2fa/verify` (via `completeLogin`), `/auth/verify-otp`, `/auth/google`, `/auth/register`, `/auth/refresh`, `PUT /auth/change-password`: all go through `issueSession`, which sets the cookies.
- `POST /auth/refresh`: refresh token from the body (bearer clients) **or** the `bd_rt_<aud>` cookie.
- `POST /auth/logout`: revokes the refresh session (body token or cookie), closes the shift, clears **that audience's** cookies only (a customer logout does not end a staff session). `POST /auth/logout-all` revokes every session of the user and clears their audience cookies.
- `GET /auth/csrf`: returns (and if needed sets) the CSRF token. `{ enabled:false }` when the flag is off. Needed because a cross-origin SPA cannot read the API's cookie and a reloaded tab loses its in-memory copy.

## 4. CSRF (cookie-authenticated, state-changing requests only)
Applies to non-GET/HEAD/OPTIONS requests that carry one of our session cookies and **no** `Authorization: Bearer` header (`utils/cookieAuth.js` `csrfGuard`, mounted on `/api/v1` before `optionalAuth`). Two checks:
1. **Origin / Referer**: if present it must be in the CORS allowlist (same predicate as CORS: `ALLOWED_ORIGINS`, plus LAN in dev). Failure -> `403 CSRF_ORIGIN`.
2. **Double-submit**: `X-CSRF-Token` header must equal the `bd_csrf` cookie **and** carry a valid HMAC (so a cookie planted from a sibling subdomain is rejected). Failure -> `403 CSRF_INVALID`.

Exemptions: header-authenticated requests (nothing ambient to abuse); requests with no session cookie; session-creating endpoints (`/auth/login`, `register`, `send-otp`, `verify-otp`, `google`, `forgot-password`, `reset-password`, `2fa/verify`) and `/auth/logout` skip the double-submit (they still get the Origin check); `/auth/refresh` / `/auth/logout` that present the refresh token **in the body** skip it (possession of the token is the proof, so a mobile client with a cookie jar keeps working). The CSRF token is reused while valid, so a refresh in one tab does not invalidate another tab's copy; the web client also retries once on `CSRF_INVALID` after fetching `/auth/csrf`.

CORS (unchanged, verified): exact-origin allowlist (no wildcard, `credentials: true`, origin reflected only when allowed); preflights reflect the requested headers, so `X-CSRF-Token`, `X-Auth-Audience`, `X-Auth-Mode` need no extra config.

## 5. socket.io
`utils/socket.js`: when `handshake.auth.token` is absent and the flag is on, the access token is read from the handshake `Cookie` header using `auth.audience`. Cookie auth is accepted **only when the handshake `Origin` passes the CORS allowlist**: browsers do not apply CORS to WebSocket upgrades, so without this a hostile page could open a socket with the victim's cookies (cross-site WebSocket hijacking). `auth.token` (mobile, old web) keeps working and wins. The Frontend socket sets `withCredentials` and sends `audience`.

## 6. Content-Security-Policy
`utils/csp.js` builds one policy, used by helmet on API responses and mirrored for the static host. Default **report-only** (browsers log violations to `POST /csp-report` and `/api/csp-report`, 4 KB cap, 30/min/IP, always 204, logged as `csp.violation`).

Policy (see the file for exact values): `default-src 'self'`; scripts: self + `checkout.razorpay.com` + Google Identity (`accounts.google.com/gsi/client`), **no inline scripts**; styles: self + `'unsafe-inline'` (React inline `style=`) + Google Fonts / jsDelivr / Flaticon CSS; fonts: gstatic + the same icon hosts; images: self, `data:`, `blob:`, Cloudinary, Unsplash, ui-avatars, tec-it, quickchart, qrserver, icons8, `*.googleusercontent.com`, `*.razorpay.com`; connect: self + Sentry ingest + Nominatim + Razorpay + Google (+ `CSP_API_ORIGINS` and their `wss://`); frames: Razorpay (checkout/api), Google sign-in, YouTube/Vimeo (demo-video embeds); `object-src 'none'`, `base-uri 'self'`, `form-action 'self' api.razorpay.com`, `frame-ancestors 'self'`, `worker-src 'self' blob:`.

### Static host (the SPA is what the browser actually loads)
`Frontend/public/_headers` (Netlify / Cloudflare Pages) carries the same policy as `Content-Security-Policy-Report-Only` with `report-uri /api/csp-report`. Other hosts, same header value:
- **nginx**: `add_header Content-Security-Policy-Report-Only "<policy>" always;` in the SPA `server`/`location /`.
- **Apache**: `Header always set Content-Security-Policy-Report-Only "<policy>"`.
- **Vercel**: `vercel.json` -> `headers: [{ "source": "/(.*)", "headers": [{ "key": "Content-Security-Policy-Report-Only", "value": "<policy>" }] }]`.
- **No header control**: a `<meta http-equiv="Content-Security-Policy" content="...">` in `index.html` works for enforce mode only (meta cannot do report-only, `report-uri` or `frame-ancestors`).
Regenerate the string with the one-liner at the top of `_headers`. If the API has its own host, add it to `connect-src`/`img-src`/`media-src` (+ `wss://`), and use an absolute `report-uri`.

### Roll-out
1. Deploy with defaults (report-only on API + `_headers`). Watch `csp.violation` logs for a few days of real use (POS tablets, kiosk, customer checkout with Razorpay, Google sign-in, staff on every module).
2. Add legitimate sources via `CSP_EXTRA_*` / `_headers`; fix real violations (e.g. any new image host a tenant uses).
3. Switch `CSP_MODE=enforce` and rename the `_headers` entry to `Content-Security-Policy`.
Known loosenings to tighten later: `style-src 'unsafe-inline'`; Razorpay/Google/YouTube hosts are broad by necessity.

## 7. Enabling cookie auth (deploy steps)
1. Ship this code with all flags default. Nothing changes.
2. Staging: backend `USE_COOKIE_AUTH=true`, frontend build `VITE_USE_COOKIE_AUTH=true`. Verify in DevTools: no `*_token` / `*_refresh_token` in localStorage; cookies `bd_at_*` / `bd_rt_*` httpOnly; staff + customer side by side; 2FA login; token refresh after 30 min; logout clears cookies; socket connects.
3. Production: backend flag first (clients without the opt-in header are unaffected), then the web build. Rolling back = unset `VITE_USE_COOKIE_AUTH` and redeploy; users on a cookie session sign in again (their marker is ignored once cookies are not sent... clear site data if needed).
4. Existing logged-in web users are signed out once on the flip (their localStorage tokens are replaced at next login).
5. Ensure `ALLOWED_ORIGINS` lists the exact SPA origin(s) and `TRUST_PROXY` is correct.

## 8. Not covered / risks
- XSS can still *use* the session from the page (make requests), it just can no longer steal it; CSP enforce is what reduces XSS likelihood.
- `localStorage` still holds the (non-secret) user blob and the scan/guest tokens; those are out of scope for 3A.4.
- Cookies are set for any client when the backend flag is on; bearer clients ignore them (header wins, CSRF-exempt). A native client with a cookie jar that sends a body refresh token keeps working.
- Cross-site hosting of SPA and API needs `SameSite=None` and may hit third-party-cookie blocking.
- Mobile-waiter and the desktop shell are unchanged; the desktop shell loads the hosted web app, so it follows the web flag.
- Tests mock persistence; run the browser flow on staging before production.
