# BestoDine public API (v1, read-only)

Read your restaurant's orders, menu, sales, low-stock inventory and bookings
from your own tools (accounting, BI, Zapier, dashboards).

- Base URL: `https://<your-api-host>/api/public/v1`
- Available on **Gold and above**, or as the **API keys & webhooks** add-on
  (feature key `publicApi`). Without it every call returns `403 FEATURE_LOCKED`.
- Read-only: only `GET`. Any other method returns `405`.
- Responses are JSON. Field names are `snake_case` and stable; new fields may
  be added, existing ones are not renamed or removed within v1.

## Authentication

Create a key in **Admin > Developers** (restaurant owner only). The full key
looks like `bd_live_<prefix>_<secret>` and is shown **once**; only a hash is
stored. Lost it? Rotate (new key, old one stops working) or revoke.

```
Authorization: Bearer bd_live_ab12cd34ef_0123456789abcdef0123456789abcdef0123456789abcdef
```

`X-API-Key: <key>` is also accepted. Keys in the query string are **not**
accepted (URLs end up in logs).

Each key has scopes. A call to an endpoint outside the key's scopes returns
`403 INSUFFICIENT_SCOPE`.

| Scope | Endpoints |
|-------|-----------|
| `read:orders` | `GET /orders`, `GET /orders/:id` |
| `read:menu` | `GET /menu` |
| `read:sales` | `GET /sales/summary` |
| `read:inventory` | `GET /inventory/low-stock` |
| `read:bookings` | `GET /bookings` |

A key can have an optional expiry. Revoked / expired keys return `401`
(`API_KEY_REVOKED` / `API_KEY_EXPIRED`).

### Errors

```json
{ "success": false, "code": "INSUFFICIENT_SCOPE", "message": "This API key does not have the \"read:sales\" scope." }
```

| Status | `code` |
|--------|--------|
| 401 | `API_KEY_REQUIRED`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED` |
| 403 | `INSUFFICIENT_SCOPE`, `FEATURE_LOCKED`, `TENANT_SUSPENDED` |
| 400 | `INVALID_DATE`, `INVALID_RANGE`, `RANGE_TOO_LARGE`, `INVALID_FILTER`, `INVALID_BRANCH` |
| 404 | `ORDER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 429 | `RATE_LIMITED` |

### Rate limit

Per key, default **120 requests / minute** (`PUBLIC_API_RATE_LIMIT_PER_MIN`
server setting). `RateLimit-*` headers are returned; on `429` wait and retry.

## Pagination

List endpoints take `page` (default 1) and `limit` (default 50, max 100):

```json
{
  "success": true,
  "data": [ ... ],
  "pagination": { "page": 1, "limit": 50, "total": 132, "has_more": true }
}
```

Dates: `from` / `to` accept `YYYY-MM-DD` (a bare `to` includes that whole day,
UTC) or a full ISO timestamp. Maximum range 366 days. `branch_id` narrows to
one branch.

## GET /orders

Filters: `from`, `to` (created time), `status`
(`awaiting-payment|new|preparing|ready|served|cancelled`), `payment_status`
(`Pending|Partially Paid|Paid|Refunded`), `branch_id`, `page`, `limit`.
Newest first.

```
curl -H "Authorization: Bearer $BD_KEY" \
  "https://api.example.com/api/public/v1/orders?status=served&from=2026-10-01&to=2026-10-31&limit=2"
```

```json
{
  "success": true,
  "data": [
    {
      "id": "ORD-0412",
      "type": "dine-in",
      "source": "staff",
      "status": "served",
      "payment_status": "Paid",
      "payment_method": "cash",
      "branch_id": null,
      "table_id": "64c0000000000000000000a1",
      "token_number": null,
      "customer_name": "Asha",
      "items": [{ "name": "Paneer Tikka", "quantity": 2, "price": 220, "category": "Starters" }],
      "total": 462,
      "gst": 22,
      "service_charge": 0,
      "additional_charges_total": 0,
      "amount_paid": 462,
      "refunded_amount": 0,
      "cancel_reason": null,
      "created_at": "2026-10-12T13:05:11.000Z",
      "paid_at": "2026-10-12T13:52:40.000Z",
      "cancelled_at": null
    }
  ],
  "pagination": { "page": 1, "limit": 2, "total": 318, "has_more": true }
}
```

## GET /orders/:id

`:id` is the order number (`ORD-0412`). Returns `{ "success": true, "data": { ...order } }`
or `404 ORDER_NOT_FOUND`.

## GET /menu

Active menu items. Filters: `in_stock=true`, `branch_id`, `page`, `limit`.

```json
{
  "success": true,
  "data": [
    {
      "id": "64c0000000000000000000b2",
      "name": "Masala Dosa",
      "category_id": "64c0000000000000000000c3",
      "category": "Breakfast",
      "description": "Crisp rice crepe with potato filling",
      "veg_type": "veg",
      "base_price": 120,
      "offer_percentage": 10,
      "final_price": 108,
      "unit": "plate",
      "in_stock": true,
      "branch_id": null,
      "images": ["https://.../dosa.jpg"],
      "sizes": []
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 64, "has_more": true }
}
```

## GET /sales/summary

Paid, non-cancelled orders in the range (same definition as the admin
analytics). Default range: last 30 days. Days are bucketed in the restaurant's
timezone.

```json
{
  "success": true,
  "data": {
    "timezone": "Asia/Kolkata",
    "from": "2026-09-29T00:00:00.000Z",
    "to": null,
    "revenue": 182450.5,
    "orders": 640,
    "refunded": 1200,
    "average_order_value": 285.08,
    "daily": [{ "date": "2026-10-01", "revenue": 6120, "orders": 21 }],
    "top_items": [{ "name": "Masala Dosa", "quantity": 212, "revenue": 22896 }]
  }
}
```

## GET /inventory/low-stock

Items at or below their minimum stock level (includes out of stock).

```json
{
  "success": true,
  "data": [
    {
      "id": "INV-014", "name": "Basmati rice", "category": "Raw Ingredients", "unit": "kg",
      "current_stock": 3.5, "min_stock": 10, "status": "low-stock",
      "branch_id": null, "updated_at": "2026-10-28T09:14:02.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "has_more": false }
}
```

## GET /bookings

Table and hall bookings. Filters: `from`, `to` (event date), `status`
(`Pending|Confirmed|Completed|Cancelled`), `type` (`table|hall`), `branch_id`.

```json
{
  "success": true,
  "data": [
    {
      "id": "TBL-031", "type": "table", "status": "Confirmed",
      "date": "2026-11-01T00:00:00.000Z", "time": "7:00 PM", "time_slot": "Dinner",
      "guest_count": 4, "special_event": "Birthday", "branch_id": null,
      "created_at": "2026-10-20T08:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "has_more": false }
}
```

## What is never exposed

Customer phone numbers and e-mails, staff data, payment gateway ids, tokens,
password hashes, idempotency keys and anything belonging to another restaurant.
A key can only ever read its own restaurant.

## Managing keys (owner only, Admin > Developers)

`/api/v1/developer/api-keys` (staff session, not an API key): `GET` list
(never returns the secret or hash), `POST` create `{ name, scopes[],
expiresInDays? }` (returns `key` once), `DELETE /:id` revoke,
`POST /:id/rotate` (new key, returned once; the old one stops immediately).
Up to 20 active keys per restaurant.

See also [webhooks.md](./webhooks.md).
