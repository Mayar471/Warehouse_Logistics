# Mobile Development Plan and Widget Handoff

**Project:** Independent Logistics Platform  
**Prepared:** 11 October 2026  
**Audience:** Mobile developer, technical lead, and Claude Code / cloud coding agents  
**Deliverable:** A mobile UI foundation followed by working, role-scoped logistics journeys

## 1. How to use this document

Read sections 2–5 first, build the shared widgets in section 6, and implement the milestones in section 12 in order. Use the task prompt in section 14 for each coding session.

“Mobile widgets” means reusable components inside the mobile application. Android home-screen widgets and iOS WidgetKit extensions are outside this plan. “Cloud code” is interpreted as an AI coding workflow, including Claude Code; it does not imply that the current backend is deployed to the cloud.

This is a proposed mobile implementation plan based on the repository's current code. There is no existing native mobile application or confirmed mobile framework in this repository. Widget names, mobile folder structure, and milestones below are proposed; endpoint paths and domain names are taken from existing source.

**Start now:** Build the widget gallery and courier screens against deterministic mock repositories. Connect to the existing backend only through a verified local test arrangement. Production authentication and deployment are separate backend prerequisites.

## 2. Project overview

The platform coordinates merchants, inventory sites, couriers, pickup points, and logistics operations. It owns fulfillment, parcel custody, inventory reservation, assignment, execution history, and integration events. Tendsy is the intended first commerce integration; the current “Trend Sy” storefront is a local demonstration, not a completed Tendsy connector.

The commerce application owns product browsing, cart, customer identity, and the commercial order. The logistics platform provides service quotes, fulfillment creation, shipment execution, and tracking. Keep these responsibilities separate in mobile code.

The first working journey is local delivery in Damascus:

1. A commerce request obtains a quote and creates a shipment.
2. Operations assigns a courier.
3. The courier accepts the assignment.
4. The merchant prepares the parcel and confirms handing it to that courier.
5. The courier confirms physical pickup and starts delivery.
6. The recipient supplies a delivery code for storefront orders.
7. The courier completes delivery; the customer sees the updated status.

An alternative journey delivers the parcel to a pickup point. Arrival and the point's physical receipt are separate confirmations. The point employee releases the parcel to the customer using the customer's code.

## 3. Current implementation versus future work

| Capability | Current repository | Mobile treatment |
|---|---|---|
| Shipment details, history, role isolation | Implemented locally | Core mobile scope |
| Assignment, acceptance, decline, expiry | Implemented locally | Courier priority |
| Merchant preparation and origin handover | Implemented locally | Merchant priority |
| Customer delivery code | Implemented for local storefront orders | Code entry and customer code display in separate roles |
| Pickup custody, customer collection, expired collection returns | Implemented locally | Second delivery journey |
| Public tracking | Implemented with limited personal data | Separate public view |
| Inventory, receipts, return inspection, counts, site ownership | Implemented locally | Later mobile milestone |
| Transfers between sites owned by the same merchant | Implemented locally, including partial receipt | Later mobile milestone; distinct task model |
| Application API, signed outbox delivery, integration recovery | Implemented for local demonstration | Server integration; keep recovery tools on web initially |
| Production login, native token lifecycle, public hosting | Not implemented | Backend dependency before live mobile rollout |
| Real Tendsy integration | Not implemented | Separate integration project |
| COD, partner settlement, intercity execution | Not implemented | Do not build working financial or intercity actions |
| GPS tracking, real routing, H3, optimized assignment | Not implemented | Do not present illustrative maps as live tracking |
| SMS, push, background notifications | Not implemented | In-app refresh only initially |
| Shared warehouses and automatic fulfillment-origin selection | Not implemented | Do not infer these from multiple inventory sites |

Older architecture and slice documents describe earlier stages. Where they differ, inspect current source and feature tests, then consult `docs/IMPLEMENTATION-STATUS.md` and the later feature documents. Do not copy outdated “not implemented” statements without checking current code.

## 4. Repository map and onboarding

All paths in this handoff are relative to the repository root so it remains portable to another developer or cloud workspace.

