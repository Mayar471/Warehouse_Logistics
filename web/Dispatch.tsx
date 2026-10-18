import { useEffect, useRef, useState } from 'react';
import type { DispatchPreview } from '../shared/dispatch.js';
import { api, ApiError, key } from './api.js';

export function DispatchLocation() {
  const mounted = useRef(true);
  const [state, setState] = useState<{
    active: boolean;
    expiresAt: string | null;
    routingProvider?: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = () => api<NonNullable<typeof state>>('/api/dispatch/location').then(setState);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'visible')
        void api<NonNullable<typeof state>>('/api/dispatch/location')
          .then((s) => {
            if (alive) setState(s);
          })
          .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  async function share() {
    setBusy(true);
    setError('');
    try {
      if (!navigator.geolocation) throw new Error('المتصفح لا يدعم تحديد الموقع');
      const p = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20_000,
        }),
      );
      if (!mounted.current) return;
      if (p.coords.accuracy > 200)
        throw new Error('دقة الموقع ضعيفة. اقترب من مكان مفتوح وحاول مجددًا');
      const result = await api<NonNullable<typeof state>>('/api/dispatch/location', {
        method: 'POST',
        body: JSON.stringify({
          action: 'share',
          consent: true,
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          measuredAt: new Date(p.timestamp).toISOString(),
        }),
      });
      setState((previous) => ({ ...previous, ...result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'اسمح بالوصول للموقع أو حاول مجددًا');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError('');
    try {
      setState(
        await api('/api/dispatch/location', {
          method: 'POST',
          body: JSON.stringify({ action: 'revoke' }),
        }),
      );
    } catch {
      setError('تعذر تأكيد إيقاف المشاركة؛ أعد المحاولة');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel dispatch-panel" aria-label="موقع الترشيح">
      <div>
        <h2>موقعك لترشيح المهام</h2>
        <p>
          بموافقتك، يستخدم النظام موقعك الحالي لترشيح مهام قريبة لمدة ٥ دقائق. لا يظهر هذا الموقع
          للعميل. حدّثه عندما تنتقل؛ هذه ليست مشاركة تتبع مستمرة.
        </p>
        <p>
          قد يُرسل موقعك إلى خدمة الطرق المعتمدة لحساب الوصول إلى الاستلام. الخدمة الحالية:{' '}
          {state?.routingProvider ?? 'غير مفعلة'}. لا تُرسل بيانات اسمك أو العميل أو رقم الطلب معها.
        </p>
        <p role="status">
          {state?.active
            ? `المشاركة فعالة حتى ${new Date(state.expiresAt!).toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' })}`
            : 'موقع الترشيح غير مشارك؛ يمكنك متابعة مهامك الحالية.'}
        </p>
      </div>
      <div className="button-row">
        <button className="button primary" disabled={busy} onClick={() => void share()}>
          {busy ? 'جارٍ التنفيذ…' : state?.active ? 'تحديث موقعي بموافقتي' : 'مشاركة موقعي للترشيح'}
        </button>
        {state?.active && (
          <button className="button secondary" disabled={busy} onClick={() => void revoke()}>
            إيقاف المشاركة
          </button>
        )}
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function DispatchAssignment({
  id,
  version,
  onAssigned,
  onLock,
  disabled,
}: {
  id: string;
  version: number;
  onAssigned: () => Promise<void>;
  onLock: (locked: boolean) => void;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState<DispatchPreview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ body: string; key: string } | null>(null);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setPreview(await api(`/api/shipments/${id}/dispatch`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر الترشيح');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [id, version]);
  async function assign() {
    if (!preview?.candidates[0] && !pending.current) return;
    setBusy(true);
    onLock(true);
    setError('');
    pending.current ??= {
      key: key(),
      body: JSON.stringify({
        expectedVersion: preview!.shipmentVersion,
        token: preview!.token,
        courierId: preview!.candidates[0].id,
      }),
    };
    try {
      await api(`/api/shipments/${id}/dispatch`, {
        method: 'POST',
        headers: { 'idempotency-key': pending.current.key },
        body: pending.current.body,
      });
      pending.current = null;
      setUncertain(false);
      await onAssigned();
    } catch (e) {
      if (!pending.current) {
        setPreview(null);
        setError('تم حفظ الإسناد. أعد فتح الشحنة لتحديث العرض.');
      } else if (!(e instanceof ApiError) || e.status >= 500) {
        setUncertain(true);
        setError('لم نتأكد من النتيجة. أعد التأكيد نفسه لاستعادتها دون تكرار الإسناد.');
      } else {
        pending.current = null;
        setUncertain(false);
        setPreview(null);
        setError(e.message);
      }
    } finally {
      setBusy(false);
      onLock(!!pending.current);
    }
  }
  return (
    <section className="dispatch-panel dispatch-recommendation" aria-label="ترشيح المندوب">
      <h3>ترشيح المندوب · {preview?.priority === 'urgent' ? 'طلب مستعجل' : 'طلب عادي'}</h3>
      <p>
        {preview?.priority === 'urgent'
          ? preview?.method === 'road'
            ? 'الأقل زمن طريق أولًا ضمن القائمة المفحوصة، ثم الأقل انشغالًا.'
            : 'الأقرب أولًا، ثم الأقل انشغالًا.'
          : 'الأقل إشغالًا للسعة، ثم الأقل مهامًا، ثم القرب أو زمن الطريق المتاح.'}{' '}
        تُحسب مهام الشحن والنقل والمرتجعات. الترشيح يحتاج موقعًا حديثًا ودقيقًا ضمن ٣٠ كم من
        الاستلام.
      </p>
      <p role="status">
        {preview?.routing?.note ?? 'جارٍ تحميل حالة خدمة الطرق…'} يُعاد التحقق عند التأكيد.
      </p>
      {preview?.spatial && (
        <details>
          <summary>نطاق المقارنة</summary>
          <p>
            فُحص {preview.spatial.scannedCouriers} من {preview.spatial.totalCouriers} مندوب باستخدام{' '}
            {preview.spatial.index === 'h3' ? 'فهرس H3' : 'البحث الكامل'}؛ ثم تحقق النظام من المسافة
            والسعة والموقع.{' '}
            {preview.routing?.state === 'available' &&
              `حُسب الطريق لـ${preview.routing.evaluated}؛ خارج القائمة المفحوصة: ${preview.routing.notEvaluated}؛ لا يوجد طريق: ${preview.routing.unreachable}.`}
          </p>
        </details>
      )}
      {preview?.blocked && <p role="status">{preview.blocked}</p>}
      {preview && !preview.blocked && !preview.candidates.length && (
        <p role="status">لا يوجد مندوب مؤهل حاليًا. تحقق من التوفر والسعة ومشاركة موقع حديث.</p>
      )}
      {!!preview?.candidates.length && (
        <ol className="dispatch-candidates">
          {preview.candidates.slice(0, 5).map((c, i) => (
            <li key={c.id}>
              <strong>
                {i === 0 ? 'المرشح الأول: ' : ''}
                {c.name}
              </strong>
              {preview.method === 'road' && (
                <span className="dispatch-priority">
                  نحو {Math.ceil(c.durationSeconds! / 60)} دقيقة للوصول إلى الاستلام · طريق{' '}
                  {c.roadDistanceKm!.toFixed(1)} كم · {preview.routing?.provider}
                </span>
              )}
              <span>
                مسافة مستقيمة {c.distanceKm.toFixed(1)} كم تقريبًا · سعة حرة {c.freeKg.toFixed(1)}{' '}
                كغ · {c.jobs} مهام · إشغال {Math.round(c.utilization * 100)}٪
              </span>
            </li>
          ))}
        </ol>
      )}
      {preview && Object.entries(preview.excluded).length > 0 && (
        <details>
          <summary>أسباب استبعاد المناديب</summary>
          {Object.entries(preview.excluded).map(([r, n]) => (
            <p key={r}>
              {r}: {n}
            </p>
          ))}
        </details>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          className="button primary"
          disabled={disabled || busy || (!uncertain && !preview?.candidates.length)}
          onClick={() => void assign()}
        >
          {uncertain ? 'استعادة نتيجة الإسناد' : 'إسناد إلى المرشح الأول'}
        </button>
        <button
          className="button secondary"
          disabled={disabled || busy || uncertain}
          onClick={() => void refresh()}
        >
          تحديث الترشيح
        </button>
      </div>
    </section>
  );
}
