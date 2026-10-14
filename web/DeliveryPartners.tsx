import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Bootstrap, Courier, DeliveryCompany } from '../shared/contracts.js';
import type { Coordinates } from '../shared/customer-locations.js';
import { api } from './api.js';
import { PartnerLocation } from './PartnerLocation.js';
import { RemovePartner } from './RemovePartner.js';

export function DeliveryPartners({
  data,
  onChanged,
}: {
  data: Bootstrap;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    kind: 'companies' | 'couriers';
    value?: Courier | DeliveryCompany;
  } | null>(null);
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>مكاتب التوصيل</h2>
            <p>جهة التعاقد واستحقاق أجور المناديب التابعين</p>
          </div>
          <button className="button primary" onClick={() => setEditing({ kind: 'companies' })}>
            إضافة مكتب توصيل
          </button>
        </div>
        {(data.deliveryCompanies ?? []).map((c) => (
          <div className="site-item" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <p>{c.address}</p>
              <small>
                {data.couriers.filter((x) => x.companyId === c.id).length} مندوب تابع · تسوية الأجور
                مع المكتب
              </small>
            </div>
            <button
              className="button secondary"
              onClick={() => setEditing({ kind: 'companies', value: c })}
            >
              إدارة المكتب
            </button>
          </div>
        ))}
        {!data.deliveryCompanies?.length && (
          <p className="scope-note">لا توجد مكاتب مسجلة. أضف المكتب ثم اربط مندوبيه به.</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>المندوبون</h2>
            <p>مستقل أو تابع لمكتب، مع جهة تسوية واضحة</p>
          </div>
          <button className="button primary" onClick={() => setEditing({ kind: 'couriers' })}>
            إضافة مندوب
          </button>
        </div>
        {data.couriers.map((c) => (
          <div className="courier-card" key={c.id}>
            <div className="split">
              <strong>{c.name}</strong>
              <button
                className="button secondary"
                onClick={() => setEditing({ kind: 'couriers', value: c })}
              >
                إدارة المندوب
              </button>
              <RemovePartner
                kind="couriers"
                id={c.id}
                name={c.name}
                version={c.version ?? 1}
                onRemoved={onChanged}
              />
            </div>
            <p>
              {c.companyId ? `تابع لـ ${c.companyName} · الأجور للمكتب` : 'مستقل · الأجور للمندوب'}
            </p>
            <small>
              {c.vehicle} · {c.available ? 'متاح للإسناد' : 'غير متاح للإسناد'} · حمولة محجوزة{' '}
              {c.activeKg} / {c.capacityKg} كغ
            </small>
            <p>
              {c.ratingCount ? `★ ${c.rating} / 5 · ${c.ratingCount} تقييم` : 'لا توجد تقييمات بعد'}
            </p>
          </div>
        ))}
      </section>
      {editing && (
        <PartnerEditor
          key={editing.kind + (editing.value?.id ?? 'new')}
          {...editing}
          companies={data.deliveryCompanies ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await onChanged();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
function PartnerEditor({
  kind,
  value,
  companies,
  onClose,
  onSaved,
}: {
  kind: 'companies' | 'couriers';
  value?: Courier | DeliveryCompany;
  companies: DeliveryCompany[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const office = kind === 'companies',
    existingCourier = value as Courier | undefined,
    existingOffice = value as DeliveryCompany | undefined;
  const [name, setName] = useState(value?.name ?? ''),
    [address, setAddress] = useState(office ? (existingOffice?.address ?? '') : '');
  const [percentage, setPercentage] = useState(
    value?.rateBps == null ? '' : String(value.rateBps / 100),
  );
  const [location, setLocation] = useState<Coordinates | null>(
    office && existingOffice
      ? { latitude: existingOffice.latitude, longitude: existingOffice.longitude }
      : null,
  );
  const [vehicle, setVehicle] = useState(existingCourier?.vehicle ?? 'دراجة نارية'),
    [capacity, setCapacity] = useState(String(existingCourier?.capacityKg ?? 12));
  const [company, setCompany] = useState(existingCourier?.companyId ?? ''),
    [available, setAvailable] = useState(existingCourier?.available ?? true);
  const [busy, setBusy] = useState(false),
    [committed, setCommitted] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    let saved = committed;
    try {
      if (!committed) {
        const body = JSON.stringify({
          name,
          rateBps: percentage.trim() === '' ? null : Math.round(Number(percentage) * 100),
          ...(office
            ? { address: address.trim() || 'موقع محدد على الخريطة، دمشق', location }
            : { vehicle, capacityKg: Number(capacity), companyId: company || null, available }),
          ...(value ? { expectedVersion: value.version } : {}),
        });
        if (pending.current?.body !== body) pending.current = { body, key: crypto.randomUUID() };
        await api('/api/network/' + kind + (value ? '/' + value.id : ''), {
          method: value ? 'PATCH' : 'POST',
          headers: { 'idempotency-key': pending.current.key },
          body,
        });
        saved = true;
        setCommitted(true);
      }
      await onSaved();
    } catch (e) {
      setError(
        saved
          ? 'تم الحفظ؛ تعذر تحديث القائمة. أعد تحديث العرض دون إعادة الإنشاء.'
          : e instanceof Error
            ? e.message
            : 'تعذر الحفظ',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="partner-dialog"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="partner-editor-title"
    >
      <form onSubmit={save}>
        <div className="panel-title">
          <h2 id="partner-editor-title">
            {value ? 'إدارة' : 'إضافة'} {office ? 'مكتب توصيل' : 'مندوب'}
          </h2>
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
            إغلاق
          </button>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy || committed} className="partner-fields">
          {(office || !company) && (
            <label>
              نسبة الأجر من رسوم التوصيل (%)
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
                placeholder="اتركها فارغة إن لم يُحدد الاتفاق"
              />
              <small>تطبق على الإسنادات الجديدة فقط، ولا تشمل قيمة البضائع.</small>
            </label>
          )}
          {!office && company && (
            <p className="scope-note">
              تطبق نسبة مكتب التوصيل المختار:{' '}
              {companies.find((c) => c.id === company)?.rateBps == null
                ? 'لم يُحدد الاتفاق بعد'
                : companies.find((c) => c.id === company)!.rateBps! / 100 + '%'}
              .
            </p>
          )}
          <label>
            الاسم
            <input
              required
              minLength={3}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {office ? (
            <>
              <PartnerLocation point={location} onChange={setLocation} />
              <label>
                وصف البناء (اختياري)
                <input
                  minLength={5}
                  maxLength={130}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                المركبة
                <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
                  {['دراجة نارية', 'سيارة صغيرة', 'سيارة نقل'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                السعة بالكيلوغرام
                <input
                  type="number"
                  required
                  min={1}
                  max={1000}
                  step="0.1"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </label>
              <label>
                التبعية وجهة تسوية الأجور
                <select value={company} onChange={(e) => setCompany(e.target.value)}>
                  <option value="">مستقل — التسوية مع المندوب</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — التسوية مع المكتب
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={available}
                  onChange={(e) => setAvailable(e.target.checked)}
                />{' '}
                متاح للإسناد
              </label>
              <p className="scope-note">
                عهدة النقد تبقى على مستلمها الفعلي. تحديد أجور النقل وتسويتها يحتاج اتفاق تسعير؛ لا
                يولّد هذا النموذج مبالغ مالية.
              </p>
            </>
          )}
        </fieldset>
        <button className="button primary" disabled={busy || (office && !location)}>
          {busy ? 'جارٍ الحفظ…' : committed ? 'تحديث القائمة' : 'حفظ'}
        </button>
      </form>
    </dialog>
  );
}
