import { ReferenceInput, FullAmount } from './QuickInput.js';
import { useRef, useState, type FormEvent } from 'react';
import type { Account } from '../shared/contracts.js';
import { refundLabels, type CommercialReturn } from '../shared/commercial-returns.js';
import { api, ApiError, key } from './api.js';
import { parseCash, cashMoney } from './Cash.js';
import { sendFinancialCommand, retainedFinancialError } from './financial-journal.js';
type Action = 'request' | 'reserve' | 'release' | 'cancel' | 'confirm' | 'report';
const labels: Record<Action, string> = {
  request: 'اعتماد رد قيمة البضائع',
  reserve: 'حجز تمويل رد العميل',
  release: 'تسجيل تسليم النقد للعميل',
  cancel: 'إلغاء قرار الرد',
  confirm: 'تأكيد استلام مبلغ الرد',
  report: 'تسجيل فرق في المبلغ المستلم',
};
export function RefundPanel({
  r,
  account,
  onChanged,
  disabled = false,
}: {
  r: CommercialReturn;
  account?: Account;
  onChanged: () => Promise<void>;
  disabled?: boolean;
}) {
  const [target, setTarget] = useState<{ action: Action; version: number } | null>(null),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null),
    sending = useRef(false);
  const f = r.refund,
    expected = f?.amountMinor ?? r.goodsMinor,
    locked = busy || uncertain;
  const actions: Action[] = account
    ? account.role === 'merchant'
      ? !f && r.status === 'received'
        ? ['request']
        : f && ['requested', 'reserved'].includes(f.status)
          ? ['cancel']
          : []
      : account.role === 'operator'
        ? f?.status === 'requested'
          ? ['reserve', 'cancel']
          : f?.status === 'reserved'
            ? ['release', 'cancel']
            : []
        : []
    : f?.status === 'released'
      ? ['confirm', 'report']
      : [];
  function open(action: Action) {
    setTarget({ action, version: f?.version ?? r.version });
    setAmount('');
    setReference('');
    setReason('');
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || sending.current || !reviewed) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const body = JSON.stringify({
      action: target.action,
      expectedVersion: target.version,
      amountMinor: parseCash(amount),
      currency: 'SYP',
      reference,
      reason: target.action === 'report' ? reason : labels[target.action],
    });
    if (!pending.current) pending.current = { body, key: key() };
    try {
      if (account)
        await sendFinancialCommand({
          version: 1,
          actorId: account.id,
          url: `/api/refunds/${r.id}/actions`,
          body: pending.current.body,
          key: pending.current.key,
          label: labels[target.action],
          createdAt: Date.now(),
        });
      else
        await api(`/api/storefront/orders/${r.shipmentId}/refund`, {
          method: 'POST',
          body: pending.current.body,
          headers: { 'idempotency-key': pending.current.key },
        });
      pending.current = null;
      setUncertain(false);
      setTarget(null);
      try {
        await onChanged();
      } catch {
        setError('حُفظ إقرار الرد؛ تعذر تحديث القراءة. حدّث الصفحة لعرض النتيجة.');
      }
    } catch (e) {
      const retained = account
        ? retainedFinancialError(e)
        : !(e instanceof ApiError) || e.status >= 500;
      if (retained) {
        if (account) setTarget(null);
        else setUncertain(true);
        setError('لم نتأكد من نتيجة الحفظ. تابع الإقرار نفسه؛ لا تسجل مبلغًا جديدًا.');
      } else {
        pending.current = null;
        setUncertain(false);
        setTarget(null);
        setError(e instanceof Error ? e.message : 'تعذر تسجيل الرد');
        try {
          await onChanged();
        } catch {}
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  if (!f && r.status !== 'received') return null;
  const entered = parseCash(amount),
    valid =
      Number.isSafeInteger(entered) &&
      (target?.action === 'report' ? entered !== expected : entered === expected);
  return (
    <section className="shop-return" aria-label="رد أموال العميل">
      <h3>رد أموال العميل</h3>
      <p>
        قيمة البضائع فقط: <strong>{cashMoney(expected)}</strong>. رسوم التوصيل غير مشمولة. يلزم فحص
        جميع القطع وتمويل موثق؛ لا يعني استلام البضاعة رد المال.
      </p>
      {f && <strong>{refundLabels[f.status]}</strong>}
      {r.inspectionComplete && !r.inspectionReply && account?.role === 'merchant' && (
        <p>أرسل رد المتجر بعد الفحص أولًا، ثم اعتمد مبلغ الرد.</p>
      )}
      {!r.inspectionComplete && <p>أكمل فحص جميع القطع في شاشة المخزون قبل اعتماد الرد.</p>}
      {f?.issueOpen && (
        <p className="alert">
          فرق مبلغ مفتوح؛ المبلغ الذي أقر العميل باستلامه: {cashMoney(f.lastReportedMinor ?? 0)}.
          النقد في عهدة الرد ولم يُعتبر مستلمًا بالكامل.
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {!target && (
        <div className="button-row">
          {actions.map((action) => (
            <button
              key={action}
              className="button secondary"
              disabled={
                busy ||
                disabled ||
                (action === 'request' && (!r.inspectionComplete || !r.inspectionReply))
              }
              onClick={() => open(action)}
            >
              {labels[action]}
            </button>
          ))}
        </div>
      )}
      {target && (
        <form onSubmit={(e) => void submit(e)}>
          <h4>{labels[target.action]}</h4>
          <p>
            {target.action === 'release'
              ? 'أكد تسليم كامل النقد فعليًا للعميل؛ سيبقى الرد معلقًا حتى إقراره المستقل.'
              : target.action === 'confirm'
                ? 'أكد المبلغ الذي استلمته فعليًا. لا تؤكد مبلغًا لم يصلك.'
                : target.action === 'report'
                  ? 'أدخل المبلغ الذي استلمته فعليًا دون إغلاق عهدة الرد.'
                  : 'راجع القيمة والمرجع وأثر الإجراء قبل التسجيل.'}
          </p>
          <fieldset disabled={locked}>
            <label>
              المبلغ بالليرة السورية
              <input
                aria-label="مبلغ رد العميل"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setReviewed(false);
                  pending.current = null;
                }}
              />
              <FullAmount
                minor={expected}
                onChange={(value) => {
                  setAmount(value);
                  setReviewed(false);
                }}
              />
            </label>
            <label>
              مرجع إقرار رد العميل
              <ReferenceInput
                label="مرجع إقرار رد العميل"
                value={reference}
                onChange={(value) => {
                  setReference(value);
                  setReviewed(false);
                }}
              />
            </label>
            {target.action === 'report' && (
              <label>
                وصف فرق المبلغ
                <textarea
                  aria-label="وصف فرق المبلغ"
                  minLength={3}
                  maxLength={240}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReviewed(false);
                    pending.current = null;
                  }}
                />
              </label>
            )}
            <label className="transfer-review">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              راجعت المبلغ وأؤكد إقرار رد العميل باسم حسابي.
            </label>
          </fieldset>
          <p role="status">
            {!valid
              ? target.action === 'report'
                ? 'أدخل المبلغ الفعلي المختلف عن كامل الرد.'
                : `أدخل كامل قيمة البضائع: ${cashMoney(expected)}.`
              : reference.trim().length < 3
                ? 'اكتب مرجعًا من ثلاثة أحرف على الأقل.'
                : target.action === 'report' && reason.trim().length < 3
                  ? 'اكتب وصف الفرق من ثلاثة أحرف على الأقل.'
                  : !reviewed
                    ? 'ضع علامة الإقرار لإتاحة التأكيد.'
                    : 'اكتملت البيانات المطلوبة.'}
          </p>
          <div className="button-row">
            <button
              className="button primary"
              disabled={
                busy ||
                !valid ||
                reference.trim().length < 3 ||
                (target.action === 'report' && reason.trim().length < 3) ||
                !reviewed
              }
            >
              تأكيد إقرار رد العميل
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={locked}
              onClick={() => {
                setTarget(null);
                pending.current = null;
              }}
            >
              تراجع
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
