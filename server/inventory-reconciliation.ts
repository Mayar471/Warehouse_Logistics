import type { Transaction } from './db.js';
import type {
  InventoryReconciliation,
  InventoryReconciliationRow,
} from '../shared/inventory-reconciliation.js';

export async function reconcileInventory(
  tx: Transaction,
  merchantId: string | null,
  siteId: string | null = null,
  productId: string | null = null,
): Promise<InventoryReconciliation> {
  const filter =
    '($1::text IS NULL OR merchant_id=$1) AND ($2::text IS NULL OR site_id=$2) AND ($3::text IS NULL OR product_id=$3)';
  const result = await tx.query<Omit<InventoryReconciliationRow, 'matched' | 'differences'>>(
    `WITH s AS (
    SELECT * FROM inventory_stock WHERE ${filter}
  ), l AS (
    SELECT merchant_id,site_id,product_id,
    SUM(CASE WHEN kind IN ('opening','receipt','receive_return','adjustment_in','transfer_receive','transfer_receive_damaged') THEN quantity WHEN kind IN ('handover_origin','discard','adjustment_out','transfer_send','transfer_discard') THEN -quantity ELSE 0 END)::double precision AS on_hand,
    SUM(CASE WHEN kind IN ('reserve','transfer_reserve') THEN quantity WHEN kind IN ('handover_origin','cancel','reservation_expired','transfer_send','transfer_cancel') THEN -quantity ELSE 0 END)::double precision AS reserved,
    SUM(CASE WHEN kind IN ('receive_return','transfer_receive_damaged') THEN quantity WHEN kind IN ('restock','discard','transfer_restock','transfer_discard') THEN -quantity ELSE 0 END)::double precision AS quarantine,
    COUNT(*) FILTER(WHERE kind NOT IN ('opening','receipt','receive_return','adjustment_in','handover_origin','discard','adjustment_out','reserve','cancel','reservation_expired','restock','prepare','deliver','release_pickup','transfer_reserve','transfer_cancel','transfer_send','transfer_receive','transfer_receive_damaged','transfer_loss','transfer_restock','transfer_discard'))::integer AS unknown
    FROM inventory_movements WHERE ${filter} GROUP BY merchant_id,site_id,product_id
  ), r AS (
    SELECT merchant_id,site_id,product_id,
    SUM(CASE WHEN state IN ('reserved','prepared') THEN quantity ELSE 0 END)::double precision AS reserved,
    SUM(CASE WHEN state='quarantined' THEN quantity-restocked_quantity-discarded_quantity ELSE 0 END)::double precision AS quarantine
    FROM inventory_reservations WHERE ${filter} GROUP BY merchant_id,site_id,product_id
  ), t AS (
    SELECT i.merchant_id,i.source_id AS site_id,i.product_id,SUM(i.quantity)::double precision AS reserved FROM inventory_transfer_lines i JOIN inventory_transfers t ON t.id=i.transfer_id WHERE t.status IN ('reserved','assigned','accepted') AND ($1::text IS NULL OR i.merchant_id=$1) AND ($2::text IS NULL OR i.source_id=$2) AND ($3::text IS NULL OR i.product_id=$3) GROUP BY i.merchant_id,i.source_id,i.product_id
  ), q AS (
    SELECT merchant_id,destination_id AS site_id,product_id,SUM(damaged-restocked-discarded)::double precision AS quarantine FROM inventory_transfer_lines WHERE damaged>restocked+discarded AND ($1::text IS NULL OR merchant_id=$1) AND ($2::text IS NULL OR destination_id=$2) AND ($3::text IS NULL OR product_id=$3) GROUP BY merchant_id,destination_id,product_id
  ), keys AS (
    SELECT merchant_id,site_id,product_id FROM s UNION SELECT merchant_id,site_id,product_id FROM l UNION SELECT merchant_id,site_id,product_id FROM r UNION SELECT merchant_id,site_id,product_id FROM t UNION SELECT merchant_id,site_id,product_id FROM q
  ) SELECT k.merchant_id AS "merchantId",k.site_id AS "siteId",k.product_id AS "productId",COALESCE(m.name,k.merchant_id) AS "merchantName",COALESCE(p.name,k.site_id) AS "siteName",
    s.on_hand AS "onHand",s.reserved,s.quarantine,s.version,
    COALESCE(l.on_hand,0) AS "ledgerOnHand",COALESCE(l.reserved,0) AS "ledgerReserved",COALESCE(l.quarantine,0) AS "ledgerQuarantine",
    COALESCE(r.reserved,0) AS "reservedFromOrders",COALESCE(t.reserved,0) AS "reservedForTransfers",COALESCE(r.quarantine,0) AS "quarantineFromReturns",COALESCE(q.quarantine,0) AS "quarantineFromTransfers",COALESCE(l.unknown,0) AS "unknownMovements"
    FROM keys k LEFT JOIN s USING(merchant_id,site_id,product_id) LEFT JOIN l USING(merchant_id,site_id,product_id) LEFT JOIN r USING(merchant_id,site_id,product_id) LEFT JOIN t USING(merchant_id,site_id,product_id) LEFT JOIN q USING(merchant_id,site_id,product_id)
    LEFT JOIN merchants m ON m.id=k.merchant_id LEFT JOIN sites p ON p.id=k.site_id ORDER BY k.merchant_id,k.site_id,k.product_id`,
    [merchantId, siteId, productId],
  );
  const rows = result.rows.map((row) => {
    const differences: string[] = [];
    if (row.onHand === null) differences.push('رصيد مفقود');
    if (row.onHand !== row.ledgerOnHand) differences.push('الموجود لا يطابق الحركات');
    if (row.reserved !== row.ledgerReserved) differences.push('المحجوز لا يطابق الحركات');
    if (row.quarantine !== row.ledgerQuarantine) differences.push('المعزول لا يطابق الحركات');
    if (row.reserved !== row.reservedFromOrders + row.reservedForTransfers)
      differences.push('المحجوز لا يطابق الطلبات ومهام النقل');
    if (row.quarantine !== row.quarantineFromReturns + row.quarantineFromTransfers)
      differences.push('المعزول لا يطابق المرتجعات وتلف النقل');
    if (row.unknownMovements) differences.push('نوع حركة غير معروف');
    return { ...row, matched: !differences.length, differences };
  });
  const matched = rows.filter((row) => row.matched).length;
  rows.sort(
    (a, b) =>
      Number(a.matched) - Number(b.matched) ||
      a.merchantId.localeCompare(b.merchantId) ||
      a.siteId.localeCompare(b.siteId) ||
      a.productId.localeCompare(b.productId),
  );
  return {
    checkedAt: new Date().toISOString(),
    total: rows.length,
    matched,
    exceptions: rows.length - matched,
    displayLimit: 100,
    rows: rows.slice(0, 100),
  };
}
