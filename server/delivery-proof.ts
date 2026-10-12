import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { ShipmentRow, Transaction } from './db.js';
import { assert, DomainError } from './domain.js';
export const proofHash = (id: string, code: string, secret: string) =>
  createHmac('sha256', secret)
    .update('delivery-proof:' + id + ':' + code)
    .digest('hex');
export async function needsProof(tx: Transaction, row: ShipmentRow) {
  const r = await tx.query(
    "SELECT c.id FROM storefront_checkouts c JOIN quotes q ON q.id=c.quote_id WHERE q.application_id=$1 AND q.merchant_id=$2 AND q.input->>'externalReference'=$3 LIMIT 1",
    [
      (row as ShipmentRow & { application_id: string }).application_id,
      row.merchant_id,
      row.external_reference,
    ],
  );
  return r.rows.length > 0;
}
export async function issueProof(tx: Transaction, shipmentId: string, now: number, secret: string) {
  const old = await tx.query<{ issued_at: string }>(
    'SELECT issued_at FROM delivery_proofs WHERE shipment_id=$1',
    [shipmentId],
  );
  assert(
    !old.rows[0] || now - new Date(old.rows[0].issued_at).getTime() >= 60000,
    429,
    'PROOF_COOLDOWN',
    'انتظر دقيقة قبل إصدار رمز جديد',
  );
  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(now + 10 * 60000).toISOString();
  await tx.query(
    'INSERT INTO delivery_proofs(shipment_id,code_hash,expires_at,issued_at) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO UPDATE SET code_hash=$2,expires_at=$3,issued_at=$4,attempts=0,consumed_at=NULL',
    [shipmentId, proofHash(shipmentId, code, secret), expiresAt, new Date(now).toISOString()],
  );
  return { code, expiresAt };
}
export async function verifyProof(
  tx: Transaction,
  shipmentId: string,
  code: string | undefined,
  now: number,
  secret: string,
) {
  const r = await tx.query<{
    code_hash: string;
    expires_at: string;
    attempts: number;
    consumed_at: string | null;
  }>('SELECT * FROM delivery_proofs WHERE shipment_id=$1', [shipmentId]);
  const p = r.rows[0];
  if (!p || p.consumed_at || new Date(p.expires_at).getTime() <= now)
    return new DomainError(409, 'PROOF_EXPIRED', 'اطلب من العميل إصدار رمز استلام صالح');
  if (p.attempts >= 5)
    return new DomainError(429, 'PROOF_LOCKED', 'تجاوزت محاولات الرمز؛ يلزم رمز جديد من العميل');
  if (!code || !/^\d{6}$/.test(code))
    return new DomainError(
      422,
      'PROOF_REQUIRED',
      'أدخل رمز الاستلام المكون من ستة أرقام من العميل',
    );
  const actual = Buffer.from(proofHash(shipmentId, code, secret));
  const expected = Buffer.from(p.code_hash);
  if (!timingSafeEqual(actual, expected)) {
    await tx.query('UPDATE delivery_proofs SET attempts=attempts+1 WHERE shipment_id=$1', [
      shipmentId,
    ]);
    return new DomainError(422, 'PROOF_INVALID', 'رمز الاستلام غير صحيح');
  }
  return null;
}
