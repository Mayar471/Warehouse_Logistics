import { randomUUID } from 'node:crypto';
import type { Transaction } from './db.js';
export async function revokeSharing(
  tx: Transaction,
  shipmentId: string,
  actor: string,
  reason: string,
) {
  const result = await tx.query(
    'UPDATE location_sharing SET active=false,latitude=NULL,longitude=NULL,accuracy=NULL,measured_at=NULL,received_at=NULL,fingerprint=NULL WHERE shipment_id=$1 AND active RETURNING shipment_id',
    [shipmentId],
  );
  if (result.rows.length)
    await tx.query(
      'INSERT INTO location_audit(id,shipment_id,actor_id,action,reason) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), shipmentId, actor, 'stopped', reason],
    );
}
export async function expireSharing(tx: Transaction, now: number) {
  const rows = (
    await tx.query<{ shipment_id: string }>(
      'SELECT shipment_id FROM location_sharing WHERE active AND expires_at<=$1 ORDER BY expires_at LIMIT 100',
      [new Date(now).toISOString()],
    )
  ).rows;
  for (const row of rows)
    await revokeSharing(tx, row.shipment_id, 'worker', 'انتهاء مهلة المشاركة');
  // Reads enforce expiry independently; this worker only removes stored coordinates.
  await tx.query(
    'UPDATE location_sharing SET latitude=NULL,longitude=NULL,accuracy=NULL,measured_at=NULL,received_at=NULL,fingerprint=NULL WHERE measured_at<$1',
    [new Date(now - 24 * 60 * 60_000).toISOString()],
  );
}
