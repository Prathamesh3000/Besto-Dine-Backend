# BestoDine webhooks

BestoDine can `POST` a signed JSON event to your HTTPS endpoint when something
happens in your restaurant. Available on **Gold and above** or as the
**API keys & webhooks** add-on (feature key `publicApi`). Manage endpoints in
**Admin > Developers** (restaurant owner only).

## Events

| Type | Sent when | `data` |
|------|-----------|--------|
| `order.created` | an order is placed | order object |
| `order.paid` | an order becomes fully paid | order object |
| `order.cancelled` | an order is cancelled | order object |
| `refund.created` | a refund is processed | `{ order_id, amount, mode, refund_request_id }` |
| `booking.created` | a table / hall booking is made | booking object |
| `stock.low` | an inventory item drops to low / out of stock | inventory item object |
| `webhook.test` | you press "Send test" | `{ message }` |

Order, booking and inventory objects have the same fields as the
[public API](./public-api.md) (`/orders`, `/bookings`, `/inventory/low-stock`).

## Request

```
POST https://your.endpoint/hook
Content-Type: application/json
User-Agent: BestoDine-Webhooks/1
X-BestoDine-Event: order.paid
X-BestoDine-Delivery: 6530b1f2a1b2c3d4e5f60718
X-BestoDine-Signature: t=1761700000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

```json
{
  "id": "evt_9f2c1d4e7a8b0c3d5e6f7a81",
  "type": "order.paid",
  "created": 1761700000,
  "data": { "id": "ORD-0412", "status": "served", "payment_status": "Paid", "total": 462, "...": "..." }
}
```

`id` is the **event id**: use it to de-duplicate (delivery is at-least-once;
retries and manual re-deliveries carry the same event id).

## Verifying the signature

`v1` = hex `HMAC-SHA256(secret, t + "." + rawBody)` where `secret` is the
endpoint's signing secret (`whsec_...`, shown once when you create or rotate
it), `t` the unix timestamp from the header and `rawBody` the **exact** request
body bytes. Compare in constant time and reject timestamps older than ~5
minutes (replay protection).

Node.js:

```js
const crypto = require('crypto');

function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1 || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Python:

```python
import hmac, hashlib, time

def verify(secret, raw_body: bytes, header: str, tolerance=300):
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > tolerance:
        return False
    expected = hmac.new(secret.encode(), parts["t"].encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## Delivery rules

- Respond with any **2xx** within **5 seconds** to acknowledge. Anything else
  (non-2xx, timeout, network error, **redirects are not followed**) is a failure.
- Failed deliveries are retried with exponential backoff: **6 attempts** in
  total, waiting 1 min, 5 min, 30 min, 2 h and 6 h between attempts, then the
  delivery is marked `failed`. You can re-deliver any delivery from the log.
- After **10 consecutive failed attempts** (`WEBHOOK_MAX_CONSECUTIVE_FAILURES`)
  the endpoint is switched off automatically. It is shown as disabled with the
  reason in Admin > Developers; re-enable it after fixing the problem (this
  resets the counter). A successful delivery resets the counter too.
- Delivery history is kept for **30 days**.
- Order is not guaranteed across events: use `created` / the object's own
  timestamps if order matters.

## Endpoint requirements and SSRF protection

- `https://` only, on port 443 (or 8443). No credentials in the URL.
- The host is resolved at delivery time and every address must be public.
  Loopback, private (10/8, 172.16/12, 192.168/16), link-local, carrier-grade
  NAT, multicast, cloud-metadata (169.254.169.254) and IPv6 unique-local
  addresses are refused, as are `localhost`, `.local` and `.internal` hosts. The
  connection is made to the address that was checked.
- Responses are read up to 64 KB only.
- Maximum 10 endpoints per restaurant.

## Management API (owner only, staff session)

`/api/v1/developer/...`

| Method and path | Purpose |
|-----------------|---------|
| `GET /webhooks` | list endpoints (no secrets) |
| `POST /webhooks` | create `{ url, events[], description? }`, returns `secret` once |
| `PATCH /webhooks/:id` | update `url`, `events`, `description`, `active` |
| `DELETE /webhooks/:id` | delete (pending deliveries are dropped) |
| `POST /webhooks/:id/rotate-secret` | new signing secret, returned once |
| `POST /webhooks/:id/test` | send a signed `webhook.test` event now; reports the result |
| `GET /webhooks/:id/deliveries?status=` | delivery log (status, attempts, response code, last error) |
| `POST /webhook-deliveries/:id/redeliver` | re-send a delivery with a fresh retry budget |

## Server settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `WEBHOOK_DELIVERY_DISABLED` | unset | `true` turns the retry job off (e.g. external worker) |
| `WEBHOOK_MAX_CONSECUTIVE_FAILURES` | `10` | failed attempts before an endpoint is auto-disabled |
| `PUBLIC_API_RATE_LIMIT_PER_MIN` | `120` | public API requests per key per minute |
