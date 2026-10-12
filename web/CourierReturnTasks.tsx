import { useEffect, useState } from 'react';
import { Package, ArrowLeft, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import type { CommercialReturnView } from '../shared/commercial-returns.js';

export function CourierReturnTasks({ onOpen }: { onOpen: () => void }) {
  const [active, setActive] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    async function refresh() {
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const next = await api<CommercialReturnView>('/api/commercial-returns');
        if (!stopped) {
          setActive(next.active);
          setStale(false);
        }
      } catch {
        if (!stopped) setStale(true);
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [revision]);
  return (
    <section className="panel courier-return-tasks" aria-label="مهام إرجاع المندوب">
      <div className="courier-return-copy">
        <span className="courier-return-icon" aria-hidden="true">
          <Package size={24} />
        </span>
        <div>
          <h2>مهام استلام المرتجعات</h2>
          <p role="status">
            {active === null
              ? 'جارٍ قراءة مهام الإرجاع…'
              : active > 0
                ? `${new Intl.NumberFormat('ar-SY').format(active)} مهمة إرجاع مسندة إليك قيد التنفيذ`
                : 'لا توجد مهام إرجاع نشطة مسندة إليك حاليًا.'}
          </p>
          <small>
            افتح المهام لقبول الإسناد الجديد خلال مهلة القبول، ثم تابع الاستلام والعهدة.
          </small>
          {stale && (
            <p className="alert" role="alert">
              تعذر تحديث مهام الإرجاع؛ العدد الظاهر آخر قراءة ناجحة.
            </p>
          )}
        </div>
      </div>
      <div className="button-row">
        <button className="button primary" onClick={onOpen}>
          فتح مهام المرتجعات <ArrowLeft size={17} />
        </button>
        {stale && (
          <button
            className="button secondary"
            aria-label="إعادة تحديث مهام الإرجاع"
            onClick={() => setRevision((x) => x + 1)}
          >
            <RefreshCw size={17} />
          </button>
        )}
      </div>
    </section>
  );
}