| Path | Read it for |
|---|---|
| `README.md` | Local setup and demo boundaries |
| `DEVELOPMENT-PLAN.md` | Overall roadmap and production gates |
| `docs/IMPLEMENTATION-STATUS.md` | Recorded implementation progress and limits |
| `shared/contracts.ts` | Account, role, shipment, quote, timeline, bootstrap types |
| `shared/catalog.ts` | Local storefront product, checkout, and order shapes |
| `shared/inventory.ts` | Stock, movements, return inspection, inventory sites |
| `shared/transfers.ts` | Transfer status, detail, and history types |
| `server/app.ts` | Session, bootstrap, shipment routes and action schema |
| `server/domain.ts` | Shipment permissions, transitions, custody, concurrency |
| `server/storefront.ts`, `server/delivery-proof.ts` | Customer sessions, checkout, delivery-code policy |
| `server/inventory-api.ts`, `server/inventory-transfers.ts` | Inventory and transfer routes and validation |
| `web/App.tsx`, `web/Storefront.tsx` | Existing screen behavior and request examples |
| `web/Inventory*.tsx`, `web/styles.css` | Inventory UI and visual reference |
| `tests/*.test.ts` | Executable business examples and edge cases |
| `artifacts/screenshots/` | Existing desktop/mobile layout references |

Backend runtime: Node.js >=24.11, TypeScript, Fastify, and persistent embedded PostgreSQL through PGlite. Existing web UI: React, Arabic fonts, and RTL layout. Use the lockfile for the exact dependency set.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

The built demonstration runs at `http://127.0.0.1:3001`; customer storefront is `/shop`. For web development use `npm run dev`, with web at port 5173 and API at 3001. Choose one running mode because both use the API port. The `demo` and `dev` commands remain running.

Do not copy `.local/postgres`, `.local/secrets.json`, session cookies, or real customer information into agent prompts or mobile assets. Cloud environments should install from the lockfile and create their own synthetic local data.

## 5. Mobile architecture and scope decisions

### Framework decision

Keep widget contracts and acceptance criteria framework-independent. If the developer needs a starting convention, use a proposed Flutter/Dart implementation under `mobile/`; confirm the team's existing stack before creating its scaffold. A React Native implementation can use the same feature boundaries and translate widget names into components. No framework migration of the existing web/backend is required.

Do not add multiple competing state-management or networking libraries. Record the chosen framework, supported OS versions, navigation, state management, HTTP client, and test tooling in `mobile/README.md` before the first implementation milestone. Pin dependencies in the mobile lockfile.

### Proposed structure

```text
mobile/
  README.md
  lib/
    app/                 # startup, navigation, active identity, feature flags
    core/
      theme/             # colors, typography, spacing, localization
      network/           # transport, session adapter, errors, command execution
      models/            # DTOs matching the API exactly
      widgets/           # shared visual components
    features/
      courier/           # task list and shipment execution
      merchant/          # preparation and origin handover
      pickup/            # custody receipt and customer collection
      customer/          # delivery choice, order status, code display
      tracking/          # public low-data tracking
      inventory/         # stock, receipts, counts, inspection
      transfers/         # separate transfer task lifecycle
    repositories/        # interfaces, mock implementations, API implementations
    dev_gallery/         # isolated widget states using synthetic fixtures
  test/
  integration_test/
```

Data flow: **screen → feature controller → repository → HTTP/session adapter → backend**. Repository interfaces return typed results; widgets receive view data, callbacks, busy state, and validation errors. Widgets must not issue HTTP requests or decide authoritative stock, price, custody, or permissions.

Use one operational shell with navigation based on the authenticated role for the prototype. Keep the customer integration surface independent of the operational identity. Production may split these into separate apps; reusable widgets and repositories should support that without duplicating business rules.

## 6. Widget implementation catalog

Every widget must have a gallery example for its meaningful states. Use synthetic fixtures, stable keys, accessibility labels, and localized text. “Inputs” describe UI contracts, not new backend fields.

