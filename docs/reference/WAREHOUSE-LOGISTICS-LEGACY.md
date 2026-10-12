# Warehouse and local delivery workflow

Warehouse owners sign in with a normal Cassion account and open `/warehouse` to register one or more
facilities. Each facility records its address, city, decimal GPS coordinates, capacity in product
units, and optional storage features. Owners can propose stock allocations and update facility
capacity from the same dashboard. A store owner or inventory-authorized team member must approve or
reject each allocation request before warehouse stock changes.

Stores enter their city and GPS coordinates under **Merchant panel → Settings**. For stores with
coordinates, the warehouse dashboard uses great-circle distance (Haversine) to show active stock
matches at the nearest active facility in the same city. A stock allocation is a location split of
the store's existing variant stock, not extra sellable inventory; allocations cannot exceed either
the store's stock or the facility's capacity.

At checkout, stock allocated to facilities is reserved first. The order records its pickup stops;
any remaining units are picked up from the store. Cancellation restores reserved quantities to their
original facilities. The courier job view displays the pickup stops and the existing delivery flow
records assignment, pickup, en-route, and delivered status.

Merchants can choose a courier themselves or use **Auto-assign local courier**. Automatic assignment
prefers couriers in the store's city, then the latest courier score and lighter active workload.
Shipping prices remain the store's configured delivery fee, calculated by the existing checkout.
This workflow uses Cassion's local courier accounts; it does not call an external 3PL or provide
carrier-specific rate quotes. A carrier integration requires a selected provider and its credentials.

## Local shop parcel pickup

An active shop can opt into being a customer pickup point from **Merchant panel → Settings**. The
shop must provide its street address and city; only participating shops in the originating store's
city appear in checkout. Buyers choose delivery or a pickup shop separately for each store in a
multi-store order. For an all-pickup checkout the home-delivery address is not required or sent to
the courier. The store's configured delivery fee still applies to pickup orders; pickup does not
automatically waive shipping charges.

The selling store prepares the order and assigns a local courier as usual. For pickup orders, the
courier route ends at the selected shop, not the buyer's home. The courier marks **Arrived at pickup
shop**; the shop's team signs in and opens **Parcel pickup** in the merchant dashboard. Staff match
the order number and parcel, then confirm physical receipt. This completes the courier handoff and
queues arrival email for the buyer and confirmation email for the courier.

After receipt, the buyer email contains the pickup address, opening hours, tracking link and a
one-time six-digit handover code. The shop manager enters that code when handing over the parcel.
For cash-on-delivery orders, the manager must also confirm that the amount was collected; the
platform records the resulting amount as owed by the pickup shop to the selling store. The selling
store records settlement only after physically receiving those funds. Codes are encrypted at rest
while active, compared against a hash, rate-limited, and erased after collection or cancellation.

Arrival messages use the Resend API. Configure `RESEND_API_KEY` and a verified `EMAIL_FROM` sender
in the deployment environment (never in source control). Message payloads are encrypted in a
transactional outbox; transient failures retry with backoff. Without those settings the messages
remain queued and the server logs that email delivery is paused. In-app order tracking also reflects
pickup progress. This implementation does not send SMS or WhatsApp messages.

## Courier live location

Location is opt-in per active delivery: the courier explicitly starts sharing, and the browser asks
for geolocation permission. Updates are throttled to at most one every 15 seconds. The customer and
the selling store see a map link only while the courier is picked up or en route and the last update
is under two minutes old. The courier can stop sharing at any time; completion, failure, reassignment
and cancellation clear coordinates. A housekeeping job deletes coordinates older than two minutes.
This is foreground browser tracking, not continuous background tracking; couriers must keep the
delivery page open.

## Manager access

`/manager-login` reuses the platform's normal password and optional two-factor flow. It does not
offer a role selector: store membership routes managers to the merchant dashboard, and warehouse
ownership routes them to `/warehouse`. Accounts without either entitlement are denied access.

## PIDO partner pickup and delivery

PIDO is an extension of the existing Cassion marketplace and PostgreSQL database. An owner or
manager registers a shop as a parcel origin from **Merchant panel → Settings**; a warehouse owner
can register a facility from the same authenticated PIDO API. The site remains pending until an
admin activates it. Admins can also register partner sites for active stores and warehouses. The
record includes the address, city, manually entered coordinates, contact phone and partner type.
Coordinates are not geocoded; confirm their accuracy before activating a location.

A store team creates a PIDO parcel from an eligible `processing` or `ready` order, choosing an
active origin and either an active partner pickup destination or a delivery address. An admin or the
store team assigns an active vehicle and a verified, active courier whose driving licence has not
expired. The courier must record a pre-trip vehicle check before collecting the parcel. For a partner
pickup destination, the driver records arrival and then customer pickup; for home delivery the driver
can mark the parcel delivered directly from the out-for-delivery state. Driver and vehicle checks,
incidents, assignments and status changes are recorded in operational logs.

Customers can follow the unguessable tracking link without signing in. The page shows the parcel
timeline, origin and destination, and an OpenStreetMap map/directions link. It is not a paid dispatch
or route-optimization integration: coordinates are entered by the partner, road routing depends on
OpenStreetMap and network availability, and live tracking appears only after the courier explicitly
consents and sends a fresh location while the parcel is active. Coordinates and consent are cleared
after two minutes without updates and when an assignment ends. Public tracking intentionally omits
recipient phone numbers and private driver notes.

Each parcel status queues an SMS when the order has a recipient phone number. Configure
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM` or
`TWILIO_MESSAGING_SERVICE_SID` to enable delivery. The encrypted outbox worker attempts delivery
every 15 seconds, retries transient errors with backoff, and stores no recipient or message body
after provider acceptance. Without Twilio settings, queued notifications are not sent; configure and
monitor the provider before promising SMS delivery. Retries are at-least-once if the provider accepts
a message but the response is lost.

Successful `delivered` or `picked_up` completion posts one immutable, balanced journal entry:
**USD 0.10** (10 US cents), debit `partner_commission_receivable`, credit `commission_revenue`.
This is a recorded receivable, not a collected payment; payer allocation, settlement, refunds and
reversals are not implemented. PIDO completion also does not yet close or settle the underlying
marketplace order, update its COD lifecycle, or reconcile payment. Treat the journal as an operational
commission record until those accounting and order-lifecycle integrations are explicitly agreed and
implemented.
