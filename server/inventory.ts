import { randomUUID } from 'node:crypto';
import type { Transaction, ShipmentRow } from './db.js';
import { assert } from './domain.js';
import { catalog, type CartItem } from '../shared/catalog.js';
import { reconcileInventory } from './inventory-reconciliation.js';

type Line = {
  merchant_id: string;
  site_id: string;
  product_id: string;
  quantity: number;
  state: string;
};
export async function availability(tx: Transaction) {
  return (
    await tx.query<{ productId: string; available: number }>(
      `SELECT i.product_id AS "productId",MAX(i.on_hand-i.reserved-i.quarantine)::integer AS available FROM inventory_stock i JOIN sites s ON s.id=i.site_id AND s.merchant_id=i.merchant_id WHERE i.merchant_id=$1 AND s.archived_at IS NULL AND s.city='دمشق' AND s.kind IN ('store','warehouse') GROUP BY i.product_id ORDER BY i.product_id`,
      ['merchant-a'],
    )
  ).rows;
}
// One origin must cover the entire basket. No split fulfillment or fabricated distance score.
export async function selectStoreOrigin(tx: Transaction, items: CartItem[]) {
  const candidates = (
    await tx.query<{ id: string; name: string }>(
      `SELECT s.id,s.name FROM sites s WHERE s.merchant_id='merchant-a' AND s.archived_at IS NULL AND s.city='دمشق' AND s.kind IN ('store','warehouse') AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS b("productId" text,quantity integer)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_stock i WHERE i.merchant_id=s.merchant_id AND i.site_id=s.id AND i.product_id=b."productId" AND i.on_hand-i.reserved-i.quarantine>=b.quantity)
    ) ORDER BY CASE WHEN s.id='site-a' THEN 0 ELSE 1 END,s.id`,
      [JSON.stringify(items)],
    )
  ).rows;
  for (const site of candidates) {
    const report = await reconcileInventory(tx, 'merchant-a', site.id);
    const consistent = items.every((item) =>
      report.rows.some((row) => row.productId === item.productId && row.matched),
    );
    if (consistent) return site;
  }
  assert(
    false,
    409,
    'NO_FULFILLMENT_ORIGIN',
    'لا يوجد موقع متاح يستطيع تجهيز كامل السلة الآن. عدّل الكميات أو المنتجات ثم أعد حساب التوصيل.',
  );
}
export async function movement(
  tx: Transaction,
  line: Line,
  shipmentId: string | null,
  kind: string,
  actor: string,
  reason: string,
  transferId: string | null = null,
) {
  await tx.query(
    'INSERT INTO inventory_movements(id,merchant_id,site_id,product_id,shipment_id,kind,quantity,actor_name,reason,transfer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      line.merchant_id,
      line.site_id,
      line.product_id,
      shipmentId,
      kind,
      line.quantity,
      actor,
      reason,
      transferId,
    ],
  );
}
export async function reserveCheckout(tx: Transaction, row: ShipmentRow, quoteId: string) {
  const checkout = (
    await tx.query<{ id: string; items: CartItem[]; inventory_required: boolean }>(
      'SELECT id,items,inventory_required FROM storefront_checkouts WHERE quote_id=$1',
      [quoteId],
    )
  ).rows[0];
  if (!checkout?.inventory_required) return;
  const origin = (
    await tx.query<{ city: string; kind: string; merchant_id: string }>(
      'SELECT city,kind,merchant_id FROM sites WHERE id=$1',
      [row.origin_id],
    )
  ).rows[0];
  assert(
    origin?.merchant_id === row.merchant_id &&
      origin.city === 'دمشق' &&
      ['store', 'warehouse'].includes(origin.kind),
    409,
    'INVALID_ORIGIN',
    'موقع التنفيذ لم يعد ضمن الخدمة. أعد حساب التوصيل.',
  );
  const report = await reconcileInventory(tx, row.merchant_id, row.origin_id);
  for (const item of checkout.items) {
    assert(
      report.rows.some((stock) => stock.productId === item.productId && stock.matched),
      409,
      'INVENTORY_INCONSISTENT',
      'رصيد موقع التنفيذ يحتاج مراجعة. أعد حساب التوصيل لاختيار موقع متاح.',
    );
    const updated = await tx.query(
      'UPDATE inventory_stock SET reserved=reserved+$4,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3 AND on_hand-reserved-quarantine >= $4 RETURNING product_id',
      [row.merchant_id, row.origin_id, item.productId, item.quantity],
    );
    assert(
      updated.rows.length,
      409,
      'OUT_OF_STOCK',
      `الكمية المطلوبة من ${catalog.find((p) => p.id === item.productId)?.name ?? item.productId} لم تعد متاحة. عدّل السلة ثم أعد حساب التوصيل.`,
    );
    await tx.query(
      "INSERT INTO inventory_reservations(shipment_id,merchant_id,site_id,product_id,quantity,state,expires_at) VALUES($1,$2,$3,$4,$5,'reserved',$6)",
      [
        row.id,
        row.merchant_id,
        row.origin_id,
        item.productId,
        item.quantity,
        new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      ],
    );
    await movement(
      tx,
      {
        merchant_id: row.merchant_id,
        site_id: row.origin_id,
        product_id: item.productId,
        quantity: item.quantity,
        state: 'reserved',
      },
      row.id,
      'reserve',
      'تأكيد الطلب',
      'حجز مؤكد لمدة 24 ساعة حتى بدء التجهيز',
    );
  }
  await tx.query('UPDATE storefront_checkouts SET shipment_id=$2 WHERE id=$1', [
    checkout.id,
    row.id,
  ]);
}
export async function inventoryTransition(
  tx: Transaction,
  row: ShipmentRow,
  action: string,
  actor: string,
  now = Date.now(),
) {
  const lines = (
    await tx.query<Line & { expires_at: string | null }>(
      'SELECT * FROM inventory_reservations WHERE shipment_id=$1 ORDER BY product_id',
      [row.id],
    )
  ).rows;
  for (const line of lines) {
    let state: string | undefined;
    let onHand = 0,
      reserved = 0,
      quarantine = 0;
    if (action === 'prepare') {
      assert(line.state === 'reserved', 409, 'INVENTORY_STATE', 'حجز المخزون غير جاهز للتجهيز');
      assert(
        line.expires_at && new Date(line.expires_at).getTime() > now,
        409,
        'RESERVATION_EXPIRED',
        'انتهت مهلة حجز المخزون؛ لا يمكن تجهيز هذا الطلب',
      );
      state = 'prepared';
    }
    if (action === 'handover_origin') {
      assert(
        line.state === 'prepared',
        409,
        'INVENTORY_STATE',
        'يلزم تجهيز الكميات المحجوزة قبل تسليمها',
      );
      state = 'dispatched';
      onHand = -line.quantity;
      reserved = -line.quantity;
    }
    if (action === 'cancel' || action === 'reservation_expired') {
      assert(
        ['reserved', 'prepared'].includes(line.state),
        409,
        'INVENTORY_STATE',
        'لا يمكن تحرير مخزون غادر المنشأ',
      );
      state = 'released';
      reserved = -line.quantity;
    }
    if (action === 'deliver' || action === 'release_pickup') {
      assert(line.state === 'dispatched', 409, 'INVENTORY_STATE', 'لم تسجل مغادرة مخزون الطلب');
      state = 'fulfilled';
    }
    if (action === 'receive_return' || action === 'commercial_receive') {
      assert(
        line.state === (action === 'commercial_receive' ? 'fulfilled' : 'dispatched'),
        409,
        'INVENTORY_STATE',
        'لم يسجل خروج مخزون المرتجع',
      );
      state = 'quarantined';
      onHand = line.quantity;
      quarantine = line.quantity;
    }
    if (!state) continue;
    await tx.query(
      'UPDATE inventory_stock SET on_hand=on_hand+$4,reserved=reserved+$5,quarantine=quarantine+$6,version=version+1 WHERE merchant_id=$1 AND site_id=$2 AND product_id=$3',
      [line.merchant_id, line.site_id, line.product_id, onHand, reserved, quarantine],
    );
    await tx.query(
      'UPDATE inventory_reservations SET state=$3,expires_at=NULL WHERE shipment_id=$1 AND product_id=$2',
      [row.id, line.product_id, state],
    );
    await movement(
      tx,
      line,
      row.id,
      action === 'commercial_receive' ? 'receive_return' : action,
      actor,
      action === 'receive_return' || action === 'commercial_receive'
        ? 'مرتجع معزول بانتظار فحص الصلاحية؛ غير متاح للبيع'
        : 'حركة مرتبطة بدورة تنفيذ الطلب',
    );
  }
  return lines.length > 0;
}