| Widget | Inputs and events | Required behavior |
|---|---|---|
| `RoleAppShell` | account, navigation destinations, session-expired event | Display current role and scope; clear prior identity data on switch/logout |
| `AsyncContent` | loading, data, empty, error, retry | Distinguish initial failure from stale content after refresh failure |
| `ConnectionBanner` | offline/stale, last successful refresh | Explain stale data and disable custody mutations while offline |
| `ShipmentStatusBadge` | exact `ShipmentStatus` | Localize all 12 states; never use color as the only signal |
| `ShipmentCard` | shipment summary, open callback | Reference, origin/destination, status, relevant deadline and custody warning |
| `TaskFilterBar` | available filters, selection, change callback | Filter courier tasks locally without claiming complete server pagination |
| `NextActionPanel` | role, shipment view, eligible actions, execute callback | Show the next action and blocked reason; server remains final authority |
| `OriginHandoverChecklist` | required/prepared/released/received flags | Distinguish merchant release from courier receipt and mark legacy records |
| `CustodySummary` | interpreted custody and pending confirmation | Arrival is not receipt; avoid deriving custody from status alone |
| `DeadlineIndicator` | server deadline, expired/overdue flags | Show absolute time and countdown; refresh at expiry rather than changing state locally |
| `ActionConfirmationSheet` | action, assigned courier, reason/code requirements | Review physical action, validate inputs, prevent repeated taps while submitting |
| `DeliveryCodeInput` | six-digit string, error, submit callback | Preserve leading zeroes; support paste; never log or persist the code |
| `DeliveryCodeDisplay` | customer-issued code, expiresAt, request state | Show only to owning customer; keep code in memory and clear on logout/background |
| `ShipmentTimeline` | `TimelineEvent[]` | Ordered event history with actor/time; handle server-provided Arabic descriptions |
| `PickupPointCard` | site, selected, select callback | Address and eligibility; don't invent distance or hours |
| `DeliveryOptionSelector` | address/pickup mode, eligible sites | Clearly show selected destination; refresh unavailable options |
| `QuoteSummary` | feeMinor, currency, estimateLabel, expiresAt | Label demo pricing; expire quote and request another before submission |
| `OrderStatusCard` | storefront order, open callback | Show fulfillment status separately from commercial order context |
| `PublicTrackingView` | public endpoint response | Render only returned fields; no operational-detail fallback |
| `InventoryStockCard` | stock row and site | Separate available, reserved, quarantine, and on-hand quantities |
| `QuantityEntry` | bounded integer, label, validation | Respect the specific endpoint limits; do not accept decimal counts |
| `TransferCard` | transfer, open callback | Distinct transfer status and outstanding quantities; no shipment status reuse |
| `PartialReceiptForm` | ordered lines, already received, submitted quantities | Confirm actual receipt only; show remaining custody and issue state |

Widget acceptance: no horizontal overflow at 360 logical pixels, large text remains usable, keyboard does not cover primary form actions, loading does not erase existing content, and RTL/LTR layouts both work. Use approximately 48 logical pixels for primary touch targets. Reuse colors and typography from the existing product while adapting desktop layouts for one-handed mobile actions.

## 7. Screens, navigation, and priorities

| Priority | Role | Screens and primary work |
|---|---|---|
| P0 | Courier | My tasks → shipment detail → accept/decline → pickup → depart → deliver/fail |
| P0 | Merchant | My shipments → preparation → named-courier handover → timeline |
| P1 | Pickup employee | Point queue → receive physical parcel → release with customer code → return handover |
| P1 | Customer integration | Delivery choice → quote → confirmation → orders → code display |
| P1 | Public | Tracking token → limited shipment progress |
| P2 | Merchant/operations | Inventory by site → receipt/count/inspection; transfers → actual partial/full receipt |
| P2 | Courier | Assigned transfer task → accept → pickup after source release |
| Later | Operator | Mobile exception follow-up if needed; keep full dispatch/network/recovery administration on existing web |

A courier sees only assigned work. A merchant sees its own shipments and inventory sites. A pickup employee sees its own point's work. A customer sees orders belonging to its customer session. UI hiding improves usability; all authorization must still be enforced by the server.

## 8. State and custody rules the UI must respect

Canonical shipment states from `shared/contracts.ts`:

```text
ready, assigned, picked_up, in_transit, delivered, failed,
cancelled, returning, returned, awaiting_handover,
ready_for_pickup, pickup_expired
```

Use the source enum as the exhaustive contract. Never introduce a mobile-only server status.

Address-delivery happy path: `ready → assigned → picked_up → in_transit → delivered`. Acceptance and merchant confirmations update fields and version without necessarily changing the shipment status.

