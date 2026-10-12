import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Package, RefreshCw, Plus, ShieldCheck, LoaderCircle } from 'lucide-react';
import type { InventoryView, InventorySitesView } from '../shared/inventory.js';
import { catalog } from '../shared/catalog.js';
import { api, key, ApiError } from './api.js';
import { InventoryAudit } from './InventoryAudit.js';
import { InventorySites } from './InventorySites.js';

const name = (id: string) => catalog.find((p) => p.id === id)?.name ?? id;
const labels: Record<string, string> = {
  opening: 'رصيد افتتاحي',
  receipt: 'وارد',
  reserve: 'حجز طلب',
  prepare: 'تجهيز',
  handover_origin: 'خروج للناقل',
  cancel: 'تحرير إلغاء',
  reservation_expired: 'انتهاء الحجز',
  deliver: 'تسليم العميل',
  release_pickup: 'استلام العميل',
  receive_return: 'مرتجع معزول',
  restock: 'إعادة للبيع بعد الفحص',
  discard: 'استبعاد تالف',
  adjustment_in: 'زيادة نتيجة الجرد',
  adjustment_out: 'نقص نتيجة الجرد',
  transfer_reserve: 'حجز نقل بين المواقع',
  transfer_send: 'خروج بعهدة نقل',
  transfer_receive: 'استلام نقل في الوجهة',
  transfer_cancel: 'تحرير حجز النقل',
};
export function Inventory({ notify }: { notify: (message: string) => void }) {
  const [data, setData] = useState<InventoryView | null>(null);
  const [tab, setTab] = useState<'stock' | 'audit' | 'sites'>('stock');
  const [sites, setSites] = useState<InventorySitesView | null>(null);
  const [siteId, setSiteId] = useState('');
  const loadSequence = useRef(0);
  const [auditLocked, setAuditLocked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [selected, setSelected] = useState(0);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [inspection, setInspection] = useState<InventoryView['returns'][number] | null>(null);
  const [disposition, setDisposition] = useState('partial');
  const [inspectionCounts, setInspectionCounts] = useState<
    Record<string, { restock: string; discard: string }>
  >({});
  const pending = useRef<{ body: string; url: string; key: string } | null>(null);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (receipt || inspection) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [receipt, inspection]);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [result, locations] = await Promise.all([
        api<InventoryView>(
          '/api/inventory' + (siteId ? '?siteId=' + encodeURIComponent(siteId) : ''),
        ),
        api<InventorySitesView>('/api/inventory/sites'),
      ]);
      if (sequence !== loadSequence.current) return;
      setData(result);
      setSites(locations);
      setError('');
    } catch (e) {
      if (sequence === loadSequence.current) {
        setData(null);
        setSites(null);
        setError(e instanceof Error ? e.message : 'تعذر تحميل المخزون');
      }
      throw e;
    }
  }, [siteId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!data || submitting.current) return;
    const items = inspection?.items.map((i) => ({
      productId: i.productId,
      restock: Number(inspectionCounts[i.productId]?.restock ?? 0),
      discard: Number(inspectionCounts[i.productId]?.discard ?? 0),
    }));
    if (inspection && disposition === 'partial') {
      if (!items?.some((i) => i.restock + i.discard > 0)) {
        setError('حدد الكميات التي فحصتها؛ تبقى بقية القطع معزولة.');
        return;
      }
      if (
        items.some(
          (i) =>
            i.restock + i.discard >
            inspection.items.find((p) => p.productId === i.productId)!.quantity,
        )
      ) {
        setError('مجموع الصالح والتالف يتجاوز الكمية المتبقية للفحص.');
        return;
      }
    }
    const stock = data.stocks[selected];
    const url = inspection
      ? `/api/inventory/returns/${inspection.id}/inspect`
      : '/api/inventory/receipts';
    const body = JSON.stringify(
      inspection
        ? {
            expectedVersion: inspection.version,
            ...(disposition === 'partial' ? { items } : { disposition }),
            reason,
          }
        : {
            merchantId: stock.merchantId,
            siteId: stock.siteId,
            productId: stock.productId,
            expectedVersion: stock.version,
            quantity: Number(quantity),
            reason,
          },
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
      setReceipt(false);
      setInspection(null);
      setQuantity('');
      setReason('');
      notify('تم تسجيل حركة المخزون');
      try {
        await load();
      } catch {
        setError('تم حفظ الحركة؛ تعذر تحديث الرصيد. حدّث القائمة قبل تسجيل حركة جديدة.');
        setData(null);
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError(
          'لم نتأكد من نتيجة الحفظ. أعد إرسال الحركة نفسها بزر التأكيد؛ لن تُسجل الكمية مرتين. أبقِ هذه الصفحة مفتوحة حتى ظهور النتيجة.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        if (e.code === 'VERSION_CONFLICT') {
          const inspecting = !!inspection;
          setReceipt(false);
          setInspection(null);
          setInspectionCounts({});
          try {
            await load();
            setError(
              inspecting
                ? 'تغير المرتجع لدى مستخدم آخر. أعد فتحه وراجع الكميات المتبقية قبل تأكيد الفحص.'
                : 'تغير رصيد الموقع. أعد فتح الوارد وراجع الكمية المستلمة قبل التأكيد.',
            );
          } catch {
            setError('تغير المرتجع وتعذر تحديثه. حدّث المخزون قبل فتح نموذج فحص جديد.');
            setData(null);
          }
        } else setError(e.message);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const total = (field: 'available' | 'reserved' | 'quarantine') => data?.totals[field] ?? 0;
  function changeSite(id: string) {
    setReceipt(false);
    setInspection(null);
    setSelected(0);
    setData(null);
    setSiteId(id);
    if (id === siteId) void load().catch(() => {});
  }
  return (
    <div className="inventory-view">
      <section className="inventory-intro">
        <div>
          <span className="eyebrow">من الطلب إلى التجهيز</span>
          <h2>كل قطعة لها مكان وحالة</h2>
          <p>
            المتاح = الموجود − المحجوز − المعزول. يبدأ حجز الطلب عند تأكيده، ويخرج المخزون عند تسليم
            المتجر للناقل.
          </p>
        </div>
        <ShieldCheck size={42} />
      </section>
      <div className="inventory-scope panel">
        <label>
          نطاق المخزون
          <select
            aria-label="نطاق المخزون"
            value={siteId}
            disabled={busy || uncertain || auditLocked || !sites || !data}
            onChange={(e) => changeSite(e.target.value)}
          >
            <option value="">جميع مواقع الحساب</option>
            {sites?.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.merchantName}
              </option>
            ))}
          </select>
        </label>
        <p>الوارد والحركات والمرتجعات والجرد مرتبطة بالموقع المختار.</p>
        <button
          className="button secondary"
          disabled={busy || uncertain || auditLocked || receipt || !!inspection}
          onClick={() => void load().catch(() => {})}
        >
          <RefreshCw size={16} /> تحديث المواقع والأرصدة
        </button>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="inventory-tabs" role="tablist" aria-label="أقسام المخزون">
        <button
          role="tab"
          aria-selected={tab === 'stock'}
          disabled={busy || uncertain || auditLocked}
          onClick={() => setTab('stock')}
        >
          الأرصدة والحركة
        </button>
        <button
          role="tab"
          aria-selected={tab === 'audit'}
          disabled={busy || uncertain || auditLocked}
          onClick={() => setTab('audit')}
        >
          الجرد والمطابقة
        </button>
        <button
          role="tab"
          aria-selected={tab === 'sites'}
          disabled={busy || uncertain || auditLocked || !sites}
          onClick={() => setTab('sites')}
        >
          مواقع المخزون
        </button>
      </div>
      {tab === 'audit' ? (
        <InventoryAudit
          key={siteId}
          siteId={siteId}
          notify={notify}
          onCommitted={load}
          onLocked={setAuditLocked}
        />
      ) : tab === 'sites' ? (
        sites ? (
          <InventorySites
            data={sites}
            notify={notify}
            onCommitted={load}
            onLocked={setAuditLocked}
            onOpen={(id) => {
              changeSite(id);
              setTab('stock');
            }}
          />
        ) : (
          <p className="scope-note">جارٍ تحميل مواقع المخزون…</p>
        )
      ) : (
        <>
          <div className="inventory-metrics">
            {[
              { label: 'متاح للبيع', value: total('available'), icon: Box },
              { label: 'محجوز للطلبات والنقل', value: total('reserved'), icon: Package },
              { label: 'مرتجع بانتظار الفحص', value: total('quarantine'), icon: ShieldCheck },
            ].map((m) => (
              <div key={m.label}>
                <m.icon size={22} />
                <span>{m.label}</span>
                <strong>{m.value}</strong>
              </div>
            ))}
          </div>
          <section className="panel inventory-panel">
            <div className="panel-heading">
              <div>
                <h2>أرصدة المنتجات</h2>
                <p>الكميات المجهزة جزء من المحجوز، والكميات في النقل غادرت رصيد المنشأ.</p>
                {data && data.totals.stockTotal > data.displayLimit && (
                  <p className="scope-note">
                    يُعرض أول {data.displayLimit} من {data.totals.stockTotal} رصيد؛ الإجماليات تشمل
                    النطاق كله. اختر موقعًا لعرض بقية أرصدته.
                  </p>
                )}
              </div>
              <div className="button-row">
                <button
                  className="button secondary"
                  disabled={busy || uncertain || receipt || !!inspection}
                  onClick={() => void load().catch((e) => setError(e.message))}
                >
                  <RefreshCw size={16} />
                  تحديث المخزون
                </button>
                <button
                  className="button primary"
                  disabled={busy || uncertain || !data?.stocks.length}
                  onClick={() => {
                    setReceipt(true);
                    setInspection(null);
                    setReason('');
                    setQuantity('');
                  }}
                >
                  <Plus size={16} />
                  تسجيل وارد
                </button>
              </div>
            </div>
            {!data ? (
              <p className="scope-note">
                جارٍ تحميل المخزون؛ يمكنك إعادة التحديث عند تعذر الاتصال.
              </p>
            ) : !data.stocks.length ? (
              <p className="scope-note">لا يوجد مخزون مُدار لهذا المتجر في التجربة الحالية.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>المنتج والمنشأ</th>
                      <th>الموجود</th>
                      <th>المتاح</th>
                      <th>المحجوز</th>
                      <th>منه مجهز</th>
                      <th>في النقل</th>
                      <th>المعزول</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stocks.map((s) => (
                      <tr key={s.merchantId + s.siteId + s.productId}>
                        <td>
                          <strong>{name(s.productId)}</strong>
                          <small>
                            {s.siteName} · {s.merchantName}
                          </small>
                        </td>
                        <td>{s.onHand}</td>
                        <td>
                          <span
                            className={`inventory-stock-pill ${s.available === 0 ? 'empty' : ''}`}
                          >
                            {s.available}
                          </span>
                        </td>
                        <td>{s.reserved}</td>
                        <td>{s.prepared}</td>
                        <td>{s.inTransit}</td>
                        <td>{s.quarantine}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {(receipt || inspection) && data && (
            <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
              <h3>
                {inspection ? `فحص المرتجع ${inspection.reference}` : 'تسجيل استلام مخزون جديد'}
              </h3>
              <p>
                {inspection
                  ? 'سجّل كميات القطع الصالحة والتالفة التي فحصتها فعليًا. تبقى القطع غير المفحوصة معزولة.'
                  : 'تحقق من الكمية المستلمة فعليًا قبل التسجيل. الوارد يزيد الموجود والمتاح مع سجل تدقيق.'}
              </p>
              <fieldset className="inventory-fields" disabled={busy || uncertain}>
                {inspection ? (
                  <>
                    <div className="scope-note">
                      {inspection.items
                        .map((i) => `${name(i.productId)} × ${i.quantity}`)
                        .join('، ')}
                    </div>
                    <label>
                      نتيجة الفحص
                      <select
                        aria-label="نتيجة الفحص"
                        value={disposition}
                        onChange={(e) => setDisposition(e.target.value)}
                        disabled={busy}
                      >
                        <option value="partial">تحديد الكميات لكل منتج</option>
                        <option value="restock">كل الكمية المتبقية صالحة — إعادة للبيع</option>
                        <option value="discard">كل الكمية المتبقية تالفة — استبعاد</option>
                      </select>
                    </label>
                    {disposition === 'partial' && (
                      <div className="inspection-lines">
                        {inspection.items.map((item) => {
                          const counts = inspectionCounts[item.productId] ?? {
                            restock: '0',
                            discard: '0',
                          };
                          const remaining =
                            item.quantity - Number(counts.restock) - Number(counts.discard);
                          return (
                            <div className="inspection-line" key={item.productId}>
                              <div>
                                <strong>{name(item.productId)}</strong>
                                <p>
                                  متبقٍ للفحص: {item.quantity} من أصل {item.originalQuantity}
                                </p>
                                {(item.restocked > 0 || item.discarded > 0) && (
                                  <small>
                                    فُحص سابقًا: صالح {item.restocked} · تالف {item.discarded}
                                  </small>
                                )}
                              </div>
                              <div className="inspection-quantity-fields">
                                <label>
                                  صالح للبيع
                                  <input
                                    aria-label={'صالح للبيع: ' + name(item.productId)}
                                    type="number"
                                    min="0"
                                    max={item.quantity}
                                    step="1"
                                    value={counts.restock}
                                    onChange={(e) =>
                                      setInspectionCounts((c) => ({
                                        ...c,
                                        [item.productId]: { ...counts, restock: e.target.value },
                                      }))
                                    }
                                  />
                                </label>
                                <label>
                                  تالف
                                  <input
                                    aria-label={'تالف: ' + name(item.productId)}
                                    type="number"
                                    min="0"
                                    max={item.quantity}
                                    step="1"
                                    value={counts.discard}
                                    onChange={(e) =>
                                      setInspectionCounts((c) => ({
                                        ...c,
                                        [item.productId]: { ...counts, discard: e.target.value },
                                      }))
                                    }
                                  />
                                </label>
                              </div>
                              <p className={remaining < 0 ? 'inspection-exceeded' : 'scope-note'}>
                                {remaining < 0
                                  ? 'الكميات المدخلة تتجاوز المتبقي'
                                  : `يبقى معزولًا بعد الحفظ: ${remaining} قطعة`}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <label>
                      المنتج
                      <select
                        aria-label="المنتج"
                        value={selected}
                        onChange={(e) => setSelected(Number(e.target.value))}
                        disabled={busy}
                      >
                        {data.stocks.map((s, i) => (
                          <option key={s.productId + s.siteId} value={i}>
                            {name(s.productId)} · {s.siteName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      الكمية المستلمة
                      <input
                        aria-label="الكمية المستلمة"
                        type="number"
                        min="1"
                        max="10000"
                        step="1"
                        required
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                  </>
                )}
                <label>
                  سبب الحركة / مرجعها
                  <input
                    aria-label="سبب الحركة / مرجعها"
                    required
                    minLength={3}
                    maxLength={240}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={
                      inspection
                        ? 'مثال: فحص التغليف والقطع وإثبات صلاحيتها'
                        : 'مثال: استلام دفعة التوريد ١٢'
                    }
                    disabled={busy}
                  />
                </label>
              </fieldset>
              {inspection && (
                <p className="scope-note">
                  يُعاد الصالح للبيع فقط، ويُستبعد التالف من الموجود. يمكنك إكمال فحص القطع المتبقية
                  لاحقًا.
                </p>
              )}
              <div className="button-row">
                <button className="button primary" disabled={busy} type="submit">
                  {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
                  تأكيد حركة المخزون
                </button>
                <button
                  className="button secondary"
                  disabled={busy || uncertain}
                  type="button"
                  onClick={() => {
                    setReceipt(false);
                    setInspection(null);
                  }}
                >
                  إلغاء
                </button>
              </div>
            </form>
          )}
          {!!data?.returns.length && (
            <section className="panel inventory-panel">
              <div className="panel-heading">
                <div>
                  <h2>مرتجعات تحتاج فحصًا</h2>
                  <p>
                    استُلمت في المنشأ؛ لا تدخل في المتاح حتى تأكيد نتيجة الفحص. تُعرض أقدم 20 مهمة.
                  </p>
                </div>
              </div>
              <div className="inventory-return-list">
                {data.returns.map((r) => (
                  <div key={r.id}>
                    <strong dir="ltr">{r.reference}</strong>
                    <span>
                      {r.items.map((i) => `${name(i.productId)} × ${i.quantity}`).join('، ')}
                    </span>
                    <button
                      className="button secondary"
                      disabled={busy || uncertain}
                      onClick={() => {
                        setInspection(r);
                        setReceipt(false);
                        setReason('');
                        setDisposition('partial');
                        setInspectionCounts({});
                      }}
                    >
                      فحص المرتجع {r.reference}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="panel inventory-panel">
            <div className="panel-heading">
              <div>
                <h2>سجل الحركة</h2>
                <p>
                  آخر 30 حركة؛ الافتتاحي اصطناعي والطلبات السابقة لهذه المرحلة غير محسوبة بأثر رجعي.
                </p>
              </div>
            </div>
            <div className="inventory-ledger">
              {data?.movements.map((m) => (
                <div key={m.id}>
                  <span className="inventory-ledger-icon">
                    <Package size={17} />
                  </span>
                  <div>
                    <strong>
                      {labels[m.kind] ?? m.kind} · {name(m.productId)} × {m.quantity}
                    </strong>
                    <p>
                      {m.siteName ?? m.siteId} · {m.merchantName} — {m.reason}
                    </p>
                    <small>
                      {m.actorName} · {new Date(m.createdAt).toLocaleString('ar-SY')}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
