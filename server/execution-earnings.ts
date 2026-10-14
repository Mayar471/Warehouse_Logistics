import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import type { Account } from '../shared/contracts.js';
import { assert } from './domain.js';
export function registerExecutionEarnings(
  app: FastifyInstance,
  db: PGlite,
  account: (req: FastifyRequest) => Account,
) {
  app.get('/api/execution-earnings', async (req) => {
    const a = account(req);
    assert(
      ['operator', 'courier'].includes(a.role),
      403,
      'FORBIDDEN',
      'الأجور للعمليات والمندوب المستقل فقط',
    );
    const where =
      a.role === 'operator' ? '$1::text IS NULL' : 'e.courier_id=$1 AND e.company_id IS NULL';
    const scope = [a.role === 'operator' ? null : a.courierId];
    const rows = (
      await db.query(
        `SELECT e.shipment_id AS "shipmentId",s.reference,e.beneficiary_name AS "beneficiaryName",e.company_id AS "companyId",e.courier_id AS "courierId",e.rate_bps AS "rateBps",e.fee_minor AS "feeMinor",e.amount_minor::double precision AS "amountMinor",e.currency,e.earned_at AS "earnedAt" FROM execution_earnings e JOIN shipments s ON s.id=e.shipment_id WHERE ${where} ORDER BY e.earned_at DESC,e.shipment_id LIMIT 100`,
        scope,
      )
    ).rows;
    const groups = (
      await db.query(
        `SELECT MAX(e.beneficiary_name) AS "beneficiaryName",COALESCE(e.company_id,e.courier_id) AS "beneficiaryId",CASE WHEN e.company_id IS NULL THEN 'courier' ELSE 'company' END kind,COUNT(*)::integer tasks,COUNT(*) FILTER(WHERE e.amount_minor IS NULL)::integer unconfigured,COALESCE(SUM(e.amount_minor),0)::double precision AS "amountMinor" FROM execution_earnings e WHERE ${where} GROUP BY COALESCE(e.company_id,e.courier_id),CASE WHEN e.company_id IS NULL THEN 'courier' ELSE 'company' END ORDER BY 1`,
        scope,
      )
    ).rows;
    return { rows, groups, displayLimit: 100, settlementImplemented: false };
  });
}
