import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { needsProof, verifyProof } from './delivery-proof.js';
import { reserveCheckout, inventoryTransition } from './inventory.js';
import { collection, collectCash } from './cash-ledger.js';
import type { CashConfirmation } from '../shared/cash.js';
import type { PGlite } from '@electric-sql/pglite';
import type {
  Account,
  Action,
  Shipment,
  ShipmentInput,
  ShipmentStatus,
} from '../shared/contracts.js';
import type { ShipmentRow, Transaction } from './db.js';

export class DomainError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(status, code, message);
}
export function mayRead(account: Account, row: ShipmentRow) {
  return (
    account.role === 'operator' ||
    (account.role === 'merchant' && account.merchantId === row.merchant_id) ||
    (account.role === 'courier' && account.courierId === row.courier_id) ||
    (account.role === 'pickup' && account.pickupSiteId === row.pickup_site_id)
  );
}
export async function loadShipment(tx: Transaction, id: string) {
  const result = await tx.query<ShipmentRow>('SELECT * FROM shipments WHERE id=$1', [id]);
  assert(result.rows[0], 404, 'NOT_FOUND', 'الشحنة غير موجودة');
  return result.rows[0];
}
export async function mapShipment(tx: Transaction, row: ShipmentRow): Promise<Shipment> {
  const names = await tx.query<{ merchant: string; origin: string; courier: string | null }>(
    `SELECT m.name merchant,s.name origin,c.name courier FROM merchants m JOIN sites s ON s.id=$2
     LEFT JOIN couriers c ON c.id=$3 WHERE m.id=$1`,
    [row.merchant_id, row.origin_id, row.courier_id],
  );
  const n = names.rows[0];
  return {
    originHandoverRequired: row.origin_handover_required,
    collection: await collection(tx, row.id),
    originPrepared: row.origin_prepared,
    originReleased: row.origin_released,
    originReceived: row.origin_received,
    pickupDueAt: row.pickup_due_at,
    pickupOverdue: row.pickup_overdue,
    id: row.id,
    reference: row.reference,
    externalReference: row.external_reference,
    merchantId: row.merchant_id,
    merchantName: n.merchant,
    recipientName: row.recipient_name,
    destination: row.destination,
    originId: row.origin_id,
    originName: n.origin,
    weightKg: row.weight_kg,
    status: row.status,
    courierId: row.courier_id,
    courierName: n.courier,
    pickupSiteId: row.pickup_site_id,
    pickupSiteName: row.pickup_site_id
      ? (
          await tx.query<{ name: string }>('SELECT name FROM sites WHERE id=$1', [
            row.pickup_site_id,
          ])
        ).rows[0].name
      : null,
    custodySiteId: row.custody_site_id,
    pickupExpiresAt: row.pickup_expires_at,
    assignmentAccepted: row.assignment_accepted,
    deliveryProofRequired: await needsProof(tx, row),
    assignmentExpiresAt: row.assignment_expires_at,
    feeMinor: row.fee_minor,
    currency: row.currency,
    version: row.version,
    trackingToken: row.tracking_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function appendEvent(
  tx: Transaction,
  row: ShipmentRow,
  type: string,
  description: string,
  actor: string,
) {
  const now = new Date().toISOString();
  await tx.query('INSERT INTO timeline VALUES($1,$2,$3,$4,$5,$6)', [
    randomUUID(),
    row.id,
    type,
    description,
    actor,
    now,
  ]);
  const id = randomUUID();
  const payload = {
    id,
    type,
    shipmentId: row.id,
    version: row.version,
    status: row.status,
    occurredAt: now,
  };
  await tx.query(
    'INSERT INTO outbox(id,shipment_id,type,payload,created_at) VALUES($1,$2,$3,$4,$5)',
    [id, row.id, type, JSON.stringify(payload), now],
  );
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function idempotent<T>(
  tx: Transaction,
  scope: string,
  key: string,
  body: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const fingerprint = createHash('sha256').update(canonical(body)).digest('hex');
  const existing = await tx.query<{ fingerprint: string; response: T }>(
    'SELECT fingerprint,response FROM idempotency WHERE scope=$1 AND key=$2',
    [scope, key],
  );
  if (existing.rows[0]) {
    assert(
      existing.rows[0].fingerprint === fingerprint,
      409,
      'IDEMPOTENCY_CONFLICT',
      'استُخدم مرجع العملية بمحتوى مختلف',
    );
    return existing.rows[0].response;
  }
  const result = await execute();
  await tx.query('INSERT INTO idempotency(scope,key,fingerprint,response) VALUES($1,$2,$3,$4)', [
    scope,
    key,
    fingerprint,
    JSON.stringify(result),
  ]);
  return result;
}

export async function createQuote(
  tx: Transaction,
  applicationId: string,
  merchantId: string,
  input: ShipmentInput,
) {
  const sites = await tx.query<{ merchant_id: string; city: string }>(
    'SELECT merchant_id,city FROM sites WHERE id=$1',
    [input.originId],
  );
  assert(
    sites.rows[0]?.merchant_id === merchantId,
    422,
    'INVALID_ORIGIN',
    'موقع المنشأ غير متاح لهذا المتجر',
  );
  assert(
    input.destination.includes('دمشق'),
    422,
    'OUTSIDE_COVERAGE',
    'الخدمة التجريبية الحالية تغطي مدينة دمشق فقط',
  );
  if (input.pickupSiteId) {
    const point = await tx.query<{
      kind: string;
      city: string;
      address: string;
      pickup_enabled: boolean;
      version: number;
    }>('SELECT kind,city,address,pickup_enabled,version FROM sites WHERE id=$1', [
      input.pickupSiteId,
    ]);
    assert(
      point.rows[0]?.kind === 'pickup' &&
        point.rows[0].pickup_enabled &&
        point.rows[0].city === sites.rows[0].city,
      422,
      'INVALID_PICKUP_SITE',
      'نقطة الاستلام غير متاحة ضمن نطاق الخدمة',
    );
    input = {
      ...input,
      destination: point.rows[0].address,
      pickupSiteVersion: point.rows[0].version,
    };
    await checkPickupCapacity(tx, input.pickupSiteId!, input.weightKg);
  }
  const feeMinor = 3_500_000 + Math.ceil(Math.max(input.weightKg - 2, 0)) * 500_000;
  if (input.collection)
    assert(
      input.collection.currency === 'SYP' &&
        Number.isSafeInteger(input.collection.goodsMinor) &&
        input.collection.goodsMinor > 0 &&
        input.collection.goodsMinor + feeMinor <= 1000000000000,
      422,
      'INVALID_COLLECTION',
      'مبلغ التحصيل أو عملته خارج حدود الخدمة',
    );
  const quote = {
    id: randomUUID(),
    feeMinor,
    currency: 'SYP',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    estimateLabel: 'خلال يوم العمل — تقدير تجريبي',
  };
  await tx.query('INSERT INTO quotes VALUES($1,$2,$3,$4,$5,$6,$7,false)', [
    quote.id,
    applicationId,
    merchantId,
    JSON.stringify(input),
    feeMinor,
    'SYP',
    quote.expiresAt,
  ]);
  return quote;
}

export async function createShipment(
  tx: Transaction,
  applicationId: string,
  merchantId: string,
  quoteId: string,
  key: string,
) {
  return idempotent(tx, `${applicationId}:${merchantId}:create`, key, { quoteId }, async () => {
    const quotes = await tx.query<{
      input: ShipmentInput;
      fee_minor: number;
      currency: string;
      expires_at: string;
      consumed: boolean;
    }>('SELECT * FROM quotes WHERE id=$1 AND application_id=$2 AND merchant_id=$3', [
      quoteId,
      applicationId,
      merchantId,
    ]);
    const q = quotes.rows[0];
    assert(q, 404, 'QUOTE_NOT_FOUND', 'عرض الخدمة غير موجود');
    assert(
      !q.consumed && new Date(q.expires_at).getTime() > Date.now(),
      409,
      'QUOTE_EXPIRED',
      'انتهت صلاحية عرض الخدمة أو استُخدم مسبقًا',
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    if (q.input.pickupSiteId)
      await checkPickupCapacity(
        tx,
        q.input.pickupSiteId,
        q.input.weightKg,
        q.input.pickupSiteVersion ?? 0,
      );
    const reference = 'SHP-' + randomBytes(4).toString('hex').toUpperCase();
    const old = await tx.query(
      'SELECT id FROM shipments WHERE application_id=$1 AND merchant_id=$2 AND external_reference=$3',
      [applicationId, merchantId, q.input.externalReference],
    );
    assert(
      !old.rows.length,
      409,
      'EXTERNAL_REFERENCE_EXISTS',
      'يوجد طلب تنفيذ مرتبط بمرجع البيع نفسه',
    );
    await tx.query(
      `INSERT INTO shipments(id,reference,application_id,external_reference,merchant_id,recipient_name,destination,origin_id,
      weight_kg,status,fee_minor,currency,tracking_token,created_at,updated_at,origin_handover_required)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12,$13,$13,true)`,
      [
        id,
        reference,
        applicationId,
        q.input.externalReference,
        merchantId,
        q.input.recipientName,
        q.input.destination,
        q.input.originId,
        q.input.weightKg,
        q.fee_minor,
        q.currency,
        randomBytes(24).toString('base64url'),
        now,
      ],
    );
    if (q.input.pickupSiteId)
      await tx.query('UPDATE shipments SET pickup_site_id=$2 WHERE id=$1', [
        id,
        q.input.pickupSiteId,
      ]);
    if (q.input.collection)
      await tx.query(
        'INSERT INTO cash_obligations(shipment_id,goods_minor,fee_minor,total_minor,currency) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          q.input.collection.goodsMinor,
          q.fee_minor,
          q.input.collection.goodsMinor + q.fee_minor,
          q.input.collection.currency,
        ],
      );
    await tx.query('UPDATE quotes SET consumed=true WHERE id=$1', [quoteId]);
    const row = await loadShipment(tx, id);
    await reserveCheckout(tx, row, quoteId);
    await appendEvent(
      tx,
      row,
      'shipment.created',
      'استُقبل طلب التنفيذ وأصبحت الشحنة جاهزة للإسناد',
      'التطبيق التجاري التجريبي',
    );
    return mapShipment(tx, row);
  });
}

async function checkPickupCapacity(
  tx: Transaction,
  id: string,
  weight: number,
  expectedVersion?: number,
) {
  const site = (
    await tx.query<{ pickup_enabled: boolean; pickup_capacity_kg: number; version: number }>(
      "SELECT pickup_enabled,pickup_capacity_kg,version FROM sites WHERE id=$1 AND kind='pickup'",
      [id],
    )
  ).rows[0];
  assert(site?.pickup_enabled, 422, 'INVALID_PICKUP_SITE', 'نقطة الاستلام غير متاحة');
  assert(
    expectedVersion === undefined || expectedVersion === site.version,
    409,
    'QUOTE_SITE_CHANGED',
    'تغيرت إعدادات نقطة الاستلام؛ احسب عرض الخدمة مجددًا قبل التأكيد',
  );
  const used = (
    await tx.query<{ kg: number }>(
      "SELECT COALESCE(SUM(weight_kg),0)::real kg FROM shipments WHERE pickup_site_id=$1 AND status NOT IN ('delivered','returned','cancelled') AND NOT(status='returning' AND custody_site_id IS NULL)",
      [id],
    )
  ).rows[0].kg;
  assert(
    used + weight <= site.pickup_capacity_kg,
    409,
    'PICKUP_CAPACITY_EXCEEDED',
    'سعة نقطة الاستلام محجوزة؛ اختر التوصيل إلى العنوان أو حاول لاحقًا',
  );
}
const activeStatuses = [
  'awaiting_handover',
  'assigned',
  'picked_up',
  'in_transit',
  'failed',
  'returning',
];
export async function courierCapacity(tx: Transaction, courierId: string) {
  const r = await tx.query<{ active_kg: number }>(
    `SELECT (COALESCE((SELECT SUM(weight_kg) FROM shipments WHERE courier_id=$1 AND status=ANY($2)),0)+COALESCE((SELECT SUM(weight_kg) FROM inventory_transfers WHERE courier_id=$1 AND status IN ('assigned','accepted','released','in_transit')),0)+COALESCE((SELECT SUM(s.weight_kg) FROM commercial_returns r JOIN shipments s ON s.id=r.shipment_id WHERE r.courier_id=$1 AND r.status IN ('assigned','accepted','released','in_transit')),0))::real active_kg`,
    [courierId, activeStatuses],
  );
  return r.rows[0].active_kg;
}
export async function applyAction(
  tx: Transaction,
  account: Account,
  id: string,
  action: Action,
  expectedVersion: number,
  courierId?: string,
  reason?: string,
  now = Date.now(),
  deliveryCode?: string,
  proofSecret?: string,
  cash?: CashConfirmation,
) {
  const row = await loadShipment(tx, id);
  assert(
    !cash || ['deliver', 'release_pickup'].includes(action),
    422,
    'INVALID_CASH_ACTION',
    'تأكيد التحصيل يكون مع تسليم الطرد للعميل فقط',
  );
  assert(mayRead(account, row), 404, 'NOT_FOUND', 'الشحنة غير موجودة');
  assert(
    row.version === expectedVersion,
    409,
    'VERSION_CONFLICT',
    'تغيرت الشحنة. حدّث البيانات ثم أعد المحاولة',
  );
  const operations = ['assign_return', 'assign', 'unassign', 'return', 'receive_return'];
  if (['prepare', 'handover_origin'].includes(action))
    assert(
      account.role === 'merchant' && account.merchantId === row.merchant_id,
      403,
      'FORBIDDEN',
      'هذا التأكيد متاح للمتجر صاحب الطرد فقط',
    );
  if (operations.includes(action))
    assert(account.role === 'operator', 403, 'FORBIDDEN', 'هذا الإجراء متاح لإدارة العمليات فقط');
  if (
    ['arrive_pickup', 'accept', 'decline', 'pickup', 'depart', 'deliver', 'fail'].includes(action)
  )
    assert(
      account.role === 'courier' && row.courier_id === account.courierId,
      403,
      'FORBIDDEN',
      'الإجراء متاح للمندوب المكلف فقط',
    );
  if (['receive_pickup', 'release_pickup', 'handover_return'].includes(action))
    assert(
      account.role === 'pickup' && account.pickupSiteId === row.pickup_site_id,
      403,
      'FORBIDDEN',
      'الإجراء متاح لموظف نقطة الاستلام المعنية فقط',
    );
  if (action === 'cancel')
    assert(
      account.role === 'operator' || account.role === 'merchant',
      403,
      'FORBIDDEN',
      'ليس لديك صلاحية إلغاء الطلب',
    );
  let next: ShipmentStatus = row.status;
  let accepted = row.assignment_accepted;
  let selected = row.courier_id;
  let description = '';
  let expiresAt = row.assignment_expires_at;
  let custodySiteId = row.custody_site_id;
  let pickupExpiresAt = row.pickup_expires_at;
  let prepared = row.origin_prepared;
  let released = row.origin_released;
  let received = row.origin_received;
  let pickupDueAt = row.pickup_due_at;
  let overdue = row.pickup_overdue;
  switch (action) {
    case 'prepare':
      assert(
        row.origin_handover_required &&
          ['ready', 'assigned'].includes(row.status) &&
          !prepared &&
          !released,
        409,
        'INVALID_TRANSITION',
        'التجهيز غير متاح في هذه الحالة',
      );
      prepared = true;
      description = 'أكد المتجر تجهيز الطرد وإغلاقه للاستلام؛ هذا إقرار تجهيز دون إدارة مخزون';
      break;
    case 'handover_origin':
      assert(
        row.origin_handover_required &&
          row.status === 'assigned' &&
          accepted &&
          prepared &&
          !released,
        409,
        'INVALID_TRANSITION',
        'يلزم تجهيز الطرد وقبول المندوب قبل تسليمه',
      );
      assert(
        courierId && courierId === selected,
        409,
        'COURIER_MISMATCH',
        'تحقق من هوية المندوب المكلف قبل تسليم الطرد',
      );
      released = true;
      description = 'أكد المتجر تسليم الطرد فعليًا للمندوب المكلف؛ بانتظار تأكيد استلام المندوب';
      break;
    case 'arrive_pickup':
      assert(
        row.status === 'in_transit' && row.pickup_site_id,
        409,
        'INVALID_TRANSITION',
        'هذه الشحنة غير متاحة للتسليم إلى نقطة الاستلام',
      );
      next = 'awaiting_handover';
      description = 'وصل المندوب إلى نقطة الاستلام؛ العهدة تبقى معه حتى تأكيد موظف النقطة';
      break;
    case 'receive_pickup':
      assert(
        row.status === 'awaiting_handover' && row.courier_id,
        409,
        'INVALID_TRANSITION',
        'يجب تأكيد وصول المندوب قبل استلام عهدة الطرد',
      );
      next = 'ready_for_pickup';
      custodySiteId = row.pickup_site_id;
      selected = null;
      accepted = false;
      pickupExpiresAt = new Date(now + 72 * 60 * 60_000).toISOString();
      description =
        'أكد موظف النقطة استلام الطرد؛ انتقلت العهدة إلى النقطة وبدأت مهلة استلام العميل لمدة 72 ساعة';
      break;
    case 'release_pickup': {
      assert(
        row.status === 'ready_for_pickup' &&
          custodySiteId === row.pickup_site_id &&
          pickupExpiresAt &&
          new Date(pickupExpiresAt).getTime() > now,
        409,
        'PICKUP_NOT_AVAILABLE',
        'انتهت مهلة الاستلام أو الطرد غير جاهز',
      );
      assert(
        await needsProof(tx, row),
        409,
        'CUSTOMER_PROOF_REQUIRED',
        'يلزم ربط الشحنة بجلسة العميل قبل التسليم',
      );
      assert(proofSecret, 500, 'PROOF_CONFIGURATION', 'تعذر التحقق من رمز الاستلام');
      const failure = await verifyProof(tx, id, deliveryCode, now, proofSecret);
      if (failure) throw failure;
      await tx.query('UPDATE delivery_proofs SET consumed_at=$2 WHERE shipment_id=$1', [
        id,
        new Date(now).toISOString(),
      ]);
      next = 'delivered';
      custodySiteId = null;
      description = 'سلّم موظف النقطة الطرد للعميل بعد التحقق من رمز الاستلام';
      break;
    }
    case 'handover_return':
      assert(
        row.status === 'returning' && accepted && selected && custodySiteId === row.pickup_site_id,
        409,
        'INVALID_TRANSITION',
        'يجب قبول مندوب الإرجاع للمهمة قبل تسليم الطرد',
      );
      custodySiteId = null;
      description = 'أكد موظف النقطة تسليم الطرد إلى مندوب الإرجاع وانتقلت إليه العهدة';
      break;
    case 'assign_return':
    case 'assign': {
      assert(
        action === 'assign'
          ? row.status === 'ready'
          : row.status === 'pickup_expired' && custodySiteId === row.pickup_site_id,
        409,
        'INVALID_TRANSITION',
        'لا يمكن إسناد الشحنة في حالتها الحالية',
      );
      const c = await tx.query<{ available: boolean; capacity_kg: number; name: string }>(
        'SELECT * FROM couriers WHERE id=$1',
        [courierId],
      );
      assert(c.rows[0]?.available, 422, 'COURIER_UNAVAILABLE', 'المندوب غير متاح');
      const used = await courierCapacity(tx, courierId!);
      assert(
        used + row.weight_kg <= c.rows[0].capacity_kg,
        409,
        'CAPACITY_EXCEEDED',
        'سعة المركبة المتاحة لا تكفي لهذه الشحنة',
      );
      next = action === 'assign_return' ? 'returning' : 'assigned';
      selected = courierId!;
      accepted = false;
      expiresAt = new Date(now + 5 * 60_000).toISOString();
      description = `أُسندت الشحنة إلى ${c.rows[0].name}؛ بانتظار قبول المهمة`;
      break;
    }
    case 'accept':
      assert(
        !expiresAt || new Date(expiresAt).getTime() > now,
        409,
        'ASSIGNMENT_EXPIRED',
        'انتهت مهلة قبول المهمة؛ حدّث البيانات',
      );
      assert(
        (row.status === 'assigned' || (row.status === 'returning' && !!custodySiteId)) && !accepted,
        409,
        'INVALID_TRANSITION',
        'المهمة غير متاحة للقبول',
      );
      accepted = true;
      expiresAt = null;
      if (row.status === 'assigned' && row.origin_handover_required) {
        pickupDueAt = new Date(now + 30 * 60_000).toISOString();
        overdue = false;
      }
      description = 'قبل المندوب المهمة';
      break;
    case 'decline':
    case 'unassign':
      assert(
        row.status !== 'assigned' || !released,
        409,
        'HANDOVER_PENDING',
        'سجل المتجر تسليم الطرد؛ يلزم تأكيد استلام المندوب ولا يمكن إعادة الإسناد أو تحرير السعة',
      );
      assert(
        (row.status === 'assigned' || (row.status === 'returning' && !!custodySiteId)) &&
          (action === 'unassign' || !accepted),
        409,
        'INVALID_TRANSITION',
        'لا يمكن تحرير هذا الإسناد بعد انتقال العهدة أو رفض مهمة مقبولة',
      );
      assert(reason && reason.trim().length >= 3, 422, 'REASON_REQUIRED', 'حدد سبب تحرير الإسناد');
      next = custodySiteId ? 'pickup_expired' : 'ready';
      selected = null;
      accepted = false;
      expiresAt = null;
      pickupDueAt = null;
      overdue = false;
      description =
        action === 'decline'
          ? `رفض المندوب المهمة: ${reason}`
          : `حررت العمليات الإسناد قبل الاستلام: ${reason}`;
      break;
    case 'pickup':
      assert(
        row.status === 'assigned' && accepted,
        409,
        'INVALID_TRANSITION',
        'يجب قبول المهمة قبل استلام الطرد',
      );
      next = 'picked_up';
      assert(
        !row.origin_handover_required || (prepared && released),
        409,
        'ORIGIN_CONFIRMATION_REQUIRED',
        'يلزم تجهيز الطرد وتأكيد المتجر تسليمه للمندوب المكلف قبل تسجيل الاستلام',
      );
      received = true;
      pickupDueAt = null;
      overdue = false;
      description = 'أكد المندوب استلام الطرد من المنشأ وانتقلت إليه العهدة';
      break;
    case 'depart':
      assert(
        row.status === 'picked_up' &&
          (!row.origin_handover_required || (prepared && released && received)),
        409,
        'INVALID_TRANSITION',
        'يجب استلام الطرد قبل بدء التوصيل',
      );
      next = 'in_transit';
      description = 'بدأ المندوب مرحلة التوصيل';
      break;
    case 'deliver':
      assert(
        row.status === 'in_transit' && !row.pickup_site_id,
        409,
        'INVALID_TRANSITION',
        'التسليم متاح من مرحلة التوصيل فقط',
      );
      next = 'delivered';
      if (await needsProof(tx, row)) {
        assert(proofSecret, 500, 'PROOF_CONFIGURATION', 'تعذر التحقق من رمز الاستلام');
        const failure = await verifyProof(tx, id, deliveryCode, now, proofSecret);
        if (failure) throw failure;
        await tx.query('UPDATE delivery_proofs SET consumed_at=$2 WHERE shipment_id=$1', [
          id,
          new Date(now).toISOString(),
        ]);
      }
      description = (await needsProof(tx, row))
        ? 'تم التسليم بعد التحقق من رمز الاستلام الصادر لجلسة العميل'
        : 'أكد المندوب تسليم الطرد — إقرار محلي تجريبي لشحنة لا ترتبط بجلسة عميل';
      break;
    case 'fail':
      assert(
        row.status === 'in_transit',
        409,
        'INVALID_TRANSITION',
        'لا يمكن تسجيل تعذر التسليم في هذه الحالة',
      );
      assert(
        reason && reason.trim().length >= 3,
        422,
        'REASON_REQUIRED',
        'يرجى تحديد سبب تعذر التسليم',
      );
      next = 'failed';
      description = `تعذر التسليم: ${reason}`;
      break;
    case 'cancel':
      assert(
        !released,
        409,
        'RETURN_REQUIRED',
        'أكد المتجر تسليم الطرد للمندوب؛ يلزم استكمال تأكيد العهدة ثم الإرجاع بدل الإلغاء',
      );
      assert(
        ['ready', 'assigned'].includes(row.status),
        409,
        'RETURN_REQUIRED',
        'انتقل الطرد إلى النقل؛ يلزم مسار إرجاع بدل الإلغاء',
      );
      next = 'cancelled';
      expiresAt = null;
      pickupDueAt = null;
      overdue = false;
      description = 'أُلغي الطلب قبل انتقال عهدة الطرد';
      break;
    case 'return':
      assert(
        ['picked_up', 'in_transit', 'failed'].includes(row.status),
        409,
        'INVALID_TRANSITION',
        'الإرجاع غير متاح لهذه الحالة',
      );
      assert(reason && reason.trim().length >= 3, 422, 'REASON_REQUIRED', 'يرجى تحديد سبب الإرجاع');
      next = 'returning';
      description = `فُتح مسار الإرجاع: ${reason}`;
      break;
    case 'receive_return':
      assert(
        row.status === 'returning' && !custodySiteId && accepted,
        409,
        'INVALID_TRANSITION',
        'لا توجد عملية إرجاع جارية',
      );
      next = 'returned';
      description =
        'أكدت العمليات استلام الطرد المعاد في المنشأ؛ لا يوجد مخزون للبيع في هذه الخدمة';
      break;
  }
  if (['deliver', 'release_pickup'].includes(action))
    await collectCash(tx, row, account, cash, now);
  const hasInventory = await inventoryTransition(tx, row, action, account.name, now);
  if (hasInventory && action === 'prepare')
    description = 'أكد المتجر تجهيز كميات الطلب المحجوزة وإغلاق الطرد؛ توقف انتهاء الحجز';
  if (hasInventory && action === 'receive_return')
    description = 'استُلم المرتجع في المنشأ وأضيف إلى المخزون المعزول؛ غير متاح للبيع قبل الفحص';
  await tx.query(
    'UPDATE shipments SET status=$1,courier_id=$2,assignment_accepted=$3,version=version+1,updated_at=$4,assignment_expires_at=$6,custody_site_id=$7,pickup_expires_at=$8,origin_prepared=$9,origin_released=$10,origin_received=$11,pickup_due_at=$12,pickup_overdue=$13 WHERE id=$5',
    [
      next,
      selected,
      accepted,
      new Date(now).toISOString(),
      id,
      expiresAt,
      custodySiteId,
      pickupExpiresAt,
      prepared,
      released,
      received,
      pickupDueAt,
      overdue,
    ],
  );
  if (next !== row.status || selected !== row.courier_id) {
    const { revokeSharing } = await import('./location-storage.js');
    await revokeSharing(tx, id, account.id, 'تغير حالة الشحنة أو تكليف المندوب');
  }
  const updated = await loadShipment(tx, id);
  await appendEvent(tx, updated, `shipment.${action}`, description, account.name);
  return mapShipment(tx, updated);
}

export async function expireAssignments(tx: Transaction, now: number) {
  const reservations = await tx.query<ShipmentRow>(
    "SELECT s.* FROM shipments s WHERE s.status IN ('ready','assigned') AND NOT s.origin_prepared AND EXISTS(SELECT 1 FROM inventory_reservations r WHERE r.shipment_id=s.id AND r.state='reserved' AND r.expires_at<=$1) ORDER BY s.created_at,s.id LIMIT 100",
    [new Date(now).toISOString()],
  );
  for (const row of reservations.rows) {
    await inventoryTransition(tx, row, 'reservation_expired', 'عامل متابعة الحجز');
    await tx.query(
      "UPDATE shipments SET status='cancelled',courier_id=NULL,assignment_accepted=false,assignment_expires_at=NULL,pickup_due_at=NULL,pickup_overdue=false,version=version+1,updated_at=$2 WHERE id=$1",
      [row.id, new Date(now).toISOString()],
    );
    await appendEvent(
      tx,
      await loadShipment(tx, row.id),
      'shipment.reservation_expired',
      'انتهى حجز 24 ساعة دون تجهيز؛ أُلغي الطلب وتحررت كمياته وسعة المندوب',
      'عامل متابعة الحجز',
    );
  }
  const expired = await tx.query<ShipmentRow>(
    "SELECT * FROM shipments WHERE (status='assigned' OR (status='returning' AND custody_site_id IS NOT NULL)) AND NOT assignment_accepted AND assignment_expires_at<=$1 ORDER BY assignment_expires_at LIMIT 100",
    [new Date(now).toISOString()],
  );
  for (const row of expired.rows) {
    await tx.query(
      "UPDATE shipments SET status=CASE WHEN custody_site_id IS NOT NULL THEN 'pickup_expired' ELSE 'ready' END,courier_id=NULL,assignment_accepted=false,assignment_expires_at=NULL,version=version+1,updated_at=$2 WHERE id=$1",
      [row.id, new Date(now).toISOString()],
    );
    await appendEvent(
      tx,
      await loadShipment(tx, row.id),
      'shipment.assignment_expired',
      row.custody_site_id
        ? 'انتهت مهلة قبول مندوب الإرجاع؛ تحررت سعته وبقي الطرد بعهدة النقطة بانتظار إعادة الإسناد'
        : 'انتهت مهلة قبول المندوب؛ تحررت السعة وأعيدت الشحنة للإسناد',
      'عامل متابعة الإسناد',
    );
  }
  const holds = await tx.query<ShipmentRow>(
    "SELECT * FROM shipments WHERE status='ready_for_pickup' AND pickup_expires_at<=$1 ORDER BY pickup_expires_at LIMIT 100",
    [new Date(now).toISOString()],
  );
  for (const row of holds.rows) {
    await tx.query(
      "UPDATE shipments SET status='pickup_expired',version=version+1,updated_at=$2 WHERE id=$1",
      [row.id, new Date(now).toISOString()],
    );
    await appendEvent(
      tx,
      await loadShipment(tx, row.id),
      'shipment.pickup_expired',
      'انتهت مهلة استلام العميل؛ الطرد محفوظ بعهدة النقطة بانتظار تنظيم الإرجاع',
      'عامل متابعة الاستلام',
    );
  }
  const late = await tx.query<ShipmentRow>(
    "SELECT * FROM shipments WHERE status='assigned' AND assignment_accepted AND NOT pickup_overdue AND pickup_due_at<=$1 ORDER BY pickup_due_at LIMIT 100",
    [new Date(now).toISOString()],
  );
  for (const row of late.rows) {
    await tx.query(
      'UPDATE shipments SET pickup_overdue=true,version=version+1,updated_at=$2 WHERE id=$1',
      [row.id, new Date(now).toISOString()],
    );
    await appendEvent(
      tx,
      await loadShipment(tx, row.id),
      'shipment.pickup_overdue',
      row.origin_released
        ? 'تأخر تأكيد استلام المندوب بعد إقرار المتجر بالتسليم؛ حجز السعة محفوظ ويلزم التحقق من العهدة'
        : 'تجاوزت المهمة المقبولة مهلة الاستلام من المنشأ؛ يلزم متابعة العمليات دون تحرير السعة تلقائيًا',
      'عامل متابعة الاستلام',
    );
  }
  return expired.rows.length + holds.rows.length + late.rows.length;
}

// PGlite serializes local transactions; this gate also keeps compound writes and workers ordered.
// A server PostgreSQL deployment requires row locks/conditional updates, not this process-local gate.
export function transactionGate(db: PGlite) {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
    const result = tail.then(() => db.transaction(fn));
    tail = result.catch(() => undefined);
    return result;
  };
}
