import { useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { api, key } from './api.js';
import type { StoreOrder } from '../shared/catalog.js';
export function ServiceRatings({
  order,
  onChanged,
}: {
  order: StoreOrder;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [scores, setScores] = useState<Record<string, number>>({}),
    [saved, setSaved] = useState(order.ratings ?? []);
  const pending = useRef<{ body: string; key: string } | null>(null),
    sending = useRef(false);
  if (order.shipment.status !== 'delivered') return null;
  async function submit(kind: 'courier' | 'pickup') {
    if (sending.current || !scores[kind]) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const body = JSON.stringify({ kind, score: scores[kind] });
    if (pending.current?.body !== body) pending.current = { body, key: key() };
    try {
      await api(`/api/storefront/orders/${order.shipment.id}/ratings`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': pending.current.key },
      });
      setSaved((s) => [...s, { kind, score: scores[kind], comment: '' }]);
      pending.current = null;
      try {
        await onChanged();
      } catch {
        setError('حُفظ تقييمك؛ تعذر تحديث عرض الطلب.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      sending.current = false;
    }
  }
  return (
    <section className="service-ratings" aria-label="تقييم تجربة الاستلام">
      <h3>كيف كانت تجربة الاستلام؟</h3>
      <p>تقييمك مرتبط بهذا الطلب بعد تأكيد استلامه.</p>
      {(['courier', 'pickup'] as const)
        .filter((kind) =>
          kind === 'courier'
            ? !!(order.shipment.deliveryCourier?.id ?? order.shipment.courierId)
            : !!order.shipment.pickupSiteId,
        )
        .map((kind) => {
          const rating = saved.find((r) => r.kind === kind);
          return (
            <div key={kind}>
              <strong>
                {kind === 'courier'
                  ? `تقييم المندوب · ${order.shipment.deliveryCourier?.name ?? order.shipment.courierName}`
                  : 'تقييم نقطة الاستلام'}
              </strong>
              {rating ? (
                <p>شكرًا لتقييمك · {rating.score} / 5</p>
              ) : (
                <>
                  <div
                    className="rating-stars"
                    role="group"
                    aria-label={kind === 'courier' ? 'نجوم المندوب' : 'نجوم نقطة الاستلام'}
                  >
                    {[1, 2, 3, 4, 5].map((score) => (
                      <button
                        type="button"
                        key={score}
                        disabled={busy}
                        aria-label={`${score} من 5`}
                        aria-pressed={scores[kind] === score}
                        onClick={() => setScores((s) => ({ ...s, [kind]: score }))}
                      >
                        <Star fill={score <= (scores[kind] ?? 0) ? 'currentColor' : 'none'} />
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="shop-secondary"
                    disabled={busy || !scores[kind]}
                    onClick={() => void submit(kind)}
                  >
                    إرسال تقييم {kind === 'courier' ? 'المندوب' : 'النقطة'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
