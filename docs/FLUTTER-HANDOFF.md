# Flutter developer handoff

Updated: 12 October 2026. This repository contains the Node.js backend, React web reference implementation, shared TypeScript contracts and tests. Flutter implementation belongs under `mobile/`; it has not been created yet.

## Start here

1. Clone this private repository with an authorized GitHub account.
2. Install Node.js 24.11 or newer; run `npm ci`, `npm run build`, then `npm run demo` from the repository root. Keep the process running.
3. Open `http://127.0.0.1:3001/` and `/shop` to understand the independent operational and customer journeys.
4. Read `shared/contracts.ts`, `shared/catalog.ts`, `docs/IMPLEMENTATION-STATUS.md` and the relevant feature document. Older slice contracts are historical; current source and tests resolve differences.
5. Build the Flutter theme and reusable widget gallery, then the courier journey, merchant origin confirmations, pickup journey and customer views in that order. Follow `docs/MOBILE-DEVELOPMENT-PLAN.md`. Record the chosen state management and HTTP client in `mobile/README.md` and commit the Flutter lockfile.

## Connect locally

The backend intentionally listens on `127.0.0.1:3001` only and rejects foreign browser origins and nonlocal demo login hosts. Do not change it to `0.0.0.0` just to connect a phone.

For an Android emulator or USB-connected Android device, use Android platform-tools `adb reverse tcp:3001 tcp:3001`, then set the native Flutter development API base URL to `http://127.0.0.1:3001`. If multiple devices are connected, select one with `adb -s DEVICE_ID reverse tcp:3001 tcp:3001`. The backend must run on that same development computer. HTTP cleartext configuration must be debug-only.

A desktop Flutter build on the same computer can use that URL directly. An iOS simulator requires the backend to run on its Mac host, or a separately reviewed connection arrangement. Flutter Web has browser origin/CORS constraints; it is not equivalent to native Flutter. Public hosting, mobile bearer-token login, LAN access and production TLS/authentication are separate unfinished prerequisites.

### Operational session

- `GET /api/demo/accounts`: discover demo accounts rather than hardcoding production users.
- `POST /api/demo/session` with `{"accountId":"courier-b"}`: captures the `session` cookie from `Set-Cookie`. Keep and send it on subsequent requests using a cookie-aware native transport.
- `GET /api/bootstrap`: account identity, scoped shipments and available sites/couriers.
- `GET /api/shipments/:id`: shipment, timeline and inventory details.
- `POST /api/shipments/:id/actions`: execute a reviewed action.
- `DELETE /api/session`: sign out. Clear identity-scoped caches, pending screens and session cookies.

Demo sessions expire after eight hours and are invalidated by server restart. A 401 requires a new demo session. Demo account switching is not production authentication. Native clients should not invent an `Origin` header to bypass browser protections.

Example command body:

```json
{"action":"accept","expectedVersion":2}
```

Send `Content-Type: application/json` and a fresh `Idempotency-Key` for each new command. Use the actual version from the selected shipment; the number above is illustrative. On a lost reply, retain and resend the exact body and key after explicit review. Never retry with a new key or silently replace the version. Handle 409 by explaining the conflict and refreshing before a new decision. Preserve leading zeroes in the six-digit customer code; do not log or persist it.

### Customer session

`POST /api/storefront/session` establishes a separate `shop` cookie. Customer checkout, order listing and private code access use that cookie, not the operational session. Use a separate cookie scope/repository for customer identity.

Existing endpoints include `/api/storefront/availability`, `/api/storefront/checkouts`, `/api/storefront/orders`, `/api/storefront/orders/:id/delivery-code`, `/api/storefront/orders/:id/location` and `/api/storefront/orders/:id/returns`. Inspect `server/storefront.ts`, `shared/catalog.ts` and `web/Storefront.tsx` for payloads and eligibility. Keep application API keys and webhook signing secrets on servers; do not embed `.local/secrets.json` in a mobile app. The server-to-server `/api/v1/*` commerce API is not a replacement for user authentication.

## Current capabilities and boundaries

- Local shipment workflow, scoped identities, origin preparation/release/independent courier receipt, pickup capacity and independent custody confirmations are implemented.
- COD collection at courier or point delivery, operations remittance, merchant payout and audited cash return paths are implemented as a local demonstration. Full cash amount, reference of at least three trimmed characters and physical receipt review are required. A valid delivery code alone does not satisfy cash requirements. Contracts: `shared/cash.ts`, `shared/payouts.ts`; documents: `docs/CASH-COLLECTION.md`, `docs/MERCHANT-PAYOUTS.md` and subsequent cash feature documents.
- Complete-basket fulfillment-origin selection, owned inventory sites and local stock transfers are implemented. Shared commercial warehouses and intercity execution are unfinished.
- Consent-based latest courier GPS reading and Leaflet/OpenStreetMap web display are implemented. See `docs/COURIER-LOCATION-SHARING.md` and location endpoints in `server/location.ts`. Optimized routes, H3, ETA and native background location are unfinished. GPS sharing requires permission, expiry and explicit opt-in; do not use an illustrative map as live telemetry.
- Full-order commercial return requests, owner-merchant approval/rejection and customer withdrawal are implemented. They do not change delivery, stock or cash. Local reverse transport is implemented with operations assignment, independent customer/courier handover, merchant receipt into quarantine and existing partial inspection. See `docs/COMMERCIAL-RETURN-TRANSPORT.md`. Full-goods COD customer refunds after complete inspection and verified funding are implemented, with merchant approval, operations reserve/release and independent customer confirmation. Delivery fees remain separate. Read `docs/CUSTOMER-REFUNDS.md`. Partial/electronic refunds and partial reverse-transport receipt are unfinished.
- Production authentication, push/SMS, deployment and the real Tendsy connector are unfinished.