Pickup branch: `in_transit → awaiting_handover → ready_for_pickup → delivered`. Only the point's `receive_pickup` confirmation transfers custody to that point. Expired collection becomes `pickup_expired`; return assignment becomes `returning`, and custody remains with the point until `handover_return`.

| Action | Actor | Important UI prerequisite |
|---|---|---|
| `assign` / `assign_return` | Operator | Select eligible courier; backend checks shared capacity |
| `accept` | Assigned courier | Assignment deadline not expired; refresh if expired |
| `decline` | Assigned courier | Unaccepted task and reason; remove inaccessible task after success |
| `unassign` | Operator | Reason and correct custody stage; backend decides eligibility |
| `prepare` | Owning merchant | Ready/assigned, not already prepared/released |
| `handover_origin` | Owning merchant | Prepared, courier accepted; send matching `courierId` |
| `pickup` | Assigned courier | For new shipments, merchant prepared and released parcel |
| `depart` | Assigned courier | Pickup completed |
| `deliver` | Assigned courier | In transit to address; code if `deliveryProofRequired` |
| `arrive_pickup` | Assigned courier | In transit to pickup point |
| `receive_pickup` | Point employee | Awaiting handover at that employee's point |
| `release_pickup` | Point employee | Point custody, within collection deadline, customer code when required |
| `fail` | Assigned courier | Delivery attempt failed; reason required |
| `cancel` | Owning merchant/operator | Only eligible pre-transport state; never bypass pending custody |
| `return` | Operator | Eligible post-pickup state; reason required |
| `handover_return` | Point employee | Accepted return courier and point still holds parcel |
| `receive_return` | Operator | Return custody requirements satisfied; actual origin receipt |

This is a UI summary. `server/domain.ts` and feature tests define complete role and transition checks. Implement action eligibility in one feature policy helper with tests; do not duplicate it across widgets.

Current demo policies: assignment acceptance within 5 minutes; origin pickup follow-up after 30 minutes; point collection within 72 hours. Read actual deadline fields from the server. Do not use these sample policies as production commitments.

Codes have six digits, a 10-minute lifetime, five wrong attempts, and a minimum one-minute reissue delay. Only the owning storefront customer can issue a code. Manual shipments without customer linkage currently use a clearly labeled demo acknowledgment.

Inventory transfer states are separate: `reserved`, `assigned`, `accepted`, `released`, `in_transit`, `received`, `cancelled`. A partial receipt can leave quantities in transit. `issueOpen` is not a terminal status. Do not assume all shipment actions exist for transfers.

## 9. Existing API integration guide

### Session and deployment boundary

The current operational demo uses an HttpOnly, SameSite Strict `session` cookie, with an eight-hour lifetime and in-memory sessions. Restarting the backend requires login again. Customer storefront uses a separate `shop` cookie. Native networking must maintain their distinct identity contexts; a demo account switch must not become production login.

The server binds only to `127.0.0.1`; `server/main.ts` rejects another host. Demo login and storefront also validate a localhost Host header. Mutations with an Origin header are checked against specific local origins. There is no established native CORS/session/deployment contract.

Use mocks for initial mobile work. For a native integration spike, have the backend developer define and verify an isolated loopback tunnel or platform-specific localhost forwarding arrangement, including Host, Origin, and cookie handling. Do not assume an emulator host alias works unchanged; test login, bootstrap, and an authorized command first. Do not expose this demo through a public cloud URL by removing its guards.

Production needs a documented user authentication/session contract, HTTPS service, tenant isolation, secret management, deployed PostgreSQL, and deployment/recovery checks. Application-level bearer keys used by `/api/v1/*` belong in the trusted commerce backend/BFF, never in a mobile binary. They are not courier or customer access tokens.

### Endpoint inventory

