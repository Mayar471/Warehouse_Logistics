import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import type { Account } from '../shared/contracts.js';
import { statusLabels } from '../shared/contracts.js';
import { activeShipmentStatuses } from '../shared/shipment-filters.js';
import { z } from 'zod';
import { mapShipment } from './domain.js';
import type { ShipmentRow } from './db.js';
export function registerShipmentSearch(
  app: FastifyInstance,
  db: PGlite,
  account: (req: FastifyRequest) => Account,
) {
  app.get('/api/shipments', async (req) => {
    const a = account(req);
    const q = z
      .object({
        search: z.string().trim().max(100).default(''),
        filter: z
          .enum(['all', 'active', 'attention', ...Object.keys(statusLabels)] as [
            string,
            ...string[],
          ])
          .default('all'),
        page: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .strict()
      .parse(req.query);
    const scope =
      a.role === 'operator'
        ? '$1::text IS NULL'
        : a.role === 'merchant'
          ? 's.merchant_id=$1'
          : a.role === 'courier'
            ? 's.courier_id=$1'
            : 's.pickup_site_id=$1';
    const identity =
      a.role === 'merchant'
        ? a.merchantId
        : a.role === 'courier'
          ? a.courierId
          : a.role === 'pickup'
            ? a.pickupSiteId
            : null;
    const where = `${scope} AND ($2='' OR strpos(lower(s.reference||' '||s.external_reference||' '||s.recipient_name||' '||s.destination||' '||m.name),lower($2))>0) AND ($3='all' OR ($3='active' AND s.status=ANY($4::text[])) OR ($3='attention' AND (s.status IN ('failed','pickup_expired') OR s.pickup_overdue)) OR s.status=$3)`;
    const params = [identity, q.search, q.filter, activeShipmentStatuses];
    const from = ' FROM shipments s JOIN merchants m ON m.id=s.merchant_id WHERE ' + where;
    const total = (
      await db.query<{ total: number }>('SELECT COUNT(*)::integer total' + from, params)
    ).rows[0].total;
    const rows = (
      await db.query<ShipmentRow>(
        'SELECT s.*' + from + ' ORDER BY s.created_at DESC,s.id LIMIT 25 OFFSET $5',
        [...params, q.page * 25],
      )
    ).rows;
    return {
      rows: await Promise.all(rows.map((s) => mapShipment(db, s))),
      total,
      page: q.page,
      pageSize: 25,
    };
  });
}
