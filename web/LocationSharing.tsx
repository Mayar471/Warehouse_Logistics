import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { MapPin, Navigation, ShieldCheck, Square } from 'lucide-react';
import type { Shipment, Role } from '../shared/contracts.js';
import type { LocationView } from '../shared/location.js';
import { api, ApiError, key } from './api.js';
import './location.css';
const CourierMap = lazy(() => import('./CourierMap.js'));
const messages = {
  unavailable: 'الموقع متاح خلال التوصيل فقط.',
  off: 'المندوب لا يشارك موقعه حاليًا.',
  waiting: 'المشاركة مفعّلة؛ بانتظار قراءة موقع حديثة.',
  stale: 'آخر قراءة أصبحت قديمة. أُخفي الموقع حتى يصل تحديث حديث.',
  live: 'موقع مشارك حديث',
};
export function LocationSharing({
  shipment,
  role = 'customer',
}: {
  shipment: Shipment;
  role?: Role | 'customer';
}) {
  const [opened, setOpened] = useState(role === 'courier');
  return (
    <section className="location-shell">
      <div className="location-heading">
        <div>
          <span className="location-eyebrow">متابعة آمنة للرحلة</span>
          <h3>
            <MapPin size={19} />
            موقع المندوب
          </h3>
        </div>
        <button type="button" className="location-link" onClick={() => setOpened((v) => !v)}>
          {opened ? 'إغلاق عرض الموقع' : 'عرض موقع المندوب'}
        </button>
      </div>
      {opened && <LocationPanel key={shipment.id + role} shipment={shipment} role={role} />}
    </section>
  );
}
function LocationPanel({ shipment, role }: { shipment: Shipment; role: Role | 'customer' }) {
  const endpoint =
    role === 'customer'
      ? `/api/storefront/orders/${shipment.id}/location`
      : `/api/shipments/${shipment.id}/location`;
  const [view, setView] = useState<LocationView | null>(null),
    [error, setError] = useState(''),
    [consent, setConsent] = useState(false),
    [customerAllowed, setCustomerAllowed] = useState(true),
    [busy, setBusy] = useState(false),
    [watching, setWatching] = useState(false),
    [geoError, setGeoError] = useState(''),
    [tick, setTick] = useState(0);
  const watch = useRef<number | null>(null),
    mounted = useRef(true),
    visible = useRef(!document.hidden),
    readEpoch = useRef(0),
    reading = useRef(false),
    receipt = useRef(performance.now()),
    current = useRef<LocationView | null>(null),
    nextSequence = useRef(1),
    sending = useRef(false),
    lastSent = useRef(0),
    lastPoint = useRef<GeolocationPosition | null>(null),
    command = useRef<{ body: string; key: string } | null>(null),
    pointPending = useRef<Record<string, unknown> | null>(null),
    runningSession = useRef<string | null>(null);
  function clearWatch() {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    runningSession.current = null;
    if (mounted.current) setWatching(false);
  }
  async function read() {
    if (reading.current || !visible.current) return;
    reading.current = true;
    const epoch = readEpoch.current;
    const startedAt = performance.now();
    try {
      const result = await api<LocationView>(endpoint);
      if (!mounted.current || epoch !== readEpoch.current) return;
      receipt.current = startedAt;
      current.current = result;
      setView(result);
      setError('');
      if (
        runningSession.current &&
        (!result.session || result.session.id !== runningSession.current || !result.canShare)
      )
        clearWatch();
    } catch (e) {
      if (mounted.current && epoch === readEpoch.current) {
        current.current = null;
        setView(null);
        setError(e instanceof Error ? e.message : 'تعذر تحديث الموقع');
      }
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await read();
      if (mounted.current) timer = setTimeout(poll, 10_000);
    };
    void poll();
    const changed = () => {
      visible.current = !document.hidden;
      readEpoch.current++;
      current.current = null;
      setView(null);
      if (document.hidden) clearWatch();
      else void read();
    };
    document.addEventListener('visibilitychange', changed);
    const interval = setInterval(() => setTick((v) => v + 1), 1000);
    return () => {
      mounted.current = false;
      readEpoch.current++;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', changed);
      clearWatch();
    };
  }, [endpoint]);
  void tick;
  const elapsed = performance.now() - receipt.current;
  const point =
    !command.current &&
    view?.point &&
    new Date(view.point.validUntil).getTime() - new Date(view.serverTime).getTime() > elapsed
      ? view.point
      : null;
  const state = view?.state === 'live' && !point ? 'stale' : view?.state;
  function geoMessage(error: GeolocationPositionError) {
    return error.code === 1
      ? 'لم تسمح بمشاركة موقع الجهاز. فعّل إذن الموقع من المتصفح ثم حاول مجددًا.'
      : error.code === 2
        ? 'تعذر تحديد موقع الجهاز. تحقق من GPS والاتصال.'
        : 'انتهت مهلة تحديد الموقع. حاول من مكان يسمح باستقبال GPS.';
  }
  async function send(p: GeolocationPosition) {
    const session = current.current?.session;
    if (!session || !visible.current || sending.current || runningSession.current !== session.id)
      return;
    if (
      !pointPending.current &&
      (Date.now() - lastSent.current < 10_000 || p.timestamp <= lastSent.current)
    )
      return;
    sending.current = true;
    const payload = pointPending.current ?? {
      sessionId: session.id,
      sequence: nextSequence.current,
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
      measuredAt: new Date(p.timestamp).toISOString(),
    };
    pointPending.current = payload;
    try {
      const ack = await api<{ sequence: number }>(endpoint + '/points', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!mounted.current || runningSession.current !== session.id) return;
      nextSequence.current = ack.sequence + 1;
      pointPending.current = null;
      lastSent.current = Date.now();
      setGeoError('');
      void read();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status < 500) {
        pointPending.current = null;
        if (['SHARING_ENDED', 'POINT_OUT_OF_ORDER', 'POINT_CONFLICT'].includes(e.code)) {
          clearWatch();
          void read();
        }
      }
      setGeoError(
        e instanceof Error ? e.message : 'تعذر إرسال الموقع؛ سنعيد القراءة أثناء فتح الصفحة.',
      );
    } finally {
      sending.current = false;
    }
  }
  function startWatch() {
    const session = current.current?.session;
    if (!session || !navigator.geolocation) return;
    clearWatch();
    runningSession.current = session.id;
    nextSequence.current = session.nextSequence;
    pointPending.current = null;
    lastSent.current = 0;
    setWatching(true);
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        lastPoint.current = p;
        void send(p);
      },
      (e) => {
        setGeoError(geoMessage(e));
        clearWatch();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }
  useEffect(() => {
    const timer = setInterval(() => {
      if (lastPoint.current && runningSession.current) void send(lastPoint.current);
    }, 10_000);
    return () => clearInterval(timer);
  }, []);
  async function change(action: 'start' | 'stop') {
    if (busy) return;
    if (action === 'stop') {
      readEpoch.current++;
      setConsent(false);
      clearWatch();
      current.current = null;
      setView(null);
    }
    if (!command.current) {
      if (action === 'start' && !consent) {
        setError('وافق على المشاركة قبل تفعيلها.');
        return;
      }
      if (action === 'start' && (!navigator.geolocation || !window.isSecureContext)) {
        setError('تحديد الموقع يحتاج اتصال HTTPS أو تشغيلًا محليًا ومتصفحًا يدعم GPS.');
        return;
      }
      command.current = {
        key: key(),
        body: JSON.stringify(
          action === 'start'
            ? { action, expectedVersion: shipment.version, consent: true, customerAllowed }
            : { action, sessionId: view?.session?.id, reason: 'إيقاف مشاركة الموقع من الواجهة' },
        ),
      };
    }
    setBusy(true);
    setError('');
    try {
      await api(endpoint + '/sharing', {
        method: 'POST',
        body: command.current.body,
        headers: { 'idempotency-key': command.current.key },
      });
      readEpoch.current++;
      const startedAt = performance.now();
      const result = await api<LocationView>(endpoint);
      if (!mounted.current) return;
      command.current = null;
      receipt.current = startedAt;
      current.current = result;
      setView(result);
      if (action === 'start') startWatch();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        command.current = null;
        void read();
      }
      setError(
        e instanceof Error ? e.message : 'تعذر تأكيد المشاركة. أعد نفس الإجراء دون تغيير الحقول.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const pending = !!command.current;
  const activeSession =
    view?.session &&
    new Date(view.session.expiresAt).getTime() - new Date(view.serverTime).getTime() > elapsed;
  return (
    <div className="location-panel">
      <div className={`location-state ${point ? 'live' : ''}`}>
        <span className="location-dot" />
        {state ? messages[state] : 'جارٍ التحقق من المشاركة…'}
      </div>
      {point ? (
        <>
          <Suspense fallback={<p>جارٍ تحميل الخريطة…</p>}>
            <CourierMap point={point} />
          </Suspense>
          <div className="location-metrics">
            <span>
              آخر قراءة <strong>{new Date(point.measuredAt).toLocaleTimeString('ar-SY')}</strong>
            </span>
            <span>
              دقة الجهاز <strong>± {Math.round(point.accuracy)} متر</strong>
            </span>
          </div>
          {point.accuracy > 200 && (
            <p className="location-note">دقة الموقع منخفضة؛ الدائرة توضح نطاق الخطأ التقريبي.</p>
          )}
        </>
      ) : (
        <div className="location-empty">
          <Navigation size={30} />
          <p>
            {error
              ? 'تعذر التحقق من الموقع؛ أُخفيت القراءة السابقة.'
              : state
                ? messages[state]
                : 'انتظر قليلًا'}
          </p>
        </div>
      )}
      {error && (
        <p className="location-error" role="alert">
          {error}
        </p>
      )}
      {role === 'courier' && view?.canShare && (
        <div className="location-controls">
          {!activeSession ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy || pending}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                أوافق على مشاركة موقعي للمتجر والعمليات أثناء توصيل هذه الشحنة لمدة 30 دقيقة.
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={customerAllowed}
                  disabled={busy || pending}
                  onChange={(e) => setCustomerAllowed(e.target.checked)}
                />
                السماح لصاحب الطلب بمشاهدة الموقع أيضًا.
              </label>
              <button
                type="button"
                className="location-primary"
                disabled={busy || pending || !consent}
                onClick={() => void change('start')}
              >
                <ShieldCheck size={17} />
                {busy ? 'جارٍ التفعيل…' : 'تفعيل مشاركة الموقع'}
              </button>
            </>
          ) : (
            <>
              <p>
                {watching
                  ? 'إرسال موقع الجهاز مفعّل أثناء فتح هذه الصفحة.'
                  : 'المشاركة مفعّلة؛ إرسال موقع الجهاز متوقف في هذه الصفحة.'}
              </p>
              <p>
                تنتهي المشاركة عند {new Date(view.session!.expiresAt).toLocaleTimeString('ar-SY')}{' '}
                أو عند انتهاء التوصيل.
              </p>
              {!watching && (
                <button
                  className="location-primary"
                  type="button"
                  disabled={busy || pending}
                  onClick={startWatch}
                >
                  استئناف إرسال موقع الجهاز
                </button>
              )}
              <button
                type="button"
                className="location-stop"
                disabled={busy || pending}
                onClick={() => void change('stop')}
              >
                <Square size={15} />
                {busy ? 'جارٍ الإيقاف…' : 'إيقاف المشاركة'}
              </button>
            </>
          )}
          {geoError && (
            <p className="location-error" role="alert">
              {geoError}
            </p>
          )}
        </div>
      )}
      {role === 'operator' && activeSession && (
        <button
          type="button"
          className="location-stop"
          disabled={busy || pending}
          onClick={() => void change('stop')}
        >
          إيقاف مشاركة هذه الشحنة
        </button>
      )}
      {pending && (
        <button
          type="button"
          className="location-primary"
          disabled={busy}
          onClick={() => void change(JSON.parse(command.current!.body).action)}
        >
          إعادة تأكيد إجراء المشاركة
        </button>
      )}
      <p className="location-note">
        الموقع قراءة من جهاز المندوب، وليس مسارًا أو موعد وصول محسوبًا. عرض الخريطة يستخدم خدمة
        OpenStreetMap خارجية. تحديث المتصفح يعمل أثناء فتح الصفحة؛ إغلاقها أو إخفاؤها يوقف الإرسال.
      </p>
    </div>
  );
}