| Method and path | Use / result |
|---|---|
| `GET /api/health` | Backend readiness check |
| `GET /api/demo/accounts` | Available local demo identities |
| `POST /api/demo/session` | `{ "accountId": "<selected account id>" }`; establishes operational cookie |
| `DELETE /api/session` | Operational logout |
| `GET /api/bootstrap` | `Bootstrap`: account, scoped shipments, couriers, sites, stats |
| `GET /api/shipments/:id` | `{ shipment, timeline, inventory }` |
| `POST /api/shipments/:id/actions` | Shipment command; returns updated shipment |
| `GET /api/shipments/pickup-alerts` | Operator origin-pickup exception queue |
| `GET /api/tracking/:token` | Limited public tracking projection |
| `POST /api/storefront/session` | Customer demo session, catalog, eligible points, availability |
| `GET /api/storefront/availability` | Availability projection |
| `POST /api/storefront/checkouts` | Validated items and destination → checkout with quote |
| `POST /api/storefront/orders` | `{ "checkoutId": "<uuid>" }`, idempotent order confirmation |
| `GET /api/storefront/orders` | `{ orders: StoreOrder[] }` |
| `POST /api/storefront/orders/:id/delivery-code` | Owning customer only; `{ code, expiresAt }` |
| `POST /api/v1/quotes` | Trusted application service quote |
| `POST /api/v1/fulfillments` | Trusted application confirmation via `quoteId` |
| `GET /api/v1/fulfillments/:id` | Application/merchant-scoped fulfillment |
| `GET /api/inventory` | Inventory projection |
| `GET/POST /api/inventory/sites` | Read/create owned inventory sites |
| `POST /api/inventory/sites/:id/products` | Attach a product with zero opening balance |
| `POST /api/inventory/receipts` | Record actual incoming stock |
| `GET/POST /api/inventory/counts` | Read/record inventory counts |
| `GET /api/inventory/reconciliation` | Internal inventory comparison |
| `POST /api/inventory/returns/:id/inspect` | Partial/full restock or discard inspection |
| `GET/POST /api/inventory/transfers` | List/create same-merchant transfers |
| `GET /api/inventory/transfers/:id` | Transfer detail/history |
| `POST /api/inventory/transfers/:id/actions` | Transfer-specific command |

Copy exact inventory and checkout request bodies from their route schemas and tests when implementing those milestones. Never invent payload fields from screen labels. Strict validation rejects extra fields; some shared types can differ from the accepted route schema.

### Shipment command example

```http
POST /api/shipments/<shipment-id>/actions
Content-Type: application/json
Idempotency-Key: <unique command UUID>
Cookie: <managed by the demo session adapter>

{
  "action": "deliver",
  "expectedVersion": 7,
  "deliveryCode": "012345"
}
```

`expectedVersion` must be the latest server version. Optional schema fields are `courierId`, `reason`, and `deliveryCode`; send only the fields needed for the action. Never trim leading zeroes from a code. New commands get new keys; retries of an uncertain command retain the original key and identical body.

Transfer commands use their own schema: `assign`, `accept`, `decline`, `unassign`, `release`, `pickup`, `cancel`, `report_issue`, `receive`. They require `expectedVersion` and a reason of 3–240 characters. `assign` additionally requires `courierId`; `receive` requires actual `{ productId, quantity }` items. Read `server/inventory-transfers.ts` for role and quantity checks.

## 10. Reliability, privacy, and error behavior

Implement a reusable command executor with states `idle → submitting → succeeded / rejected / outcomeUnknown`. Keep the command key and original body in memory while recovering an uncertain result. Do not automatically resend a delivery-code command: wrong code attempts can consume the server's attempt budget. Refresh the shipment and let the user explicitly retry the same uncertain command if still appropriate.

After confirmed success, update detail from the response and refresh list/history. If that refresh fails, show “Action saved; latest details could not be refreshed,” and retry the read. Never present a saved mutation as failed or create a new mutation key just to reload data.

| Condition | Mobile response |
|---|---|
| `VERSION_CONFLICT` | Refresh detail, explain that it changed, ask the user to review before a new command |
| `ASSIGNMENT_EXPIRED` | Refresh/remove expired task; stop the countdown |
| `IDEMPOTENCY_CONFLICT` | Stop; report command recovery problem without silent payload alteration |
| `QUOTE_EXPIRED` | Obtain a fresh quote and let the customer review it |
| `CAPACITY_EXCEEDED` / `PICKUP_CAPACITY_EXCEEDED` | Refresh eligible choices; do not imply reservation succeeded |
| `PROOF_REQUIRED`, `PROOF_INVALID`, `PROOF_LOCKED`, `PROOF_EXPIRED` | Specific code feedback; no automatic code submission loop |
| `RETURN_REQUIRED` | Explain that cancellation is unavailable and route to authorized return handling |
| HTTP 401 | Clear scoped sensitive state and recover/login through the selected session contract |
| HTTP 403 | Explain permission failure and refresh action availability |
| HTTP 404 after decline/custody transfer | Remove now-inaccessible detail and refresh scoped list |
| HTTP 429 | Show retry guidance and slow reads; avoid rapid mutation retries |
| Transport timeout | Show outcome unknown; refresh status/history before further action |

