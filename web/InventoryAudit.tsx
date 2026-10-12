import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck, LoaderCircle } from 'lucide-react';
import { catalog } from '../shared/catalog.js';
import type {
  InventoryCount,
  InventoryReconciliation,
  InventoryReconciliationRow,
} from '../shared/inventory-reconciliation.js';
import { api, key, ApiError } from './api.js';
const name = (id: string) => catalog.find((p) => p.id === id)?.name ?? id;
export function InventoryAudit({
  notify,
  onCommitted,
  onLocked,
  siteId = '',
}: {
  notify: (message: string) => void;
  onCommitted: () => Promise<void>;
  onLocked: (locked: boolean) => void;
  siteId?: string;
}) {
  const [report, setReport] = useState<InventoryReconciliation | null>(null);
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<InventoryReconciliationRow | null>(null);
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ body: string; key: string } | null>(null);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    onLocked(busy || uncertain);
    return () => onLocked(false);
  }, [busy, uncertain, onLocked]);
  const load = useCallback(async () => {
    const query = siteId ? '?siteId=' + encodeURIComponent(siteId) : '';
    const [next, history] = await Promise.all([
      api<InventoryReconciliation>('/api/inventory/reconciliation' + query),
      api<{ counts: InventoryCount[] }>('/api/inventory/counts' + query),
    ]);
    setReport(next);
    setCounts(history.counts);
    setError('');
  }, [siteId]);
  useEffect(() => {
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  const actual = Number(counted);
  const committed = (target?.reserved ?? 0) + (target?.quarantine ?? 0);
  const below = !!target && counted !== '' && actual < committed;
  const delta = actual - (target?.onHand ?? 0);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current || below) return;
    if (!review) {
      setReview(true);
      return;
    }
    const body = JSON.stringify({
      merchantId: target.merchantId,
      siteId: target.siteId,
      productId: target.productId,
      expectedVersion: target.version,
      counted: actual,
      reason,
    });
    if (pending.current?.body !== body) pending.current = { body, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/api/inventory/counts', {
        method: 'POST',
        body,
        headers: { 'idempotency-key': pending.current.key },
      });
      pending.current = null;
      setUncertain(false);
      setTarget(null);
      setReview(false);
      notify('تم تسجيل الجرد وتحديث الرصيد');
      try {
        await load();
        await onCommitted();
      } catch {
        setReport(null);
        setError('تم حفظ الجرد؛ تعذر تحديث العرض. حدّث المطابقة قبل جرد جديد.');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError(
          'لم نتأكد من نتيجة الجرد. أعد تأكيد العملية نفسها دون تغيير العدد؛ لن تسجل مرتين. أبقِ الصفحة مفتوحة حتى ظهور النتيجة.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        if (['VERSION_CONFLICT', 'INVENTORY_INCONSISTENT'].includes(e.code)) {
          setTarget(null);
          setReview(false);
          try {
            await load();
            setError(e.message);
          } catch {
            setReport(null);
            setError('تعذر تحديث المطابقة؛ أعد المحاولة قبل جرد جديد.');
          }
        } else {
          setReview(false);
          setError(e.message);
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="inventory-audit">
      <section className="panel inventory-panel">
        <div className="panel-heading">
          <div>
            <h2>مطابقة الأرصدة</h2>
            <p>مقارنة الرصيد بكل الحركات وحالات الطلبات؛ لا تغير هذه المراجعة أي كمية.</p>
          </div>
          <button
            className="button secondary"
            disabled={busy || uncertain || loading}
            onClick={() => {
              setLoading(true);
              setTarget(null);
              setReview(false);
              void load()
                .catch((e) => setError(e.message))
                .finally(() => setLoading(false));
            }}
          >
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            تحديث المطابقة
          </button>
        </div>
        {report && (
          <div className="audit-summary">
            <span className={report.exceptions ? 'audit-status exception' : 'audit-status'}>
              {report.exceptions ? `${report.exceptions} أرصدة تحتاج تحقيقًا` : 'الأرصدة متطابقة'}
            </span>
            <span>
              مطابق {report.matched} من {report.total} ·{' '}
              {new Date(report.checkedAt).toLocaleString('ar-SY')}
            </span>
          </div>
        )}
        {report?.rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المنتج والمنشأ</th>
                  <th>الموجود / السجل</th>
                  <th>المحجوز</th>
                  <th>المعزول</th>
                  <th>نتيجة المراجعة</th>
                  <th>الجرد</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={JSON.stringify([row.merchantId, row.siteId, row.productId])}>
                    <td data-label="المنتج والمنشأ">
                      <strong>{name(row.productId)}</strong>
                      <small>
                        {row.siteName} · {row.merchantName}
                      </small>
                    </td>
                    <td data-label="الموجود / السجل">
                      {row.onHand ?? 'مفقود'} / {row.ledgerOnHand}
                    </td>
                    <td data-label="المحجوز">
                      {row.reserved ?? 'مفقود'}
                      <small>
                        الحركات {row.ledgerReserved} · الطلبات {row.reservedFromOrders} · النقل{' '}
                        {row.reservedForTransfers}
                      </small>
                    </td>
                    <td data-label="المعزول">
                      {row.quarantine ?? 'مفقود'}
                      <small>
                        الحركات {row.ledgerQuarantine} · المرتجعات {row.quarantineFromReturns} · تلف
                        النقل {row.quarantineFromTransfers}
                      </small>
                    </td>
                    <td data-label="نتيجة المراجعة">
                      {row.matched ? (
                        <span className="audit-status">متطابق</span>
                      ) : (
                        <ul className="audit-differences">
                          {row.differences.map((d) => (
                            <li key={d}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td data-label="الجرد">
                      <button
                        className="button secondary"
                        aria-label={'جرد ' + name(row.productId) + ' في ' + row.siteName}
                        disabled={!row.matched || busy || uncertain}
                        onClick={() => {
                          setTarget(row);
                          setCounted('');
                          setReason('');
                          setReview(false);
                          setError('');
                        }}
                      >
                        تسجيل جرد
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="scope-note">
            {loading ? 'جارٍ المطابقة…' : 'لا توجد أرصدة في نطاق هذا الحساب.'}
          </p>
        )}
        {report && report.total > report.displayLimit && (
          <p className="scope-note">
            تُعرض أول {report.displayLimit} رصيد مع إعطاء الأولوية للاختلافات؛ الأعداد الإجمالية
            تشمل نطاق الحساب كاملًا.
          </p>
        )}
      </section>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {target && (
        <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
          <h3>جرد {name(target.productId)}</h3>
          <p>
            {target.siteName} · عدّ الموجود فعليًا في المنشأ، بما فيه المحجوز والمعزول؛ استبعد القطع
            التي غادرت للنقل.
          </p>
          <fieldset className="inventory-fields" disabled={busy || uncertain || review}>
            <label>
              العدد الفعلي
              <input
                aria-label="العدد الفعلي"
                type="number"
                required
                min="0"
                max="1000000"
                step="1"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
            </label>
            <div className="count-baseline">
              <strong>الموجود المسجل: {target.onHand}</strong>
              <p>
                محجوز {target.reserved} · معزول {target.quarantine}
              </p>
            </div>
            <label>
              سبب الفرق / مرجع الجرد
              <input
                aria-label="سبب الفرق / مرجع الجرد"
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: جرد الرف ٣ والتحقق من القطع"
              />
            </label>
          </fieldset>
          {counted !== '' && (
            <div className={`count-preview ${below ? 'invalid' : ''}`}>
              <strong>
                {delta === 0
                  ? 'العدد مطابق؛ يسجل تأكيد الجرد دون حركة كمية'
                  : delta > 0
                    ? `زيادة ${delta} قطعة`
                    : `نقص ${Math.abs(delta)} قطعة`}
              </strong>
              <p>
                {below
                  ? 'العدد أقل من المحجوز والمعزول. يلزم التحقيق وتسوية الالتزامات قبل تصحيح الرصيد.'
                  : `الموجود بعد الجرد: ${actual} · المتاح: ${actual - committed}`}
              </p>
            </div>
          )}
          {review && (
            <p className="scope-note">
              راجع العدد والفرق قبل التأكيد. سيُحفظ الجرد باسم حسابك، وتُسجل حركة تصحيح عند وجود
              فرق.
            </p>
          )}
          <div className="button-row">
            <button className="button primary" disabled={busy || below} type="submit">
              {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{' '}
              {review ? 'تأكيد الجرد' : 'مراجعة الجرد'}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy || uncertain}
              onClick={() => (review ? setReview(false) : setTarget(null))}
            >
              {review ? 'تعديل العدد' : 'إلغاء'}
            </button>
          </div>
        </form>
      )}
      <section className="panel inventory-panel">
        <div className="panel-heading">
          <div>
            <h2>سجل الجرد</h2>
            <p>آخر 30 نتيجة، بما فيها التأكيد دون فرق. لا تُحذف الحركات السابقة عند التصحيح.</p>
          </div>
        </div>
        <div className="inventory-ledger">
          {counts.length ? (
            counts.map((c) => (
              <div key={c.id}>
                <div>
                  <strong>
                    {name(c.productId)} · من {c.before} إلى {c.counted} · فرق{' '}
                    {c.delta > 0 ? '+' : ''}
                    {c.delta}
                  </strong>
                  <p>{c.reason}</p>
                  <small>
                    {c.actorName} · {new Date(c.createdAt).toLocaleString('ar-SY')}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="scope-note">لم يسجل جرد بعد لهذا الحساب.</p>
          )}
        </div>
      </section>
    </div>
  );
}
