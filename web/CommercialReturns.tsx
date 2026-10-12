import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Account } from '../shared/contracts.js';
import type { CommercialReturn, CommercialReturnView } from '../shared/commercial-returns.js';
import { commercialReturnLabels } from '../shared/commercial-returns.js';
import { catalog } from '../shared/catalog.js';
import { api, ApiError, key } from './api.js';
export function CommercialReturns({ account }: { account: Account }) {
  const [view, setView] = useState<CommercialReturnView | null>(null),
    [target, setTarget] = useState<{ row: CommercialReturn; action: 'approve' | 'reject' } | null>(
      null,
    ),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null),
    submitting = useRef(false),
    form = useRef<HTMLFormElement>(null);
  const load = useCallback(
    async () => setView(await api<CommercialReturnView>('/api/commercial-returns')),
    [],
  );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  const locked = busy || uncertain;
  function open(row: CommercialReturn, action: 'approve' | 'reject') {
    setTarget({ row, action });
    setReference('');
    setReason('');
    setReviewed(false);
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current || !reviewed) return;
    const body = JSON.stringify({
      action: target.action,
      expectedVersion: target.row.version,
      reference,
      reason,
    });
    if (!pending.current || pending.current.body !== body) pending.current = { body, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/api/commercial-returns/${target.row.id}/actions`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': pending.current.key, 'x-review-actor': account.id },
      });
      pending.current = null;
      setUncertain(false);
      setTarget(null);
      try {
        await load();
      } catch {
        setView(null);
        setError('حُفظ القرار؛ حدّث المرتجعات لقراءة النتيجة.');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError('لم نتأكد من نتيجة الحفظ. أعد القرار نفسه دون تغيير الحقول؛ لن يتكرر القرار.');
      } else {
        pending.current = null;
        setUncertain(false);
        setTarget(null);
        try {
          await load();
        } catch {
          setView(null);
        }
        setError(e.message);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="inventory-view">
      <section className="inventory-intro">
        <div>
          <span className="eyebrow">طلب العميل وقرار المتجر قبل حركة البضاعة</span>
          <h2>مرتجعات العملاء</h2>
          <p>
            نراجع إرجاع كامل الطلب بعد تسليمه. قبول الإرجاع لا يسجل استلام بضاعة أو زيادة مخزون أو
            رد أموال؛ النقل والفحص والرد المالي مراحل تالية.
          </p>
        </div>
      </section>
      <div className="transfer-toolbar">
        <span>{view ? `${view.total} طلبات إرجاع في نطاقك` : 'جارٍ قراءة المرتجعات…'}</span>
        <button
          className="button secondary"
          disabled={locked || !!target}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          تحديث المرتجعات
        </button>
      </div>
      {view && (
        <div className="cash-metrics">
          {[
            ['بانتظار مراجعة المتجر', view.requested],
            ['مقبولة بانتظار الاستلام', view.approved],
          ].map(([label, value]) => (
            <div className="panel" key={String(label)}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {target && (
        <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
          <h3>
            {target.action === 'approve' ? 'قبول بدء الإرجاع' : 'رفض طلب الإرجاع'} ·{' '}
            {target.row.shipmentReference}
          </h3>
          <p>
            جميع منتجات الطلب · قيمة البضائع المرجعية{' '}
            {new Intl.NumberFormat('ar-SY').format(target.row.goodsMinor / 100)} ل.س. يبقى تسليم
            الطلب والمخزون والحساب المالي كما هو حتى تنفيذ مراحله اللاحقة.
          </p>
          <fieldset className="inventory-fields" disabled={locked}>
            <label>
              مرجع قرار الإرجاع
              <input
                aria-label="مرجع قرار الإرجاع"
                required
                minLength={3}
                maxLength={100}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label>
              رد المتجر الموضح للعميل
              <textarea
                aria-label="رد المتجر الموضح للعميل"
                required
                minLength={5}
                maxLength={240}
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
                checked={reviewed}
                required
                onChange={(e) => setReviewed(e.target.checked)}
              />
              راجعت طلب العميل وأثر القرار وأوافق على عرضه للعميل.
            </label>
          </fieldset>
          <div className="button-row">
            <button className="button primary" disabled={busy || !reviewed}>
              تأكيد قرار الإرجاع
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={locked}
              onClick={() => setTarget(null)}
            >
              إغلاق النموذج
            </button>
          </div>
        </form>
      )}
      <div className="transfer-grid">
        {view?.rows.map((r) => (
          <article className="panel transfer-card" key={r.id}>
            <div className="site-card-title">
              <h3>{r.shipmentReference}</h3>
              <span className="audit-status">{commercialReturnLabels[r.status]}</span>
            </div>
            <p>
              {r.merchantName} · {r.reason}
            </p>
            <p>
              {r.items
                .map(
                  (i) =>
                    `${catalog.find((p) => p.id === i.productId)?.name ?? i.productId} × ${i.quantity}`,
                )
                .join(' · ')}
            </p>
            {r.decisionReason && <p>رد المتجر: {r.decisionReason}</p>}
            {account.role === 'merchant' && r.status === 'requested' && (
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={locked}
                  onClick={() => open(r, 'approve')}
                >
                  قبول طلب الإرجاع
                </button>
                <button
                  className="button secondary"
                  disabled={locked}
                  onClick={() => open(r, 'reject')}
                >
                  رفض طلب الإرجاع
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {view?.total === 0 && (
        <section className="panel transfer-empty">
          <h3>لا توجد طلبات إرجاع في نطاقك</h3>
          <p>تظهر طلبات العملاء هنا بعد استلامهم الطلب وطلب إرجاعه من متجر التجربة.</p>
        </section>
      )}
      {view && view.total > view.rows.length && (
        <p className="scope-note">
          أول 50 طلبًا بأولوية الطلبات المفتوحة؛ الإجماليات تشمل نطاقك كله.
        </p>
      )}
      {view && (
        <section className="panel inventory-panel">
          <h3>سجل مراجعة المرتجعات</h3>
          <div className="inventory-ledger">
            {view.history.map((e) => (
              <div key={e.id}>
                <div>
                  <strong>
                    {
                      (
                        {
                          request: 'طلب العميل',
                          approve: 'قبول المتجر',
                          reject: 'رفض المتجر',
                          cancel: 'سحب العميل',
                        } as Record<string, string>
                      )[e.action]
                    }{' '}
                    · {e.actorName}
                  </strong>
                  <p>
                    {e.reference} · {e.reason}
                  </p>
                  <small>{new Date(e.createdAt).toLocaleString('ar-SY')}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