Use `code` for local error mapping; preserve `requestId` for support where provided. Server errors and timeline descriptions can be Arabic, so fallback text must tolerate mixed-language content.

For the first release, no offline custody, stock, code, or delivery writes. Display only an in-memory last successful view while disconnected, mark it stale, and disable mutations. Do not persist private demo responses or codes; the backend sends `Cache-Control: no-store`. A production offline cache requires a separate data/security contract.

Refresh visible active tasks on foreground return, after commands, and through a configurable foreground polling interval. A proposed default is 10 seconds, with backoff on failures and no polling in background. Refresh immediately around deadlines. There is no mobile WebSocket or push contract today; server-to-server webhooks are not a mobile subscription mechanism.

Public tracking must use its own response type and endpoint. Never fetch private shipment detail to enrich it. Redact cookies, tokens, recipient addresses, codes, and command bodies from logs and analytics. Keep money as integer `feeMinor`/`subtotalMinor` plus currency; reuse the existing demo formatting convention until the backend documents a production currency scale. Never silently assume SYP has a specific divisor.

## 11. Localization and interaction design

The handoff is English; product localization should support the current Arabic experience plus English. Store translation keys separately from server enum values. Mirror directional navigation for RTL, but keep codes and identifiers readable in LTR runs. Use local date formatting with timezone awareness; server timestamps remain the source of truth.

Place the next action and custody information above the full timeline. Courier screens should prioritize the parcel reference, origin, destination, deadline, and one primary action. Merchant handover must prominently identify the assigned courier. Destructive or physical confirmations need a review sheet; routine navigation does not.

Do not copy the storefront's illustrative 3D scene into operational task screens. Do not add map, scanner, location, camera, or notification permissions before the corresponding backend capability and user flow exist.

## 12. Implementation milestones

These are dependency-based milestones, not promised calendar estimates. Complete one reviewable task at a time.

| ID | Deliverable | Dependency | Acceptance evidence |
|---|---|---|---|
| M0 | Mobile README, framework decision, repository interfaces, DTO map, synthetic fixtures | None | Clean setup instructions; field mapping reviewed against source |
| M1 | Theme/localization, shell, async states, shipment card, badge, deadlines, gallery | M0 | Screenshots at 360/390 widths, RTL/LTR and large-text checks |
| M2 | Courier task list/detail, next-action panel, confirmations, mock command executor | M1 | Happy path plus stale version, unknown outcome, expiry and code-error tests |
| M3 | Merchant preparation/handover and pickup employee workflows | M2 | Independent actors confirm custody; arrival cannot masquerade as receipt |
| M4 | Verified local API adapter and isolated multi-role demo journey | M2–M3 and connection spike | Login/cookies verified; real API journey passes without guard removal |
| M5 | Customer integration widgets, quote expiry, owned order/code display, public tracking | M4 | Address and point collection journeys; ownership/privacy tests |
| M6 | Inventory and transfer components/screens | M4 and exact inventory contract mapping | Partial receipt leaves remaining custody; inventory quantities use real response |
| M7 | Release hardening and production API adapter | Production backend contract | Device QA, secure session recovery, role isolation, real deployment smoke checks |

Each milestone delivers code, a brief README update, meaningful tests, and screenshots. Mock completion must be labeled as mock completion. M7 cannot be claimed complete against the current localhost-only demo.

First coding tasks:

1. Define typed `ShipmentRepository` and `SessionRepository` interfaces with synthetic mock implementations.
2. Implement exhaustive status localization and `ShipmentStatusBadge`.
3. Build `AsyncContent`, `ConnectionBanner`, and `ShipmentCard` with gallery states.
4. Build courier task detail using `OriginHandoverChecklist`, `CustodySummary`, and `NextActionPanel`.
5. Add `ActionConfirmationSheet`, code entry, and the recoverable command executor.
6. Run the M2 review before expanding to merchant and pickup roles.

