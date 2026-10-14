import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Coordinates } from '../shared/customer-locations.js';
const AddressMap = lazy(() => import('./AddressMap.js'));
export function PartnerLocation({
  point,
  onChange,
}: {
  point: Coordinates | null;
  onChange: (point: Coordinates) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  function locate() {
    const current = ++sequence.current;
    if (!navigator.geolocation) {
      setError('الموقع غير متاح؛ اختر المكان على الخريطة.');
      return;
    }
    setBusy(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (current !== sequence.current) return;
        setBusy(false);
        onChange({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        if (position.coords.accuracy > 250) setError('دقة الموقع منخفضة؛ راجع دبوس الخريطة.');
      },
      () => {
        if (current !== sequence.current) return;
        setBusy(false);
        setError('تعذر تحديد الموقع؛ اختر المكان على الخريطة.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }
  return (
    <div className="partner-location">
      <button type="button" className="button secondary" disabled={busy} onClick={locate}>
        {busy ? 'جارٍ تحديد الموقع…' : 'موقعي الحالي'}
      </button>
      <p className="scope-note">اختر الموقع على الخريطة، أو اسمح للمتصفح بتحديد موقعك الحالي.</p>
      {error && <p role="status">{error}</p>}
      <Suspense fallback={<p>جارٍ تحميل الخريطة…</p>}>
        <AddressMap
          point={point}
          onChange={(p) => {
            sequence.current++;
            setBusy(false);
            onChange(p);
          }}
        />
      </Suspense>
      <p role="status" className="scope-note">
        {point ? 'تم تحديد الموقع؛ يمكنك تعديل الدبوس.' : 'لم يُحدد الموقع بعد.'}
      </p>
    </div>
  );
}
