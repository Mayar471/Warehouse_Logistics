import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Truck, Plus, RefreshCw, ShieldCheck, LoaderCircle } from 'lucide-react';
import type { Account, Courier } from '../shared/contracts.js';
import type { InventorySitesView, InventoryView } from '../shared/inventory.js';
import type { InventoryTransfer, TransferEvent, TransferView } from '../shared/transfers.js';
import { catalog } from '../shared/catalog.js';
import { api, key, ApiError } from './api.js';
const name = (id: string) => catalog.find((p) => p.id === id)?.name ?? id;
const statusLabels: Record<string, string> = {
  reserved: 'محجوز في المصدر',
  assigned: 'بانتظار قبول المندوب',
  accepted: 'المندوب قبل المهمة',
  released: 'سلّم المصدر العهدة',
  in_transit: 'في عهدة النقل',
  received: 'اكتمل الاستلام',
  resolved: 'أُغلقت العهدة بتسوية موثقة',
  cancelled: 'أُلغي الحجز',
};
const actions: Record<string, string> = {
  assign: 'إسناد النقل',
  accept: 'قبول المهمة',
  decline: 'رفض المهمة',
  unassign: 'تحرير الإسناد',
  release: 'تسليم عهدة المصدر',
  pickup: 'تأكيد استلام المندوب',
  receive: 'استلام في الوجهة',
  cancel: 'إلغاء الحجز',
  report_issue: 'تسجيل فرق أو تعثر',
  resolve_issue: 'مراجعة الفقد والتلف',
  inspect_damage: 'فحص تلف النقل',
  created: 'إنشاء وحجز',
  hold_expired: 'انتهاء حجز النقل',
  assignment_expired: 'انتهاء مهلة القبول',
};
export function InventoryTransfers({
  account,
  couriers,
  notify,
  onCommitted,
}: {
  account: Account;
  couriers: Courier[];
  notify: (s: string) => void;
  onCommitted: () => Promise<void>;
}) {
  const manage = ['operator', 'merchant'].includes(account.role);
  const [view, setView] = useState<TransferView | null>(null);
  const [sites, setSites] = useState<InventorySitesView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<{ row: InventoryTransfer; action: string } | null>(null);
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [stocks, setStocks] = useState<InventoryView['stocks'] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [courier, setCourier] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [history, setHistory] = useState<{
    row: InventoryTransfer;
    events: TransferEvent[];
  } | null>(null);
  const pending = useRef<{ url: string; body: string; key: string } | null>(null);
  const submitting = useRef(false);
  const historySequence = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    const [next, locations] = await Promise.all([
      api<TransferView>('/api/inventory/transfers'),
      manage ? api<InventorySitesView>('/api/inventory/sites') : Promise.resolve(null),
    ]);
    setView(next);
    setSites(locations);
    setError('');
  }, [manage]);
  useEffect(() => {
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    if (creating || target) form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [creating, target]);
  useEffect(() => {
    if (!creating || !source) return;
    let cancelled = false;
    setStocks(null);
    void api<InventoryView>('/api/inventory?siteId=' + encodeURIComponent(source))
      .then((r) => {
        if (!cancelled) setStocks(r.stocks);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [creating, source]);
  const sourceSite = sites?.sites.find((s) => s.id === source);
  const destinationSite = sites?.sites.find((s) => s.id === destination);
  const options = stocks?.filter((s) => destinationSite?.products.includes(s.productId)) ?? [];
  const weight = options.reduce(
    (sum, s) =>
      sum +
      (catalog.find((p) => p.id === s.productId)?.weightKg ?? 0) *
        Number(amounts[s.productId] ?? 0),
    0,
  );
  const locked = busy || uncertain;
  function open(row: InventoryTransfer, action: string) {
    setTarget({ row, action });
    setCreating(false);
    setAmounts({});
    setReason('');
    setReference('');
    setReviewed(false);
    setCourier('');
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return;
    let url: string, body: string;
    if (creating && sourceSite && destinationSite && stocks) {
      const items = options
        .filter((s) => Number(amounts[s.productId] ?? 0) > 0)
        .map((s) => ({
          productId: s.productId,
          quantity: Number(amounts[s.productId]),
          sourceVersion: s.version,
        }));
      if (!items.length) {
        setError('حدد كمية منتج واحد على الأقل للنقل.');
        return;
      }
      url = '/api/inventory/transfers';
      body = JSON.stringify({
        merchantId: sourceSite.merchantId,
        sourceId: source,
        destinationId: destination,
        items,
        reason,
      });
    } else if (target) {
      const items = target.row.lines
        .filter((l) => Number(amounts[l.productId] ?? 0) > 0)
        .map((l) => ({ productId: l.productId, quantity: Number(amounts[l.productId]) }));
      if (target.action === 'receive' && !items.length) {
        setError('سجّل القطع المستلمة فعليًا؛ البقية تبقى في عهدة النقل.');
        return;
      }
      url = `/api/inventory/transfers/${target.row.id}/actions`;
      const resolution = target.row.lines
        .map((l) => ({
          productId: l.productId,
          lost: Number(amounts[l.productId + ':lost'] ?? 0),
          damaged: Number(amounts[l.productId + ':damaged'] ?? 0),
        }))
        .filter((l) => l.lost + l.damaged > 0);
      const inspection = target.row.lines
        .map((l) => ({
          productId: l.productId,
          restocked: Number(amounts[l.productId + ':restocked'] ?? 0),
          discarded: Number(amounts[l.productId + ':discarded'] ?? 0),
        }))
        .filter((l) => l.restocked + l.discarded > 0);
      if (
        ['resolve_issue', 'inspect_damage'].includes(target.action) &&
        (!reviewed || !(target.action === 'resolve_issue' ? resolution : inspection).length)
      ) {
        setError('حدد الكميات وراجع أثرها قبل التأكيد.');
        return;
      }
      body = JSON.stringify({
        action: target.action,
        expectedVersion: target.row.version,
        reason,
        ...(target.action === 'assign' ? { courierId: courier } : {}),
        ...(target.action === 'receive' ? { items } : {}),
        ...(target.action === 'resolve_issue' ? { items: resolution, reference } : {}),
        ...(target.action === 'inspect_damage' ? { items: inspection } : {}),
      });
    } else return;
    if (pending.current?.body !== body || pending.current.url !== url)
      pending.current = { url, body, key: key() };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await api(url, { method: 'POST', body, headers: { 'idempotency-key': pending.current.key } });
      pending.current = null;
      setUncertain(false);
      setCreating(false);
      setTarget(null);
      setHistory(null);
      historySequence.current++;
      notify('تم تسجيل إجراء النقل');
      try {
        await load();
        await onCommitted();
      } catch {
        setView(null);
        setError('تم حفظ إجراء النقل؛ تعذر تحديث العرض. حدّث المهام قبل إجراء جديد.');
      }
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError(
          'لم نتأكد من نتيجة الحفظ. أبقِ الصفحة مفتوحة وأعد تأكيد الإجراء نفسه؛ لن تُنقل الكمية أو العهدة مرتين.',
        );
      } else {
        pending.current = null;
        setUncertain(false);
        if (
          [
            'VERSION_CONFLICT',
            'ASSIGNMENT_EXPIRED',
            'TRANSFER_HOLD_EXPIRED',
            'INVENTORY_INCONSISTENT',
          ].includes(e.code)
        ) {
          setCreating(false);
          setTarget(null);
          try {
            await load();
            setError(e.message);
          } catch {
            setView(null);
            setError('تعذر تحديث مهام النقل؛ أعد القراءة قبل إجراء جديد.');
          }
        } else setError(e.message);
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
          <span className="eyebrow">كل قطعة بعهدة واضحة</span>
          <h2>من موقع إلى موقع، باستلام فعلي</h2>
          <p>
            الحجز يبقي القطع في المصدر. التسليم يخرجها إلى عهدة النقل، والاستلام وحده يضيفها للوجهة.
          </p>
        </div>
        <Truck size={42} />
      </section>
      <div className="transfer-toolbar">
        <span className="audit-status">
          {view
            ? `${view.active} عهدة مفتوحة · ${view.pendingInspection} تنتظر فحص التلف · ${view.total} إجمالي`
            : 'جارٍ تحميل مهام النقل…'}
        </span>
        <div className="button-row">
          <button
            className="button secondary"
            disabled={locked || loading || creating || !!target}
            onClick={() => {
              setLoading(true);
              void load()
                .catch((e) => setError(e.message))
                .finally(() => setLoading(false));
            }}
          >
            <RefreshCw size={16} /> تحديث مهام النقل
          </button>
          {manage && (
            <button
              className="button primary"
              disabled={locked || !view || !sites}
              onClick={() => {
                setCreating(true);
                setTarget(null);
                setSource(sites!.sites[0]?.id ?? '');
                setDestination('');
                setAmounts({});
                setReason('');
                setError('');
              }}
            >
              <Plus size={16} /> نقل جديد
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {(creating || target) && (
        <form ref={form} className="panel inventory-form" onSubmit={(e) => void submit(e)}>
          <h3>
            {creating
              ? 'إنشاء نقل بين موقعين'
              : `${actions[target!.action]} · TR-${target!.row.id.slice(0, 8)}`}
          </h3>
          <p>
            {creating
              ? 'بين موقعي المتجر نفسه في دمشق. الحجز لا يزيد رصيد الوجهة؛ مهلة الحجز 24 ساعة قبل تسليم العهدة.'
              : target?.action === 'receive'
                ? 'أدخل العدد الذي استلمته فعليًا لكل منتج. أي فرق يبقى ظاهرًا في عهدة النقل، ولا يضاف إلى المتاح.'
                : target?.action === 'resolve_issue'
                  ? 'اعتماد العمليات فقط: المفقود يُغلق من العهدة دون إضافة رصيد. التالف هنا قطع وصلت فعليًا إلى الوجهة وتدخل العزل حتى الفحص. لا تُسجّل قطعة سبق استلامها أو تسويتها.'
                  : target?.action === 'inspect_damage'
                    ? 'افحص القطع المعزولة: الصالح يعود للمتاح والتالف نهائيًا يُستبعد من الموجود. يمكنك إكمال الفحص على دفعات.'
                    : target?.action === 'release'
                      ? 'تأكد من تسليم جميع القطع للمندوب المكلف. سيخرج الموجود والمحجوز من المصدر، ولا يمكن الإلغاء بعد هذا الإقرار.'
                      : 'راجع المهمة والإقرار قبل التأكيد. سيحفظ الإجراء باسم حسابك.'}
          </p>
          <fieldset className="inventory-fields" disabled={locked}>
            {creating && (
              <>
                <label>
                  موقع المصدر
                  <select
                    aria-label="موقع المصدر"
                    value={source}
                    required
                    onChange={(e) => {
                      if (e.target.value === source) return;
                      setSource(e.target.value);
                      setDestination('');
                      setAmounts({});
                      setStocks(null);
                    }}
                  >
                    {sites?.sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.merchantName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  موقع الوجهة
                  <select
                    aria-label="موقع الوجهة"
                    required
                    value={destination}
                    onChange={(e) => {
                      if (e.target.value === destination) return;
                      setDestination(e.target.value);
                      setAmounts({});
                    }}
                  >
                    <option value="">اختر الوجهة</option>
                    {sites?.sites
                      .filter((s) => s.merchantId === sourceSite?.merchantId && s.id !== source)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
            {creating && destination && (
              <div className="transfer-quantity-list">
                {stocks ? (
                  options.length ? (
                    options.map((s) => (
                      <label key={s.productId}>
                        {name(s.productId)}
                        <small>متاح المصدر {s.available}</small>
                        <input
                          aria-label={'كمية النقل: ' + name(s.productId)}
                          type="number"
                          min="0"
                          max={s.available}
                          step="1"
                          value={amounts[s.productId] ?? '0'}
                          onChange={(e) =>
                            setAmounts((a) => ({ ...a, [s.productId]: e.target.value }))
                          }
                        />
                      </label>
                    ))
                  ) : (
                    <p>لا توجد منتجات مشتركة مرتبطة بالموقعين. اربط منتجات الوجهة أولًا.</p>
                  )
                ) : (
                  <p>جارٍ تحميل رصيد المصدر…</p>
                )}
              </div>
            )}
            {target?.action === 'assign' && (
              <label>
                مندوب النقل
                <select
                  aria-label="مندوب النقل"
                  value={courier}
                  required
                  onChange={(e) => setCourier(e.target.value)}
                >
                  <option value="">اختر مندوبًا</option>
                  {couriers
                    .filter((c) => c.available)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · متبقي {Math.max(0, c.capacityKg - c.activeKg).toFixed(1)} كغ
                      </option>
                    ))}
                </select>
              </label>
            )}
            {target?.action === 'receive' && (
              <div className="transfer-quantity-list">
                {target.row.lines
                  .filter((l) => l.quantity > l.received + l.lost)
                  .map((l) => (
                    <label key={l.productId}>
                      {name(l.productId)}
                      <small>
                        أُرسل {l.quantity} · استُلم {l.received} · متبقٍ{' '}
                        {l.quantity - l.received - l.lost}
                      </small>
                      <input
                        aria-label={'المستلم فعليًا: ' + name(l.productId)}
                        type="number"
                        min="0"
                        max={l.quantity - l.received - l.lost}
                        step="1"
                        value={amounts[l.productId] ?? '0'}
                        onChange={(e) =>
                          setAmounts((a) => ({ ...a, [l.productId]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
              </div>
            )}
            {target && ['resolve_issue', 'inspect_damage'].includes(target.action) && (
              <>
                <div className="transfer-resolution-list">
                  {target.row.lines
                    .filter((l) =>
                      target.action === 'resolve_issue'
                        ? l.quantity - l.received - l.lost > 0
                        : l.damaged - l.restocked - l.discarded > 0,
                    )
                    .map((l) => {
                      const remaining =
                        target.action === 'resolve_issue'
                          ? l.quantity - l.received - l.lost
                          : l.damaged - l.restocked - l.discarded;
                      const fields =
                        target.action === 'resolve_issue'
                          ? [
                              ['lost', 'مفقود'],
                              ['damaged', 'تالف وصل فعليًا'],
                            ]
                          : [
                              ['restocked', 'صالح بعد الفحص'],
                              ['discarded', 'تالف للاستبعاد'],
                            ];
                      return (
                        <section className="transfer-resolution-row" key={l.productId}>
                          <strong>{name(l.productId)}</strong>
                          <small>
                            {target.action === 'resolve_issue'
                              ? 'متبقٍ في العهدة'
                              : 'معزول ينتظر الفحص'}
                            : {remaining}
                          </small>
                          <div className="transfer-resolution-inputs">
                            {fields.map(([field, label]) => (
                              <label key={field}>
                                {label}
                                <input
                                  aria-label={label + ': ' + name(l.productId)}
                                  type="number"
                                  min="0"
                                  max={remaining}
                                  step="1"
                                  value={amounts[l.productId + ':' + field] ?? '0'}
                                  onChange={(e) => {
                                    setAmounts((a) => ({
                                      ...a,
                                      [l.productId + ':' + field]: e.target.value,
                                    }));
                                    setReviewed(false);
                                  }}
                                />
                              </label>
                            ))}
                          </div>
                          <p className="scope-note">
                            سيبقى{' '}
                            {remaining -
                              fields.reduce(
                                (sum, [field]) =>
                                  sum + Number(amounts[l.productId + ':' + field] ?? 0),
                                0,
                              )}{' '}
                            دون {target.action === 'resolve_issue' ? 'تسوية' : 'فحص'}.
                          </p>
                        </section>
                      );
                    })}
                </div>
                {target.action === 'resolve_issue' && (
                  <label>
                    مرجع التحقيق / محضر التسوية
                    <input
                      aria-label="مرجع التحقيق / محضر التسوية"
                      required
                      minLength={3}
                      maxLength={120}
                      value={reference}
                      onChange={(e) => {
                        setReference(e.target.value);
                        setReviewed(false);
                      }}
                    />
                  </label>
                )}
                <label className="transfer-review">
                  <input
                    type="checkbox"
                    required
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  راجعت الكميات وأثرها على العهدة والمخزون، وأؤكد توثيق الإجراء.
                </label>
              </>
            )}
            <label>
              سبب إجراء النقل / مرجعه
              <input
                aria-label="سبب إجراء النقل / مرجعه"
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>
          {creating && (
            <p className={`count-preview ${weight > 50 ? 'invalid' : ''}`}>
              حمولة القطع المحددة: {weight.toFixed(2)} كغ · حد المهمة 50 كغ. لا ينقل المخزون المحجوز
              أو المعزول.
            </p>
          )}
          <div className="button-row">
            <button
              className="button primary"
              disabled={busy || (creating && (!stocks || !destination || weight > 50))}
              type="submit"
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{' '}
              {creating ? 'تأكيد حجز النقل' : 'تأكيد إجراء النقل'}
            </button>
            <button
              className="button secondary"
              disabled={locked}
              type="button"
              onClick={() => {
                setCreating(false);
                setTarget(null);
              }}
            >
              إغلاق النموذج
            </button>
          </div>
        </form>
      )}
      <div className="transfer-grid">
        {view?.rows.map((row) => {
          const received = row.lines.reduce((sum, l) => sum + l.received, 0),
            quantity = row.lines.reduce((sum, l) => sum + l.quantity, 0),
            lost = row.lines.reduce((sum, l) => sum + l.lost, 0);
          const ownCourier = account.role === 'courier' && row.courierId === account.courierId;
          const available: string[] = [];
          if (account.role === 'operator' && row.status === 'reserved') available.push('assign');
          if (ownCourier && row.status === 'assigned') available.push('accept', 'decline');
          if (account.role === 'operator' && ['assigned', 'accepted'].includes(row.status))
            available.push('unassign');
          if (manage && row.status === 'accepted') available.push('release');
          if (ownCourier && row.status === 'released') available.push('pickup');
          if (manage && row.status === 'in_transit') available.push('receive');
          if (account.role === 'operator' && row.status === 'in_transit' && row.issueOpen)
            available.push('resolve_issue');
          if (manage && row.lines.some((l) => l.damaged > l.restocked + l.discarded))
            available.push('inspect_damage');
          if (['released', 'in_transit'].includes(row.status)) available.push('report_issue');
          if (manage && ['reserved', 'assigned', 'accepted'].includes(row.status))
            available.push('cancel');
          return (
            <article className="panel transfer-card" key={row.id}>
              <div className="site-card-title">
                <h3>TR-{row.id.slice(0, 8)}</h3>
                <span className={'audit-status ' + (row.issueOpen ? 'exception' : '')}>
                  {statusLabels[row.status]}
                </span>
              </div>
              <p className="transfer-route">
                <strong>{row.sourceName}</strong>
                <ArrowLeft size={18} />
                <strong>{row.destinationName}</strong>
              </p>
              <p>
                {row.merchantName} · {row.weightKg.toFixed(2)} كغ ·{' '}
                {row.courierName ?? 'لم يُسند لمندوب'}
              </p>
              <div className="transfer-lines">
                {row.lines.map((l) => (
                  <div key={l.productId}>
                    <strong>{name(l.productId)}</strong>
                    <span>
                      الكمية {l.quantity} · المستلم {l.received}
                      {l.lost > 0 ? ` · مفقود موثق ${l.lost}` : ''}
                      {l.damaged > 0
                        ? ` · وصل تالفًا ${l.damaged} · معزول ${l.damaged - l.restocked - l.discarded} · صالح بالفحص ${l.restocked} · مستبعد ${l.discarded}`
                        : ''}
                      {['released', 'in_transit'].includes(row.status)
                        ? ` · في العهدة ${l.quantity - l.received - l.lost}`
                        : ''}
                    </span>
                  </div>
                ))}
              </div>
              {row.issueOpen && (
                <p className="transfer-warning">
                  فرق أو تعثر مفتوح: {quantity - received - lost} قطع ما زالت في عهدة النقل. راجع
                  السجل؛ تبقى سعة المندوب محجوزة حتى الاستلام أو التسوية الموثقة.
                </p>
              )}
              {row.lines.some((l) => l.damaged > l.restocked + l.discarded) && (
                <p className="transfer-warning">
                  تلف وصل إلى الوجهة:{' '}
                  {row.lines.reduce((sum, l) => sum + l.damaged - l.restocked - l.discarded, 0)} قطع
                  معزولة تنتظر الفحص. إغلاق عهدة النقل لا يعيدها للبيع.
                </p>
              )}
              {row.status === 'assigned' && row.assignmentExpiresAt && (
                <small>
                  مهلة قبول المندوب: {new Date(row.assignmentExpiresAt).toLocaleString('ar-SY')}
                </small>
              )}
              {['reserved', 'assigned', 'accepted'].includes(row.status) && (
                <small>
                  مهلة حجز المصدر: {new Date(row.holdExpiresAt).toLocaleString('ar-SY')}
                </small>
              )}
              <div className="button-row">
                {available.map((action) => (
                  <button
                    className={
                      'button ' +
                      (['cancel', 'decline', 'unassign'].includes(action) ? 'secondary' : 'primary')
                    }
                    key={action}
                    disabled={locked}
                    onClick={() => open(row, action)}
                  >
                    {actions[action]}
                  </button>
                ))}
                <button
                  className="button secondary"
                  disabled={locked}
                  onClick={() => {
                    const sequence = ++historySequence.current;
                    void api<{ transfer: InventoryTransfer; history: TransferEvent[] }>(
                      `/api/inventory/transfers/${row.id}`,
                    )
                      .then((r) => {
                        if (sequence === historySequence.current)
                          setHistory({ row: r.transfer, events: r.history });
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  سجل النقل
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!loading && view?.total === 0 && (
        <section className="panel transfer-empty">
          <Truck size={36} />
          <h3>لا توجد مهام نقل في نطاقك</h3>
          <p>
            {manage
              ? 'أضف وجهة تخزين واربط منتجاتها، ثم احجز القطع المتاحة في المصدر.'
              : 'تظهر هنا مهام النقل التي تسندها العمليات إليك.'}
          </p>
        </section>
      )}
      {view && view.total > view.rows.length && (
        <p className="scope-note">
          تُعرض أول 50 مهمة مع أولوية العهدة المفتوحة والتلف الذي ينتظر الفحص؛ الإجماليات تشمل نطاق
          الحساب كله.
        </p>
      )}
      {history && (
        <section className="panel inventory-panel">
          <div className="panel-heading">
            <h2>سجل TR-{history.row.id.slice(0, 8)}</h2>
            <button
              className="button secondary"
              onClick={() => {
                historySequence.current++;
                setHistory(null);
              }}
            >
              إغلاق السجل
            </button>
          </div>
          <div className="inventory-ledger">
            {history.events.map((e) => (
              <div key={e.id}>
                <div>
                  <strong>
                    {actions[e.action] ?? e.action} · {e.actorName}
                  </strong>
                  <p>{e.reason}</p>
                  {typeof e.details.reference === 'string' && (
                    <p>مرجع التحقيق: {e.details.reference}</p>
                  )}
                  {Array.isArray(e.details.items) &&
                    ['resolve_issue', 'inspect_damage'].includes(e.action) && (
                      <p>
                        {(
                          e.details.items as {
                            productId: string;
                            lost?: number;
                            damaged?: number;
                            restocked?: number;
                            discarded?: number;
                          }[]
                        )
                          .map(
                            (item) =>
                              `${name(item.productId)}: ${e.action === 'resolve_issue' ? `مفقود ${item.lost}، وصل تالفًا ${item.damaged}` : `صالح ${item.restocked}، مستبعد ${item.discarded}`}`,
                          )
                          .join(' · ')}
                      </p>
                    )}
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