## 13. Test scenarios and definition of done

The mobile test suite must cover behavior that can break operations, not only render snapshots:

- Address delivery: preparation and independent merchant/courier confirmations precede departure; a valid customer code completes delivery.
- Point delivery: arrival preserves courier custody; point receipt transfers it; customer collection consumes the code.
- Assignment: late acceptance is rejected; decline removes access; expiry refreshes the list.
- Version conflict: another actor changes the parcel while a confirmation sheet is open; refresh prevents stale submission.
- Lost response: confirmed server action plus failed read refresh does not produce a second mutation.
- Code errors: leading zeroes preserved; invalid/expired/locked errors clear busy state; no automated repeated guesses.
- Offline: visible data marked stale; custody/stock writes disabled.
- Session isolation: account change/logout clears scoped detail; customer identity cannot issue another customer's code.
- Public tracking: no recipient address, recipient name, code, or private timeline enrichment.
- Inventory transfer: source release and courier pickup are separate; partial destination receipt preserves outstanding quantities.
- Accessibility: RTL/LTR, large text, keyboard/paste, screen-reader labels, and narrow-width layout.

Done means the feature meets its milestone criteria, uses exact wire names, handles failure and refresh paths, has relevant behavior tests, and includes screenshots and instructions another developer can reproduce. For backend changes, run `npm run typecheck`, `npm test`, and `npm run build`. For mobile changes, record actual framework analyzer/test/build commands in the mobile README. Never claim a test ran if the cloud environment lacked the SDK or device.

## 14. Claude Code / cloud coding task prompt

Copy this block into a new coding session and fill in the task fields:

```text
You are implementing mobile UI for the Independent Logistics Platform.
Read docs/MOBILE-DEVELOPMENT-PLAN.md, then the source files relevant to this task.
Read any applicable repository instructions before editing.

Milestone: <M0-M7>
Task: <one concrete deliverable>
Framework and toolchain: <recorded decision from mobile/README.md>
Allowed files: <specific mobile directories; backend only if explicitly in scope>
Repository mode: <mock or verified local API>
Acceptance criteria: <copy the relevant widget/milestone behavior>

Treat shared/contracts.ts and current route schemas as wire-contract references.
Use server/domain.ts and feature tests for business behavior.
Do not infer production readiness from demo endpoints or historical documents.
Keep HTTP and business orchestration out of presentational widgets.
Keep production application keys out of the mobile client.
Never read or print .local/secrets.json or session cookies.
Never bypass localhost, Host, Origin, identity, or role checks to make a demo work.
Do not add unimplemented GPS, COD, push, optimization, or intercity behavior.
Use typed synthetic mocks for unavailable capabilities and label them clearly.
Preserve command idempotency, version conflicts, custody boundaries, and code privacy.
Avoid broad refactors; implement only the selected reviewable task.

Before coding, summarize the relevant fields, endpoint bodies, and assumptions.
Then implement, run available checks, and inspect the requested UI states.
Report changed files, commands and results, screenshots, and unresolved dependencies.
If a platform SDK is unavailable, finish independent work and state exactly which
validation remains unrun. Do not invent results or change backend contracts silently.
```

Keep the agent context compact: this handoff, relevant shared DTOs, relevant route/schema, one feature test file, and only the web component needed for behavior reference. Exclude `node_modules/`, `dist/`, binary reports, secrets, and unrelated historical documents. Include synthetic request/response fixtures when delegating a bounded widget task.

## 15. Decisions to record before connecting production

- Confirm Flutter versus the team's existing mobile framework, target OS versions, and distribution approach.
- Confirm whether courier, merchant, and point employee share one app or separate binaries.
- Confirm whether customer widgets embed in Tendsy or ship in a separate demonstration shell.
- Agree the production user authentication, customer identity, tenant scoping, and session expiry contract.
- Document production money scale, localization of server descriptions, and response pagination.
- Define notification, offline storage, address/geolocation, and independent delivery-proof requirements before adding their UI.

These decisions do not block the mock widget gallery or initial courier UI. They do block claims of production integration where the required contract is missing.
