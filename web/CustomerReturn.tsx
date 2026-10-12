import { RefundPanel } from './RefundPanel.js';
import { useState, useRef, type FormEvent } from 'react';
import type { StoreOrder } from '../shared/catalog.js';
import { commercialReturnLabels } from '../shared/commercial-returns.js';
import { api, ApiError, key } from './api.js';
export function CustomerReturn({
  order,
  onChanged,
}: {
  order: StoreOrder;
  onChanged: () => Promise<void>;
}) {
  const [target, setTarget] = useState<{
      action: 'request' | 'cancel' | 'handover';
      version: number;
    } | null>(null),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null),
    submitting = useRef(false);
  const r = order.commercialReturn,
    locked = busy || uncertain;
  function open(action: 'request' | 'cancel' | 'handover') {
    setTarget({ action, version: action === 'request' ? order.shipment.version : r!.version });
    setReason('');
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current || !reviewed) return;
    const body = JSON.stringify({
      action: target.action,
      ...(target.action === 'request'
        ? { expectedShipmentVersion: target.version }
        : { expectedReturnVersion: target.version }),
      reason,
    });
    if (!pending.current || pending.current.body !== body) pending.current = { body, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/api/storefront/orders/${order.shipment.id}/returns`, {
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
        setError('حُفظ الإقرار؛ حدّث طلباتك لقراءة حالة الإرجاع.');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError('لم نتأكد من نتيجة الحفظ. أعد الإقرار نفسه؛ لن يتكرر طلب الإرجاع.');
      } else {
        pending.current = null;
        setUncertain(false);
        setTarget(null);
        try {
          await onChanged();
        } catch {}
        setError(e.message);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (order.shipment.status !== 'delivered' && !r) return null;
  return (
    <section className="shop-return" aria-label="إرجاع الطلب">
      <h3>إرجاع الطلب بعد الاستلام</h3>
      {r ? (
        <>
          <strong>{commercialReturnLabels[r.status]}</strong>
          <p>سبب طلبك: {r.reason}</p>
          {r.decisionReason && <p>رد المتجر: {r.decisionReason}</p>}
        </>
      ) : (
        <p>
          يمكنك طلب إرجاع جميع منتجات هذا الطلب ليُراجعها المتجر. قيمة البضائع المرجعية{' '}
          {new Intl.NumberFormat('ar-SY').format(order.subtotalMinor / 100)} ل.س.
        </p>
      )}
      {r?.courierId && (
        <p>
          مندوب الإرجاع: {r.courierName} · مكان الاستلام المتفق عليه: {r.collectionAddress} ·
          الوجهة: {r.originName}
        </p>
      )}
      {r?.issueOpen && (
        <p className="alert">يوجد بلاغ تعثر؛ العهدة محفوظة ولم يُسجّل استلام بضاعة أو رد نقد.</p>
      )}
      <p className="scope-note">
        يبقى الطلب الأصلي مسلّمًا. تأكيد تسليم المرتجع للمندوب لا يعني رد المال. بعد وصوله للمنشأ
        تُعزل البضاعة للفحص؛ اعتماد رد قيمة البضائع وتمويله وإقرار استلامه خطوات مستقلة تظهر أدناه.
      </p>
      {!target && r?.status === 'accepted' && (
        <button className="shop-primary" onClick={() => open('handover')}>
          تأكيد تسليم المرتجع للمندوب
        </button>
      )}
      {!target &&
        (!r ? (
          <button className="shop-secondary" onClick={() => open('request')}>
            طلب إرجاع كامل الطلب
          </button>
        ) : ['requested', 'approved', 'assigned', 'accepted'].includes(r.status) ? (
          <button className="shop-secondary" onClick={() => open('cancel')}>
            سحب طلب الإرجاع
          </button>
        ) : null)}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {r && <RefundPanel r={r} onChanged={onChanged} />}
      {target && (
        <form onSubmit={(e) => void submit(e)}>
          {target.action === 'handover' && (
            <p>
              أكد أنك سلّمت جميع منتجات الطلب فعليًا إلى {r?.courierName}. لا تؤكد قبل حضوره
              واستلامه؛ بعدها يتوقف سحب الطلب حتى معالجة العهدة.
            </p>
          )}
          <fieldset disabled={locked}>
            <label>
              سبب{' '}
              {target.action === 'request'
                ? 'الإرجاع'
                : target.action === 'handover'
                  ? 'إقرار التسليم'
                  : 'سحب الإرجاع'}
              <textarea
                aria-label="سبب طلب الإرجاع"
                minLength={5}
                maxLength={500}
                required
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label className="transfer-review">
              <input
                type="checkbox"
                required
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              راجعت طلب الإرجاع وأؤكد تسجيله لطلبي.
            </label>
          </fieldset>
          <div className="button-row">
            <button className="shop-primary" disabled={busy || !reviewed} type="submit">
              {busy
                ? 'جارٍ الحفظ…'
                : target.action === 'handover'
                  ? 'تسجيل تسليم المرتجع'
                  : 'تأكيد طلب الإرجاع'}
            </button>
            <button
              className="shop-secondary"
              type="button"
              disabled={locked}
              onClick={() => setTarget(null)}
            >
              إغلاق النموذج
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
