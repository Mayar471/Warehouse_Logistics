import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Warehouse, Plus, LoaderCircle } from 'lucide-react';
import { catalog } from '../shared/catalog.js';
import type { InventorySitesView } from '../shared/inventory.js';
import { api, key, ApiError } from './api.js';

export function InventorySites({
  data,
  notify,
  onCommitted,
  onLocked,
  onOpen,
}: {
  data: InventorySitesView;
  notify: (message: string) => void;
  onCommitted: () => Promise<void>;
  onLocked: (locked: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const [target, setTarget] = useState<'new' | InventorySitesView['sites'][number] | null>(null);
  const [merchantId, setMerchantId] = useState(data.merchants[0]?.id ?? '');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ body: string; url: string; key: string } | null>(null);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    onLocked(busy || uncertain);
    return () => onLocked(false);
  }, [busy, uncertain, onLocked]);
  useEffect(() => {
    if (target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [target]);
  function open(next: NonNullable<typeof target>) {
    setTarget(next);
    setName('');
    setAddress('');
    setProducts([]);
    setReason('');
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || submitting.current) return;
    if (!products.length) {
      setError('اختر منتجًا واحدًا على الأقل لربطه بالموقع.');
      return;
    }
    const url =
      target === 'new' ? '/api/inventory/sites' : `/api/inventory/sites/${target.id}/products`;
    const body = JSON.stringify(
      target === 'new'
        ? { merchantId, name, address, products, reason }
        : { products, expectedVersion: target.version, reason },
    );
    if (pending.current?.body !== body || pending.current.url !== url)
      pending.current = { body, url, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api(url, { method: 'POST', body, headers: { 'idempotency-key': pending.current.key } });
      pending.current = null;
      setUncertain(false);
      setTarget(null);
      notify('تم ربط المنتجات بالموقع بأرصدة صفرية');
      try {
        await onCommitted();
      } catch {
        setError('تم الحفظ؛ تعذر تحديث القائمة. حدّث المخزون قبل عملية جديدة.');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError(
          'لم نتأكد من نتيجة الحفظ. أبقِ الصفحة مفتوحة وأعد تأكيد البيانات نفسها؛ لن يُنشأ الموقع أو الرصيد مرتين.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        setError(e.message);
        if (['VERSION_CONFLICT', 'PRODUCT_ALREADY_REGISTERED'].includes(e.code)) {
          setTarget(null);
          try {
            await onCommitted();
          } catch {
            setError('تغير الموقع؛ حدّث المخزون قبل إعادة ربط المنتجات.');
          }
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
            <h2>مواقع المخزون</h2>
            <p>جميع مواقع حسابك؛ رصيد مستقل لكل متجر وموقع ومنتج. إضافة موقع لا تنقل إليه بضاعة.</p>
          </div>
          <button
            className="button primary"
            disabled={busy || uncertain}
            onClick={() => open('new')}
          >
            <Plus size={16} /> إضافة موقع تخزين
          </button>
        </div>
        <div className="inventory-site-grid">
          {data.sites.map((site) => (
            <article className="inventory-site-card" key={site.id}>
              <div className="site-card-title">
                <Warehouse size={23} />
                <span className="audit-status">
                  {site.kind === 'warehouse' ? 'موقع تخزين' : 'موقع متجر'}
                </span>
              </div>
              <h3>{site.name}</h3>
              <p>
                {site.merchantName} · {site.city}
              </p>
              <p>{site.address}</p>
              <div className="site-product-tags">
                {site.products.length ? (
                  site.products.map((id) => (
                    <span key={id}>{catalog.find((p) => p.id === id)?.name ?? id}</span>
                  ))
                ) : (
                  <span>لم تُربط منتجات بعد</span>
                )}
              </div>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={busy || uncertain}
                  onClick={() => onOpen(site.id)}
                >
                  عرض أرصدة الموقع
                </button>
                <button
                  className="button secondary"
                  disabled={busy || uncertain || site.products.length >= catalog.length}
                  onClick={() => open(site)}
                >
                  ربط منتجات
                </button>
              </div>
            </article>
          ))}
        </div>
        <p className="scope-note">
          النطاق التشغيلي الحالي دمشق، والمنتجات من كتالوج التجربة. لا تُجمّع كميات المواقع تلقائيًا
          في متجر تريند سي؛ طلباته تستخدم موقع بيت الشام الحالي حتى تنفيذ اختيار منشأ التنفيذ.
        </p>
      </section>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {target && (
        <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
          <h3>{target === 'new' ? 'موقع تخزين جديد' : `ربط منتجات: ${target.name}`}</h3>
          <p>
            يبدأ كل منتج برصيد صفر؛ سجّل الوارد عند استلام القطع فعليًا. النقل بين المواقع سيحتاج
            إرسالًا وعهدة واستلامًا مستقلة.
          </p>
          <fieldset className="inventory-fields" disabled={busy || uncertain}>
            {target === 'new' && (
              <>
                <label>
                  المتجر المالك
                  <select
                    aria-label="المتجر المالك"
                    value={merchantId}
                    onChange={(e) => setMerchantId(e.target.value)}
                  >
                    {data.merchants.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  اسم الموقع
                  <input
                    aria-label="اسم الموقع"
                    required
                    minLength={3}
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  عنوان موقع التخزين
                  <input
                    aria-label="عنوان موقع التخزين"
                    required
                    minLength={5}
                    maxLength={130}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="site-product-picker">
              <strong>المنتجات المراد ربطها</strong>
              {catalog
                .filter((p) => target === 'new' || !target.products.includes(p.id))
                .map((p) => (
                  <label key={p.id}>
                    <input
                      type="checkbox"
                      checked={products.includes(p.id)}
                      onChange={(e) =>
                        setProducts((current) =>
                          e.target.checked
                            ? [...current, p.id]
                            : current.filter((id) => id !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
            </div>
            <label>
              سبب الإضافة / مرجعها
              <input
                aria-label="سبب الإضافة / مرجعها"
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>
          <div className="button-row">
            <button className="button primary" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={16} className="spin" />} تأكيد ربط المنتجات
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy || uncertain}
              onClick={() => setTarget(null)}
            >
              إلغاء
            </button>
          </div>
        </form>
      )}
      <section className="panel inventory-panel">
        <div className="panel-heading">
          <div>
            <h2>سجل إدارة المواقع</h2>
            <p>آخر 30 عملية ضمن نطاق حسابك.</p>
          </div>
        </div>
        <div className="inventory-ledger">
          {data.audit.length ? (
            data.audit.map((a) => (
              <div key={a.id}>
                <div>
                  <strong>
                    {a.siteName} ·{' '}
                    {a.action === 'inventory_site_created' ? 'إضافة موقع' : 'ربط منتجات'}
                  </strong>
                  <p>{a.reason}</p>
                  <small>
                    {a.actorName} · {new Date(a.createdAt).toLocaleString('ar-SY')}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="scope-note">لا توجد عمليات إدارة مسجلة بعد.</p>
          )}
        </div>
      </section>
    </div>
  );
}
