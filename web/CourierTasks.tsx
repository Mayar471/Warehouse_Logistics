import { useEffect, useState } from 'react';
import { Search, Filter, MapPin, ChevronLeft, Clock3 } from 'lucide-react';
import type { Shipment } from '../shared/contracts.js';
import { statusLabels } from '../shared/contracts.js';
import type { CommercialReturn, CommercialReturnView } from '../shared/commercial-returns.js';
import { api } from './api.js';
import { shipmentGuidance } from './shipment-guidance.js';
import { matchesShipmentFilter } from '../shared/shipment-filters.js';
const returnStatus = {
  assigned: 'بانتظار قبول الإرجاع',
  accepted: 'بانتظار تسليم العميل',
  released: 'بانتظار استلام المندوب',
  in_transit: 'إرجاع قيد النقل',
};
export function CourierTasks({
  shipments,
  onShipment,
  onReturn,
  revision,
  shipmentFilter = 'all',
}: {
  shipments: Shipment[];
  onShipment: (id: string) => void;
  onReturn: (id: string) => void;
  revision: number;
  shipmentFilter?: string;
}) {
  const [returns, setReturns] = useState<CommercialReturn[]>([]),
    [total, setTotal] = useState(0),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState(
      shipmentFilter === 'all'
        ? 'all'
        : shipmentFilter === 'shipments'
          ? 'shipment'
          : `shipment:${shipmentFilter}`,
    ),
    [stale, setStale] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let stopped = false,
      inFlight = false;
    async function refresh() {
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const view = await api<CommercialReturnView>('/api/commercial-returns');
        if (!stopped) {
          setReturns(view.rows.filter((r) => r.status in returnStatus));
          setTotal(view.active);
          setLoaded(true);
          setStale(false);
        }
      } catch {
        if (!stopped) setStale(true);
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000),
      wake = () => void refresh();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [revision]);
  const rows = [
    ...shipments.map((s) => ({
      id: s.id,
      kind: 'shipment' as const,
      reference: s.reference,
      merchant: s.merchantName,
      recipient: s.recipientName,
      place: s.destination,
      status: s.status,
      label: statusLabels[s.status],
      updatedAt: s.updatedAt,
      fee: s.feeMinor,
      overdue: s.pickupOverdue,
      next: shipmentGuidance(s).next,
    })),
    ...returns.map((r) => ({
      id: r.id,
      kind: 'return' as const,
      reference: r.shipmentReference,
      merchant: r.merchantName,
      recipient: r.recipientName,
      place: `${r.collectionAddress ?? 'مكان الاستلام'} ← ${r.originName}`,
      status: r.status,
      label: returnStatus[r.status as keyof typeof returnStatus],
      updatedAt: r.updatedAt,
      fee: null,
      overdue: false,
      next:
        r.status === 'assigned'
          ? 'اقبل المهمة خلال مهلة الإسناد'
          : r.status === 'accepted'
            ? 'بانتظار إقرار العميل بتسليم المرتجع'
            : r.status === 'released'
              ? 'أكد استلام المرتجع فعليًا'
              : 'انقل المرتجع إلى منشأ الطلب',
    })),
  ].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      Number(b.status === 'assigned') - Number(a.status === 'assigned') ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const visible = rows.filter(
    (r) =>
      ((filter === 'all' &&
        !(r.kind === 'shipment' && ['delivered', 'returned', 'cancelled'].includes(r.status))) ||
        filter === 'history' ||
        filter === r.kind ||
        filter === `${r.kind}:${r.status}` ||
        (r.kind === 'shipment' &&
          filter.startsWith('shipment:') &&
          matchesShipmentFilter(
            shipments.find((s) => s.id === r.id)!,
            filter.slice(9),
          ))) &&
      `${r.reference} ${r.merchant} ${r.recipient} ${r.place}`.includes(search),
  );
  const open = (r: (typeof rows)[number]) =>
    r.kind === 'return' ? onReturn(r.id) : onShipment(r.id);
  return (
    <section className="panel shipments-panel courier-tasks" aria-label="قائمة مهام المندوب">
      <div className="panel-title">
        <div>
          <h2>مهامك الحالية</h2>
          <p>المهام المتأخرة والتي تنتظر القبول أولًا، ثم بقية مهام التوصيل والإرجاع.</p>
        </div>
        <span className="subtle-chip">{shipments.length + total} مهمة</span>
      </div>
      <div className="table-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            aria-label="البحث في مهام المندوب"
            placeholder="ابحث عن مهمة، عميل، متجر أو مكان…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-control">
          <Filter size={16} />
          <select
            aria-label="تصفية مهام المندوب"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">كل المهام النشطة</option>
            <option value="history">المهام وسجل المكتمل</option>
            <option value="shipment">مهام التوصيل</option>
            <option value="shipment:active">توصيلات قيد التنفيذ</option>
            <option value="shipment:attention">توصيلات تحتاج متابعة</option>
            <option value="return">استلام المرتجعات</option>
            <optgroup label="حالات التوصيل">
              {Object.entries(statusLabels).map(([status, label]) => (
                <option key={status} value={`shipment:${status}`}>
                  {label}
                </option>
              ))}
            </optgroup>
            <optgroup label="حالات الإرجاع">
              {Object.entries(returnStatus).map(([status, label]) => (
                <option key={status} value={`return:${status}`}>
                  {label}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>
      {stale && (
        <p role="alert" className="alert">
          تعذر تحديث مهام الإرجاع؛ تعرض القائمة آخر قراءة ناجحة.
        </p>
      )}
      {!loaded && !stale && (
        <p className="scope-note" role="status">
          جارٍ تحديث مهام الإرجاع…
        </p>
      )}
      {visible.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>المهمة</th>
                <th>العميل والمسار</th>
                <th>الحالة</th>
                <th>الإجراء التالي</th>
                <th>رسوم الخدمة</th>
                <th>آخر تحديث</th>
                <th>التفاصيل</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={`${r.kind}:${r.id}`}
                  className={r.kind === 'return' ? 'courier-return-row' : ''}
                  onClick={() => open(r)}
                >
                  <td>
                    <button
                      className="reference-button"
                      aria-label={r.kind === 'return' ? `تفاصيل إرجاع ${r.reference}` : r.reference}
                      dir="ltr"
                      onClick={(e) => {
                        e.stopPropagation();
                        open(r);
                      }}
                    >
                      {r.reference}
                    </button>
                    <small>
                      <span className="task-kind">
                        {r.kind === 'return' ? 'استلام مرتجع' : 'توصيل'}
                      </span>{' '}
                      · {r.merchant}
                    </small>
                  </td>
                  <td>
                    <strong>{r.recipient}</strong>
                    <small>
                      <MapPin size={11} />
                      {r.place}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`status ${r.kind === 'return' ? 'status-assigned' : `status-${r.status}`}`}
                    >
                      <span />
                      {r.label}
                    </span>
                    {r.overdue && (
                      <small className="pickup-late-label">
                        <Clock3 size={12} />
                        تأخر الاستلام من المنشأ
                      </small>
                    )}
                  </td>
                  <td>
                    <small>{r.next}</small>
                  </td>
                  <td className="money">
                    {r.fee === null ? (
                      <small>رسوم الإرجاع غير محددة</small>
                    ) : (
                      new Intl.NumberFormat('ar-SY').format(r.fee / 100) + ' ل.س'
                    )}
                  </td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString('ar-SY')}</td>
                  <td>
                    <button
                      className="button secondary task-open"
                      aria-label={`فتح ${r.kind === 'return' ? 'إرجاع' : 'توصيل'} ${r.reference}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        open(r);
                      }}
                    >
                      متابعة المهمة <ChevronLeft size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="scope-note">
          {search || filter !== 'all'
            ? 'لا توجد مهام تطابق البحث والتصفية.'
            : 'لا توجد مهام ظاهرة لهذا الحساب.'}
        </p>
      )}
      <div className="table-footer">
        <span>
          عرض {visible.length} من {shipments.length + total} مهمة · حتى 100 شحنة و50 مرتجعًا
        </span>
        <span>تتحدث مهام الإرجاع تلقائيًا كل 5 ثوانٍ</span>
      </div>
    </section>
  );
}
