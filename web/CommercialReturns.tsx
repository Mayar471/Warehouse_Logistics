import { RefundPanel } from './RefundPanel.js';
import { FinancialRecovery, useFinancialRecovery } from './FinancialRecovery.js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Account, Courier } from '../shared/contracts.js';
import type { CommercialReturn, CommercialReturnView } from '../shared/commercial-returns.js';
import { commercialReturnLabels } from '../shared/commercial-returns.js';
import { catalog } from '../shared/catalog.js';
import { api, ApiError, key } from './api.js';
type ReturnAction =
  | 'approve'
  | 'reject'
  | 'assign'
  | 'accept'
  | 'decline'
  | 'unassign'
  | 'pickup'
  | 'receive'
  | 'report'
  | 'reply';
const actionLabels: Record<ReturnAction, string> = {
  approve: 'قبول طلب الإرجاع',
  reject: 'رفض طلب الإرجاع',
  assign: 'إسناد استلام المرتجع',
  accept: 'قبول مهمة الإرجاع',
  decline: 'رفض مهمة الإرجاع',
  unassign: 'تحرير إسناد الإرجاع',
  pickup: 'تأكيد استلام المرتجع من العميل',
  receive: 'تأكيد استلام كامل المرتجع في المنشأ',
  report: 'تسجيل تعثر المرتجع',
  reply: 'إرسال رد المتجر بعد الفحص',
};
export function CommercialReturns({
  account,
  couriers,
  focusId,
  onChanged,
}: {
  account: Account;
  couriers: Courier[];
  focusId?: string;
  onChanged?: () => Promise<void>;
}) {
  const [view, setView] = useState<CommercialReturnView | null>(null),
    [target, setTarget] = useState<{ row: CommercialReturn; action: ReturnAction } | null>(null),
    [courierId, setCourierId] = useState(''),
    [collectionAddress, setCollectionAddress] = useState(''),
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
    async () =>
      setView(
        await api<CommercialReturnView>(
          '/api/commercial-returns' + (focusId ? '?returnId=' + encodeURIComponent(focusId) : ''),
        ),
      ),
    [focusId],
  );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  useEffect(() => {
    if (target || busy || uncertain) return;
    let stopped = false,
      inFlight = false;
    const timer = window.setInterval(async () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const next = await api<CommercialReturnView>(
          '/api/commercial-returns' + (focusId ? '?returnId=' + encodeURIComponent(focusId) : ''),
        );
        if (!stopped) setView(next);
      } catch {
        /* Retain the last confirmed view on background failures. */
      } finally {
        inFlight = false;
      }
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [target, busy, uncertain, focusId]);
  const recovery = useFinancialRecovery(account.id);
  const locked = busy || uncertain;
  function open(row: CommercialReturn, action: ReturnAction) {
    setTarget({ row, action });
    setReference('');
    setCourierId('');
    setCollectionAddress('');
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
      reference: target.action === 'reply' ? 'رد المتجر بعد الفحص' : reference,
      ...(target.action === 'report'
        ? { reason }
        : target.action === 'reply'
          ? { reply: reason }
          : {}),
      ...(target.action === 'assign' ? { courierId, collectionAddress } : {}),
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
        await onChanged?.();
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
      <FinancialRecovery
        command={recovery.command}
        error={recovery.error}
        onDone={async () => {
          recovery.refresh();
          await load();
        }}
        onRefresh={recovery.refresh}
        onRejected={async (message) => {
          setError(message);
          recovery.refresh();
          await load();
        }}
      />
      {!focusId && (
        <section className="inventory-intro">
          <div>
            <span className="eyebrow">إرجاع موثّق من العميل حتى منشأ الطلب</span>
            <h2>مرتجعات العملاء</h2>
            <p>
              تابع القرار وإسناد الاستلام والعهدة حتى وصول البضاعة للمنشأ. تُعزل الكميات المستلمة
              للفحص قبل إتاحتها للبيع. رد نقد العميل يتطلب اعتمادًا وتمويلًا وإقرار استلام مستقلًا.
            </p>
          </div>
        </section>
      )}
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
      {view && !focusId && (
        <div className="cash-metrics">
          {[
            ['بانتظار مراجعة المتجر', view.requested],
            ['مقبولة بانتظار الإسناد', view.approved],
            ['مهام استلام ونقل', view.active],
            ['وصلت للمنشأ', view.received],
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
            {actionLabels[target.action]} · {target.row.shipmentReference}
          </h3>
          <p>
            جميع منتجات الطلب · قيمة البضائع المرجعية{' '}
            {new Intl.NumberFormat('ar-SY').format(target.row.goodsMinor / 100)} ل.س. يبقى الطلب
            الأصلي مسلّمًا. راجع الإجراء الفعلي؛ لا تسجل وصول البضاعة قبل استلام كامل الكميات.
          </p>
          {target.action === 'pickup' && (
            <p className="scope-note">
              سجل العميل تسليم الطرد. أكد الاستلام الفعلي لجميع المنتجات فقط؛ بعدها تنتقل العهدة
              إليك.
            </p>
          )}
          {target.action === 'receive' && (
            <p className="scope-note">
              أكد استلام جميع الكميات المذكورة من المندوب في منشأ الطلب. عند نقص البضاعة أبقِ المهمة
              مفتوحة وسجّل تعثرًا؛ لا تسجّل كمية غير مستلمة.
            </p>
          )}
          <fieldset className="inventory-fields" disabled={locked}>
            {target.action === 'assign' && (
              <>
                <label>
                  مندوب استلام المرتجع
                  <select
                    aria-label="مندوب استلام المرتجع"
                    value={courierId}
                    required
                    onChange={(e) => {
                      setCourierId(e.target.value);
                      setReviewed(false);
                    }}
                  >
                    <option value="">اختر المندوب</option>
                    {(view?.couriers ?? couriers)
                      .filter((c) => c.available)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.capacityKg - c.activeKg} كغ متاحة
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  مكان استلام متفق عليه مع العميل
                  <input
                    aria-label="مكان استلام المرتجع"
                    required
                    minLength={10}
                    maxLength={240}
                    placeholder="دمشق، الحي والعنوان المتفق عليه"
                    value={collectionAddress}
                    onChange={(e) => {
                      setCollectionAddress(e.target.value);
                      setReviewed(false);
                    }}
                  />
                </label>
              </>
            )}

            {target.action !== 'reply' && (
              <label>
                مرجع إجراء الإرجاع
                <input
                  aria-label="مرجع إجراء الإرجاع"
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
            )}
            {['report', 'reply'].includes(target.action) && (
              <label>
                {target.action === 'reply' ? 'رد المتجر بعد الفحص' : 'وصف تعثر الاستلام أو النقل'}
                <textarea
                  aria-label={
                    target.action === 'reply' ? 'رد المتجر بعد الفحص' : 'وصف تعثر الاستلام أو النقل'
                  }
                  required
                  minLength={5}
                  maxLength={target.action === 'reply' ? 500 : 240}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
            )}
            <label className="transfer-review">
              <input
                type="checkbox"
                checked={reviewed}
                required
                onChange={(e) => setReviewed(e.target.checked)}
              />
              راجعت الإجراء والكميات والعهدة وأؤكد تسجيله باسم حسابي.
            </label>
          </fieldset>
          <div className="button-row">
            <button className="button primary" disabled={busy || !reviewed}>
              تأكيد إجراء الإرجاع
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
            {r.inspectionReply && <p>رد المتجر بعد الفحص: {r.inspectionReply}</p>}
            {r.courierId && (
              <p>
                المندوب: {r.courierName} · الاستلام من: {r.collectionAddress} · الإرجاع إلى:{' '}
                {r.originName}
              </p>
            )}
            <p>
              حائز البضاعة:{' '}
              {r.status === 'received'
                ? r.originName
                : r.status === 'in_transit'
                  ? r.courierName
                  : r.status === 'released'
                    ? 'تسليم العميل مسجل؛ بانتظار إقرار المندوب'
                    : 'العميل'}
            </p>
            {r.issueOpen && (
              <p className="alert">بلاغ تعثر مفتوح؛ العهدة والسعة محفوظتان حتى معالجة الاستلام.</p>
            )}
            {r.status === 'received' && (
              <p className="scope-note">
                استُلمت الكميات؛ نتيجة الفحص وحالة رد المال موضحتان أدناه.
              </p>
            )}
            {account.role === 'merchant' && r.inspectionComplete && !r.inspectionReply && (
              <button
                className="button primary"
                disabled={locked || !!target}
                onClick={() => open(r, 'reply')}
              >
                إرسال رد المتجر بعد الفحص
              </button>
            )}
            <RefundPanel
              r={r}
              account={account}
              disabled={!!recovery.command || !!recovery.error || locked}
              onChanged={async () => {
                recovery.refresh();
                await load();
              }}
            />
            <div className="button-row">
              {(account.role === 'operator'
                ? r.status === 'approved'
                  ? ['assign']
                  : ['assigned', 'accepted'].includes(r.status)
                    ? ['unassign']
                    : []
                : account.role === 'courier'
                  ? r.status === 'assigned'
                    ? ['accept', 'decline']
                    : r.status === 'released'
                      ? ['pickup', 'report']
                      : ['accepted', 'in_transit'].includes(r.status)
                        ? ['report']
                        : []
                  : r.status === 'in_transit'
                    ? ['receive']
                    : []
              ).map((action) => (
                <button
                  key={action}
                  className="button secondary"
                  disabled={locked || !!target}
                  onClick={() => open(r, action as ReturnAction)}
                >
                  {actionLabels[action as ReturnAction]}
                </button>
              ))}
            </div>
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
          <h3>
            {focusId ? 'لم تعد المهمة ظاهرة ضمن إسناد هذا الحساب' : 'لا توجد طلبات إرجاع في نطاقك'}
          </h3>
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
          <h3>سجل إجراءات الإرجاع</h3>
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
                          assign: 'إسناد الاستلام',
                          accept: 'قبول المندوب',
                          decline: 'رفض المندوب',
                          unassign: 'تحرير الإسناد',
                          handover: 'تسليم العميل',
                          pickup: 'استلام المندوب',
                          receive: 'استلام المنشأ والعزل',
                          report: 'بلاغ تعثر',
                          reply: 'رد المتجر بعد الفحص',
                          assignment_expired: 'انتهاء مهلة القبول',
                          'refund.request': 'اعتماد رد البضائع',
                          'refund.reserve': 'حجز تمويل العميل',
                          'refund.release': 'خروج نقد العميل',
                          'refund.confirm': 'إقرار العميل استلام الرد',
                          'refund.report': 'فرق في رد العميل',
                          'refund.cancel': 'إلغاء قرار الرد',
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
