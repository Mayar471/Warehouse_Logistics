import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Home, Briefcase, LocateFixed, Plus, MapPin, Star } from 'lucide-react';
import { api, key } from './api.js';
import {
  districts,
  type Coordinates,
  type CustomerAddress,
  type PickupOption,
} from '../shared/customer-locations.js';
const AddressMap = lazy(() => import('./AddressMap.js'));
export function CustomerLocations({
  pickup = false,
  points,
  selectedPoint,
  onPoint,
  onAddress,
  initial,
}: {
  pickup?: boolean;
  points: PickupOption[];
  selectedPoint: string;
  onPoint: (id: string) => void;
  onAddress: (district: string, details: string, point: Coordinates | null) => void;
  initial?: { district: string; details: string; point: Coordinates | null };
}) {
  const [saved, setSaved] = useState<CustomerAddress[]>([]),
    [selected, setSelected] = useState('custom'),
    [editing, setEditing] = useState(false),
    [mapOpen, setMapOpen] = useState(false),
    [point, setPoint] = useState<Coordinates | null>(initial?.point ?? null);
  const [district, setDistrict] = useState<string>(initial?.district ?? 'الروضة'),
    [details, setDetails] = useState(initial?.details ?? ''),
    [name, setName] = useState('عنوان مخصص'),
    [label, setLabel] = useState<CustomerAddress['label']>('custom');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [nearest, setNearest] = useState<PickupOption[] | null>(null),
    [nearMode, setNearMode] = useState(false);
  const [savedReady, setSavedReady] = useState(false);
  const [freshPoints, setFreshPoints] = useState(points),
    [pointsError, setPointsError] = useState('');
  useEffect(() => {
    if (!pickup) return;
    let disposed = false,
      inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const result = await api<{ sites: PickupOption[] }>('/api/storefront/pickup-sites');
        if (!disposed) {
          setFreshPoints(result.sites);
          setPointsError('');
        }
      } catch {
        if (!disposed)
          setPointsError('تعذر تحديث حالة النقاط. سيُعاد التحقق من الدوام عند تأكيد الطلب.');
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pickup]);
  useEffect(() => {
    if (
      pickup &&
      selectedPoint &&
      (freshPoints.find((p) => p.id === selectedPoint)?.openingStatus?.openNow === false ||
        !freshPoints.some((p) => p.id === selectedPoint))
    )
      onPoint('');
  }, [pickup, selectedPoint, freshPoints, onPoint]);
  const sequence = useRef(0),
    mounted = useRef(true),
    pending = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    void api<{ addresses: CustomerAddress[] }>('/api/storefront/addresses')
      .then((r) => {
        if (mounted.current) {
          setSaved(r.addresses);
          const match = initial?.point
            ? r.addresses.find(
                (a) =>
                  a.latitude === initial.point!.latitude &&
                  a.longitude === initial.point!.longitude,
              )
            : undefined;
          if (match && sequence.current === 0) {
            setSelected(match.id);
            setName(match.name);
            setLabel(match.label);
          }
        }
      })
      .catch(() => {
        if (mounted.current) setError('تعذر تحميل العناوين المحفوظة؛ يمكنك تحديد عنوان جديد.');
      })
      .finally(() => {
        if (mounted.current) setSavedReady(true);
      });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  function update(p: Coordinates | null, d = district, text = details) {
    const coordinates = p ? { latitude: p.latitude, longitude: p.longitude } : null;
    setPoint(coordinates);
    if (!pickup) onAddress(d, text.trim() || (p ? 'موقع محدد على الخريطة' : ''), coordinates);
  }
  async function rank(source: Coordinates | { addressId: string }, serial: number) {
    setBusy(true);
    try {
      const r = await api<{ sites: PickupOption[] }>('/api/storefront/pickup-sites/nearest', {
        method: 'POST',
        body: JSON.stringify(source),
      });
      if (mounted.current && serial === sequence.current) {
        setNearest(r.sites);
        if (r.sites.length) onPoint(r.sites[0].id);
      }
    } catch (e) {
      if (mounted.current && serial === sequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && serial === sequence.current) setBusy(false);
    }
  }
  function choose(kind: CustomerAddress['label'] | string) {
    const serial = ++sequence.current;
    setBusy(false);
    setError('');
    setNearest(null);
    setSelected(kind);
    const a = saved.find((a) => a.label === kind || a.id === kind);
    if (a) {
      setLabel(a.label);
      setName(a.name);
      setDistrict(a.district);
      setDetails(a.details);
      setEditing(false);
      setMapOpen(false);
      update(a, a.district, a.details);
      if (pickup) void rank({ addressId: a.id }, serial);
    } else {
      setLabel(kind === 'home' || kind === 'work' ? kind : 'custom');
      setName(kind === 'home' ? 'البيت' : kind === 'work' ? 'العمل' : 'عنوان مخصص');
      setEditing(true);
      setMapOpen(true);
      setDetails('');
      update(null, district, '');
    }
  }
  function current() {
    const serial = ++sequence.current;
    setSelected('current');
    setLabel('custom');
    setName('موقعي الحالي');
    setDetails('');
    setError('');
    setNearest(null);
    setBusy(true);
    setEditing(false);
    update(null, district, '');
    if (!navigator.geolocation) {
      setBusy(false);
      setError('تحديد الموقع غير مدعوم. اختر عنوانًا محفوظًا أو حدد الموقع على الخريطة.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!mounted.current || serial !== sequence.current) return;
        const p = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        update(p, district, '');
        setMapOpen(true);
        if (position.coords.accuracy > 250)
          setError('دقة الموقع منخفضة؛ راجع الدبوس وعدّل موقعه على الخريطة.');
        if (pickup) void rank(p, serial);
        else setBusy(false);
      },
      (e) => {
        if (!mounted.current || serial !== sequence.current) return;
        setBusy(false);
        setError(
          e.code === 1
            ? 'لم تسمح بمشاركة الموقع. اختر البيت أو العمل أو حدد موقعًا مخصصًا.'
            : 'تعذر تحديد موقعك. جرّب مجددًا أو حدد الدبوس على الخريطة.',
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }
  async function save() {
    if (!point) return;
    setBusy(true);
    setError('');
    const existing = saved.find((a) => a.id === selected || a.label === selected);
    const body = JSON.stringify({
      ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}),
      label,
      name,
      district,
      details,
      ...point,
    });
    if (pending.current?.body !== body) pending.current = { body, key: key() };
    try {
      const address = await api<CustomerAddress>('/api/storefront/addresses', {
        method: 'POST',
        headers: { 'idempotency-key': pending.current.key },
        body,
      });
      setSaved((s) => [...s.filter((a) => a.id !== address.id), address]);
      setSelected(address.id);
      setEditing(false);
      setMapOpen(false);
      pending.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const a = saved.find((a) => a.id === selected || a.label === selected);
    if (!a) return;
    setBusy(true);
    try {
      await api('/api/storefront/addresses/' + a.id, {
        method: 'DELETE',
        body: JSON.stringify({ expectedVersion: a.version }),
      });
      setSaved((s) => s.filter((x) => x.id !== a.id));
      choose('custom');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const options = nearMode
    ? (nearest ?? [])
        .map((p) => ({
          ...p,
          openingStatus: freshPoints.find((v) => v.id === p.id)?.openingStatus ?? p.openingStatus,
        }))
        .filter((p) => p.openingStatus?.openNow !== false && freshPoints.some((v) => v.id === p.id))
    : freshPoints;
  return (
    <section
      className="customer-locations"
      aria-label={pickup ? 'اختيار نقطة الاستلام' : 'عناوين التوصيل'}
    >
      {pickup && (
        <div className="location-mode">
          <button
            type="button"
            aria-pressed={!nearMode}
            onClick={() => {
              sequence.current++;
              setBusy(false);
              setNearMode(false);
              setNearest(null);
              onPoint('');
            }}
          >
            جميع نقاط الاستلام
          </button>
          <button
            type="button"
            aria-pressed={nearMode}
            onClick={() => {
              setNearMode(true);
              setNearest(null);
              onPoint('');
            }}
          >
            اختيار الأقرب
          </button>
        </div>
      )}
      {(!pickup || nearMode) && (
        <>
          <h3>{pickup ? 'اختر الموقع الذي تريد نقاطًا قريبة منه' : 'أين تريد توصيل الطلب؟'}</h3>
          <div className="address-options">
            {[
              ['home', 'البيت', Home],
              ['work', 'العمل', Briefcase],
              ['current', 'موقعك الحالي', LocateFixed],
              ...(!pickup ? [['custom', 'إضافة مخصص', Plus]] : []),
            ].map(([id, text, Icon]) => {
              const Component = Icon as typeof Home;
              return (
                <button
                  type="button"
                  key={id as string}
                  disabled={busy || (!savedReady && (id === 'home' || id === 'work'))}
                  aria-pressed={
                    selected === id || saved.some((a) => a.id === selected && a.label === id)
                  }
                  onClick={() => (id === 'current' ? current() : choose(id as string))}
                >
                  <Component size={20} />
                  <span>{text as string}</span>
                  <small>
                    {id === 'current'
                      ? 'بعد موافقتك'
                      : saved.some((a) => a.label === id)
                        ? 'عنوان محفوظ'
                        : 'تحديد الموقع'}
                  </small>
                </button>
              );
            })}
          </div>
          {!pickup &&
            saved
              .filter((a) => a.label === 'custom')
              .map((a) => (
                <button
                  className="saved-custom"
                  type="button"
                  key={a.id}
                  onClick={() => choose(a.id)}
                  aria-pressed={selected === a.id}
                >
                  <MapPin size={16} />
                  {a.name} · {a.district}
                </button>
              ))}
          {point && (
            <p className="selected-address">
              <MapPin size={16} />{' '}
              {selected === 'current' ? 'تم تحديد موقعك الحالي' : `${name} · ${district}`}
              {details ? ' · ' + details : ''}
            </p>
          )}
          {!editing && point && !pickup && (
            <div className="location-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setMapOpen(true);
                }}
              >
                تعديل أو حفظ الموقع
              </button>
              {saved.some((a) => a.id === selected || a.label === selected) && (
                <button type="button" disabled={busy} onClick={() => void remove()}>
                  حذف العنوان المحفوظ
                </button>
              )}
            </div>
          )}
          {(editing || (!point && !pickup)) && (
            <div className="address-editor">
              <label>
                الحي
                <select
                  value={district}
                  onChange={(e) => {
                    setDistrict(e.target.value);
                    update(point, e.target.value);
                  }}
                >
                  {districts.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                العنوان بالتفصيل
                <input
                  placeholder="الشارع، البناء، الطابق، وعلامة مميزة"
                  maxLength={130}
                  value={details}
                  onChange={(e) => {
                    setDetails(e.target.value);
                    update(point, district, e.target.value);
                  }}
                />
              </label>
              <small>حدد الموقع على الخريطة؛ تفاصيل البناء والطابق تساعد المندوب.</small>
              {!pickup && (
                <>
                  <label>
                    حفظ باسم
                    <select
                      value={label}
                      onChange={(e) => {
                        const l = e.target.value as CustomerAddress['label'];
                        setLabel(l);
                        setName(l === 'home' ? 'البيت' : l === 'work' ? 'العمل' : 'عنوان مخصص');
                      }}
                    >
                      <option value="home">البيت</option>
                      <option value="work">العمل</option>
                      <option value="custom">مخصص</option>
                    </select>
                  </label>
                  <label>
                    اسم العنوان
                    <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                  </label>
                </>
              )}
            </div>
          )}
          {mapOpen && (
            <Suspense fallback={<p>جارٍ تحميل الخريطة…</p>}>
              <AddressMap
                point={point}
                onChange={(p) => {
                  update(p);
                  if (pickup) void rank(p, ++sequence.current);
                }}
              />
            </Suspense>
          )}
          {editing && !pickup && (
            <button
              type="button"
              className="shop-primary"
              disabled={busy || !point || name.trim().length < 2}
              onClick={() => void save()}
            >
              حفظ العنوان
            </button>
          )}
          {nearMode && (
            <p>
              المسافات تقريبية بخط مستقيم. تُعرض حتى خمس نقاط مفتوحة لها موقع محدد؛ الدوام والسعة
              يُراجعان عند تأكيد الطلب.
            </p>
          )}
        </>
      )}
      {busy && <p role="status">جارٍ تحديد الموقع أو تحديث القائمة…</p>}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {pickup && pointsError && <p role="status">{pointsError}</p>}
      {pickup && (
        <>
          {!nearMode && (
            <label>
              نقطة الاستلام
              <select
                aria-label="نقطة الاستلام"
                value={selectedPoint}
                onChange={(e) => onPoint(e.target.value)}
              >
                <option value="">اختر نقطة مفتوحة</option>
                {options.map((p) => (
                  <option value={p.id} key={p.id} disabled={p.openingStatus?.openNow === false}>
                    {p.name} · {p.address} · {p.openingStatus?.label ?? ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="pickup-recommendations">
            {(nearMode ? options : options.filter((p) => p.id === selectedPoint)).map((p) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={selectedPoint === p.id}
                disabled={p.openingStatus?.openNow === false}
                onClick={() => onPoint(p.id)}
              >
                <strong>{p.name}</strong>
                <span>{p.address}</span>
                <small>{p.openingStatus?.label}</small>
                <small>
                  <Star size={14} />{' '}
                  {p.ratingCount
                    ? `${p.rating} / 5 · ${p.ratingCount} تقييم`
                    : 'لا توجد تقييمات بعد'}
                  {p.distanceKm !== undefined ? ` · ${p.distanceKm.toFixed(1)} كم تقريبًا` : ''}
                </small>
              </button>
            ))}
          </div>
          {nearMode && nearest !== null && options.length === 0 && (
            <p role="status">
              لا توجد نقاط مفتوحة محددة الموقع حاليًا. راجع القائمة العامة أو اختر التوصيل إلى
              عنوانك.
            </p>
          )}
        </>
      )}
    </section>
  );
}