API failures contain `code`, `message`, `requestId`, and optionally validation `fields`. Show meaningful errors and blocked reasons. Do not infer authorization from hiding a button; the server is authoritative. Distinguish arrival, custody receipt and delivery to the customer. Completed timeline records differ from future route stages. Poll visible details conservatively; pause while reviewing or sending a command and discard responses from older versions or previous identities.

## Verification and collaboration

Backend checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run format:check`. Current handoff was verified with 119 regression tests, two additional commercial-return tests and an isolated pickup COD browser journey including 1440/390/360 layouts. Tests do not establish production readiness or load targets.

Use `feature/flutter-foundation` for the first mobile branch and submit a pull request against `main`. Keep backend contract changes in separate reviewed commits with matching tests. No production credentials, local databases, generated build files, emulator data or signing keys belong in Git. The backend creates fresh local demo data and secrets on first run; existing developer-local orders are not shipped in this repository.

## Return UX update — 13 October 2026

The client enters the return reason once. Ordinary transport confirmations no longer require repeating it. Merchant intake approval is separate from the final inspection response. After all pieces have been inspected, the owner merchant sends action `reply` with `expectedVersion`, `reference` and `reply`. Display `inspectionReply` to the customer; require this response before the merchant refund request. Read `docs/RETURN-REASON-AND-MERCHANT-REPLY.md`. Financial `reason` fields may be generated from the confirmed action; collect a human incident description only for genuine discrepancy/report flows.

## Notifications and quick actions — 13 October 2026

Use GET /api/notifications and POST /api/notifications/read with ids, or the customer-scoped /api/storefront/notifications equivalents. The feed is scoped to the authenticated role and current state, with persistent read status per record version. Read docs/UX-AND-NOTIFICATIONS.md for fields, limits and role routing. Internal ACK references and action descriptions may be generated by the UI; explicit cash amount review remains required. Device push/FCM is separate from this in-app feed.

## Saved locations and verified service ratings — 13 October 2026

Read docs/CUSTOMER-LOCATIONS-AND-RATINGS.md. Address CRUD is customer-session scoped, versioned, and uses idempotent saves. Request GPS only on explicit current-location selection. Nearest pickup ranking accepts owned addressId or coordinates and returns up to five located enabled points, with straight-line distance and verified rating aggregates. Checkout location is copied into the order and excluded from public tracking. Delivered own orders may submit one courier and one applicable pickup rating. Use shipment.deliveryCourier for the confirmed executor after pickup custody clears the active courierId; do not infer a missing historical executor.

## Completion changes — 14 October 2026

- `GET /api/shipments?search=&filter=all&page=0` performs scoped server search over all shipments; `rows`, `total`, `page`, `pageSize=25`. Filters include `active`, `attention`, and shipment statuses. Search includes external reference, recipient, merchant and destination. A record absent from bootstrap's 100-row sample may still be searchable.
- Bootstrap statistics now cover the full account scope. Bootstrap shipment rows remain a bounded sample; do not derive historical totals from its array length.
- Couriers and delivery companies expose nullable `rateBps` (basis points: 6000 means 60%). Operators can set it in partner POST/PATCH requests. Missing/null means no agreement; zero is an explicit zero rate.
- The current outbound assignment captures the agreement. New rate settings apply to new assignments, not deliveries already assigned. An independent courier uses their own rate; an affiliated courier uses the company's rate.
- `GET /api/execution-earnings` is available to operations and couriers. Operations see all beneficiaries; couriers see only their own independent earnings. It returns bounded `rows`, complete beneficiary `groups`, and `settlementImplemented:false`.
- Earnings apply once to the delivery fee, excluding goods value, on home delivery or custody receipt by the pickup point. Customer pickup does not earn a second courier fee. No agreed rate produces a null amount; older executions without an assignment agreement are not automatically reconstructed.
- This is accrual reporting, not disbursement. Company login and salary payout/recipient confirmation remain unfinished. Do not display these records as paid or subtract them from customer collection totals.
- Local demo database migration: 26. Authentication and external hosting limitations described above still apply.
