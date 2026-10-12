import { randomUUID } from 'node:crypto';
import type { Transaction, ShipmentRow } from './db.js';
import type { Account } from '../shared/contracts.js';
import type { CashConfirmation, Collection } from '../shared/cash.js';
import { assert } from './domain.js';
export async function collection(tx: Transaction, id: string): Promise<Collection | null> {
  return (
    (
      await tx.query<Collection>(
        'SELECT goods_minor::double precision AS "goodsMinor",fee_minor::double precision AS "feeMinor",total_minor::double precision AS "totalMinor",currency,status,version,issue_open AS "issueOpen" FROM cash_obligations WHERE shipment_id=$1',
        [id],
      )
    ).rows[0] ?? null
  );
}
export async function cashEvent(
  tx: Transaction,
  id: string,
  a: Account,
  action: string,
  reference: string,
  reason: string,
  details: unknown = {},
) {
  await tx.query(
    'INSERT INTO cash_events(id,shipment_id,action,actor_id,actor_name,reference,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), id, action, a.id, a.name, reference, reason, JSON.stringify(details)],
  );
}
export async function journal(
  tx: Transaction,
  id: string,
  kind:
    | 'collection'
    | 'remittance'
    | 'payout_release'
    | 'payout_receive'
    | 'payout_return'
    | 'payout_receive_reverse'
    | 'remittance_return_release'
    | 'remittance_reverse'
    | 'remittance_return_restore'
    | 'refund_release'
    | 'refund_confirm',
  currency: string,
  amount: number,
  entries: { account: string; amount: number }[],
  payoutId: string | null = null,
  reversesJournalId: string | null = null,
  returnId: string | null = null,
  remittanceRound: number | null = null,
  refundId: string | null = null,
) {
  assert(
    entries.every((e) => Number.isSafeInteger(e.amount) && e.amount !== 0) &&
      entries.reduce((s, e) => s + e.amount, 0) === 0,
    500,
    'UNBALANCED_JOURNAL',
    'تعذر تسجيل قيد مالي متوازن',
  );
  const journalId = randomUUID();
  await tx.query(
    'INSERT INTO cash_journals(id,shipment_id,kind,currency,amount_minor,payout_id,reverses_journal_id,remittance_return_id,remittance_round,refund_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      journalId,
      id,
      kind,
      currency,
      amount,
      payoutId,
      reversesJournalId,
      returnId,
      remittanceRound,
      refundId,
    ],
  );
  for (const e of entries)
    await tx.query(
      'INSERT INTO cash_postings(journal_id,account_code,amount_minor) VALUES($1,$2,$3)',
      [journalId, e.account, e.amount],
    );
  await tx.query('UPDATE cash_journals SET sealed=true WHERE id=$1', [journalId]);
}
export async function validateCash(tx: Transaction, id: string) {
  const row = (
    await tx.query<{
      status: string;
      remittance_count: number;
      total_minor: number;
      goods_minor: number;
      fee_minor: number;
      collector_id: string | null;
      merchant_id: string;
      currency: string;
    }>(
      'SELECT o.status,o.remittance_count,o.total_minor::double precision,o.goods_minor::double precision,o.fee_minor::double precision,o.collector_id,s.merchant_id,o.currency FROM cash_obligations o JOIN shipments s ON s.id=o.shipment_id WHERE o.shipment_id=$1',
      [id],
    )
  ).rows[0];
  assert(row, 404, 'NOT_FOUND', 'التحصيل غير موجود');
  const posts = (
    await tx.query<{
      kind: string;
      amount: number;
      account_code: string;
      posting: number;
      payoutId: string | null;
      refundId: string | null;
      journalId: string;
      reverses: string | null;
      returnId: string | null;
      remittanceRound: number | null;
      sealed: boolean;
      currency: string;
    }>(
      `SELECT j.id AS "journalId",j.reverses_journal_id AS reverses,j.remittance_return_id AS "returnId",j.remittance_round AS "remittanceRound",j.sealed,j.kind,j.currency,j.refund_id AS "refundId",j.payout_id AS "payoutId",j.amount_minor::double precision AS amount,p.account_code,p.amount_minor::double precision AS posting FROM cash_journals j JOIN cash_postings p ON p.journal_id=j.id WHERE j.shipment_id=$1 ORDER BY j.kind,p.account_code`,
      [id],
    )
  ).rows;
  const expected: { kind: string; account: string; amount: number }[] = [];
  if (row.status !== 'pending') {
    expected.push(
      { kind: 'collection', account: 'holder:' + row.collector_id, amount: row.total_minor },
      { kind: 'collection', account: 'merchant_payable', amount: -row.goods_minor },
      { kind: 'collection', account: 'delivery_clearing', amount: -row.fee_minor },
    );
  }
  const base = posts.filter(
    (p) => p.payoutId === null && p.returnId === null && p.kind === 'collection',
  );
  const nonzero = expected.filter((e) => e.amount !== 0);
  assert(
    base.length === nonzero.length &&
      nonzero.every((e) =>
        base.some(
          (p) =>
            p.account_code === e.account &&
            p.posting === e.amount &&
            p.amount === row.total_minor &&
            p.currency === row.currency &&
            p.sealed,
        ),
      ),
    409,
    'CASH_INCONSISTENT',
    'قيود التحصيل لا تطابق عهدة الأموال',
  );
  const returns = (
    await tx.query<{
      id: string;
      original_journal_id: string;
      collector_id: string;
      amount: number;
      currency: string;
      status: string;
    }>(
      'SELECT id,original_journal_id,collector_id,amount_minor::double precision AS amount,currency,status FROM cash_remittance_returns WHERE shipment_id=$1',
      [id],
    )
  ).rows;
  let expectedRemittancePosts = 0;
  const remittances = posts.filter((p) => p.kind === 'remittance');
  assert(
    remittances.length === row.remittance_count * 2 &&
      (row.status !== 'received' || row.remittance_count > 0) &&
      (row.status === 'pending' ? row.remittance_count === 0 : true),
    409,
    'CASH_INCONSISTENT',
    'عدد حوالات التحصيل لا يطابق سجلها',
  );
  for (let round = 1; round <= row.remittance_count; round++) {
    const r = remittances.filter((p) => p.remittanceRound === round);
    assert(
      r.length === 2 &&
        r.every(
          (p) =>
            p.payoutId === null &&
            p.returnId === null &&
            p.reverses === null &&
            p.sealed &&
            p.amount === row.total_minor &&
            p.currency === row.currency,
        ) &&
        r.some((p) => p.account_code === 'operations_cash' && p.posting === row.total_minor) &&
        r.some(
          (p) => p.account_code === 'holder:' + row.collector_id && p.posting === -row.total_minor,
        ),
      409,
      'CASH_INCONSISTENT',
      'قيد الحوالة لا يطابق الأصل',
    );
    const completed = returns.filter(
      (c) => c.original_journal_id === r[0].journalId && c.status === 'confirmed',
    );
    assert(
      completed.length === (round < row.remittance_count || row.status === 'collected' ? 1 : 0),
      409,
      'CASH_INCONSISTENT',
      'حالة التحصيل لا تطابق تصحيح الحوالة',
    );
  }
  expectedRemittancePosts += remittances.length;
  for (const c of returns) {
    const original = remittances.find((p) => p.journalId === c.original_journal_id);
    assert(
      original &&
        c.collector_id === row.collector_id &&
        c.amount === row.total_minor &&
        c.currency === row.currency &&
        (!['requested', 'released'].includes(c.status) ||
          (row.status === 'received' && original.remittanceRound === row.remittance_count)),
      409,
      'CASH_INCONSISTENT',
      'تصحيح الحوالة لا يطابق أصلها',
    );
    const ep: { kind: string; account: string; amount: number; reverses: string | null }[] = [];
    if (['released', 'confirmed'].includes(c.status))
      ep.push(
        {
          kind: 'remittance_return_release',
          account: 'remittance_return_transit',
          amount: c.amount,
          reverses: null,
        },
        {
          kind: 'remittance_return_release',
          account: 'operations_cash',
          amount: -c.amount,
          reverses: null,
        },
      );
    const cp = posts.filter((p) => p.returnId === c.id);
    if (c.status === 'confirmed') {
      const release = cp.find((p) => p.kind === 'remittance_return_release');
      ep.push(
        {
          kind: 'remittance_reverse',
          account: 'operations_cash',
          amount: -c.amount,
          reverses: c.original_journal_id,
        },
        {
          kind: 'remittance_reverse',
          account: 'holder:' + c.collector_id,
          amount: c.amount,
          reverses: c.original_journal_id,
        },
        {
          kind: 'remittance_return_restore',
          account: 'operations_cash',
          amount: c.amount,
          reverses: release?.journalId ?? null,
        },
        {
          kind: 'remittance_return_restore',
          account: 'remittance_return_transit',
          amount: -c.amount,
          reverses: release?.journalId ?? null,
        },
      );
    }
    assert(
      cp.length === ep.length &&
        ep.every((e) =>
          cp.some(
            (p) =>
              p.kind === e.kind &&
              p.account_code === e.account &&
              p.posting === e.amount &&
              p.reverses === e.reverses &&
              p.sealed &&
              p.payoutId === null &&
              p.amount === c.amount &&
              p.currency === c.currency,
          ),
        ),
      409,
      'CASH_INCONSISTENT',
      'عهدة رجوع الحوالة لا تطابق قيودها',
    );
    expectedRemittancePosts += ep.length;
  }
  const payouts = (
    await tx.query<{
      id: string;
      status: string;
      amount: number;
      merchant_id: string;
      currency: string;
    }>(
      'SELECT id,status,amount_minor::double precision AS amount,merchant_id,currency FROM cash_payouts WHERE shipment_id=$1',
      [id],
    )
  ).rows;
  let expectedPayoutPosts = 0;
  for (const p of payouts) {
    assert(
      p.merchant_id === row.merchant_id &&
        p.currency === row.currency &&
        p.amount === row.goods_minor &&
        (row.status === 'received' || ['cancelled', 'returned', 'recovered'].includes(p.status)),
      409,
      'CASH_INCONSISTENT',
      'طلب الصرف لا يطابق التحصيل أو ملكية المستحقات',
    );
    const expected: { kind: string; account: string; amount: number }[] = [];
    if (['released', 'received', 'returned', 'recovered'].includes(p.status))
      expected.push(
        { kind: 'payout_release', account: 'payout_in_transit', amount: p.amount },
        { kind: 'payout_release', account: 'operations_cash', amount: -p.amount },
      );
    if (['received', 'recovered'].includes(p.status))
      expected.push(
        { kind: 'payout_receive', account: 'merchant_payable', amount: p.amount },
        { kind: 'payout_receive', account: 'payout_in_transit', amount: -p.amount },
      );
    if (['returned', 'recovered'].includes(p.status))
      expected.push(
        { kind: 'payout_return', account: 'operations_cash', amount: p.amount },
        { kind: 'payout_return', account: 'payout_in_transit', amount: -p.amount },
      );
    if (p.status === 'recovered')
      expected.push(
        { kind: 'payout_receive_reverse', account: 'merchant_payable', amount: -p.amount },
        { kind: 'payout_receive_reverse', account: 'payout_in_transit', amount: p.amount },
      );
    const pp = posts.filter((post) => post.payoutId === p.id);
    assert(
      pp.every(
        (post) =>
          post.sealed &&
          (post.kind === 'payout_return'
            ? post.reverses === pp.find((source) => source.kind === 'payout_release')?.journalId
            : post.kind === 'payout_receive_reverse'
              ? post.reverses === pp.find((source) => source.kind === 'payout_receive')?.journalId
              : post.reverses === null),
      ),
      409,
      'CASH_INCONSISTENT',
      'القيد العكسي لا يطابق أصل الصرف المغلق',
    );
    expectedPayoutPosts += expected.length;
    assert(
      pp.length === expected.length &&
        expected.every((e) =>
          pp.some(
            (post) =>
              post.kind === e.kind &&
              post.account_code === e.account &&
              post.posting === e.amount &&
              post.amount === p.amount &&
              post.currency === p.currency,
          ),
        ),
      409,
      'CASH_INCONSISTENT',
      'قيود صرف المستحقات لا تطابق حالة الصرف',
    );
  }
  let expectedRefundPosts = 0;
  const refunds = (
    await tx.query<{ id: string; status: string; amount: number; currency: string }>(
      'SELECT id,status,amount_minor::double precision AS amount,currency FROM customer_refunds WHERE shipment_id=$1',
      [id],
    )
  ).rows;
  for (const refund of refunds) {
    assert(
      refund.amount === row.goods_minor && refund.currency === row.currency,
      409,
      'CASH_INCONSISTENT',
      'قيمة الرد لا تطابق البضائع المحصلة',
    );
    const ep: { kind: string; account: string; amount: number }[] = [];
    if (['released', 'confirmed'].includes(refund.status))
      ep.push(
        { kind: 'refund_release', account: 'customer_refund_transit', amount: refund.amount },
        { kind: 'refund_release', account: 'operations_cash', amount: -refund.amount },
      );
    if (refund.status === 'confirmed')
      ep.push(
        { kind: 'refund_confirm', account: 'merchant_payable', amount: refund.amount },
        { kind: 'refund_confirm', account: 'customer_refund_transit', amount: -refund.amount },
      );
    const actual = posts.filter((p) => p.refundId === refund.id);
    assert(
      actual.length === ep.length &&
        ep.every((e) =>
          actual.some(
            (p) =>
              p.kind === e.kind &&
              p.account_code === e.account &&
              p.posting === e.amount &&
              p.amount === refund.amount &&
              p.currency === refund.currency &&
              p.sealed &&
              p.reverses === null,
          ),
        ),
      409,
      'CASH_INCONSISTENT',
      'قيود رد العميل لا تطابق العهدة',
    );
    expectedRefundPosts += ep.length;
  }
  assert(
    posts.length ===
      nonzero.length + expectedRemittancePosts + expectedPayoutPosts + expectedRefundPosts,
    409,
    'CASH_INCONSISTENT',
    'يوجد قيد صرف غير مرتبط بمستحقاته',
  );
}
export async function collectCash(
  tx: Transaction,
  row: ShipmentRow,
  a: Account,
  cash: CashConfirmation | undefined,
  now: number,
) {
  const c = await collection(tx, row.id);
  if (!c) {
    assert(!cash, 422, 'NO_CASH_COLLECTION', 'هذا الطلب لا يتطلب تحصيلًا نقديًا');
    return;
  }
  assert(cash, 422, 'CASH_REQUIRED', 'أكد المبلغ النقدي المستلم كاملًا قبل تسليم الطلب');
  assert(c.status === 'pending', 409, 'ALREADY_COLLECTED', 'التحصيل مسجل مسبقًا');
  assert(
    cash.currency === c.currency && cash.amountMinor === c.totalMinor,
    422,
    'CASH_AMOUNT_MISMATCH',
    'يجب استلام المبلغ المطلوب كاملًا وبالعملة نفسها؛ لا يُقبل التحصيل الجزئي',
  );
  await validateCash(tx, row.id);
  await journal(
    tx,
    row.id,
    'collection',
    c.currency,
    c.totalMinor,
    [
      { account: 'holder:' + a.id, amount: c.totalMinor },
      { account: 'merchant_payable', amount: -c.goodsMinor },
      { account: 'delivery_clearing', amount: -c.feeMinor },
    ].filter((e) => e.amount !== 0),
  );
  await tx.query(
    "UPDATE cash_obligations SET status='collected',collector_id=$2,collector_name=$3,collected_at=$4,version=version+1 WHERE shipment_id=$1",
    [row.id, a.id, a.name, new Date(now).toISOString()],
  );
  await cashEvent(
    tx,
    row.id,
    a,
    'collected',
    cash.reference,
    'إقرار استلام نقدي كامل مع تسليم الطرد',
    { amountMinor: cash.amountMinor, currency: cash.currency },
  );
}
