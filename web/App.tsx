import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CommercialReturns } from './CommercialReturns.js';
import { CourierTasks } from './CourierTasks.js';
import { Inventory } from './Inventory.js';
import { InventoryTransfers } from './InventoryTransfers.js';
import { FinancialNotice } from './FinancialRecovery.js';
import { Cash, parseCash, cashMoney } from './Cash.js';
import { Payouts } from './Payouts.js';
import { LocationSharing } from './LocationSharing.js';
import { catalog } from '../shared/catalog.js';
import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpLeft,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Filter,
  Globe2,
  LayoutDashboard,
  LoaderCircle,
  MapPin,
  Menu,
  MoreHorizontal,
  Package,
  Plus,
  Radio,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  Store,
  Truck,
  Users,
  Waypoints,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { api, ApiError, key } from './api.js';
import {
  statusLabels,
  type Account,
  type Action,
  type Bootstrap,
  type IntegrationState,
  type OutboxEvent,
  type Reconciliation,
  type Quote,
  type Shipment,
  type ShipmentInput,
  type ShipmentStatus,
  type TimelineEvent,
  type Site,
} from '../shared/contracts.js';

const fmt = new Intl.NumberFormat('ar-SY');
const date = (s: string) =>
  new Intl.DateTimeFormat('ar-SY', { hour: '2-digit', minute: '2-digit' }).format(new Date(s));
const money = (minor: number) => fmt.format(minor / 100) + ' ل.س';
const navItems = [
  { id: 'overview', label: 'نظرة عامة', icon: LayoutDashboard },
  { id: 'shipments', label: 'الشحنات', icon: Package },
  { id: 'network', label: 'شبكة الشركاء', icon: Waypoints },
  { id: 'inventory', label: 'المخزون والتجهيز', icon: Box },
  { id: 'transfers', label: 'النقل بين المواقع', icon: Truck },
  { id: 'returns', label: 'مرتجعات العملاء', icon: Package },
  { id: 'cash', label: 'التحصيل وعهدة النقد', icon: ShieldCheck },
  { id: 'payouts', label: 'مستحقات المتاجر', icon: ShieldCheck },
  { id: 'integration', label: 'مختبر التكامل', icon: Activity },
];
const labels: Record<string, string> = {
  overview: 'مركز العمليات',
  shipments: 'إدارة الشحنات',
  network: 'شبكة الشركاء',
  inventory: 'المخزون والتجهيز',
  transfers: 'النقل بين المواقع',
  returns: 'مرتجعات العملاء',
  cash: 'التحصيل وعهدة النقد',
  payouts: 'مستحقات المتاجر',
  integration: 'مختبر التكامل',
};
const eventLabels: Record<string, string> = {
  commercial_return_received: 'استلام إرجاع العميل وعزله',
  prepare: 'تجهيز الطرد',
  handover_origin: 'تسليم من المنشأ',
  pickup_overdue: 'تأخر الاستلام من المنشأ',
  reservation_expired: 'انتهاء حجز المخزون',
  inventory_inspected: 'فحص المرتجع',
  created: 'إنشاء الطلب',
  assign: 'إسناد المهمة',
  accept: 'قبول المهمة',
  decline: 'رفض المهمة',
  unassign: 'تحرير الإسناد',
  assignment_expired: 'انتهاء مهلة الإسناد',
  snapshot: 'مطابقة حالة الشحنة',
  pickup: 'استلام الطرد',
  depart: 'بدء التوصيل',
  deliver: 'التسليم',
  fail: 'تعذر التسليم',
  cancel: 'الإلغاء',
  return: 'بدء الإرجاع',
  arrive_pickup: 'الوصول إلى نقطة الاستلام',
  receive_pickup: 'استلام عهدة النقطة',
  release_pickup: 'التسليم للعميل',
  assign_return: 'إسناد الإرجاع',
  handover_return: 'تسليم عهدة الإرجاع',
  pickup_expired: 'انتهاء مهلة الاستلام',
  receive_return: 'استلام المرتجع',
  seeded: 'حالة العرض الابتدائية',
};

function Status({ status }: { status: ShipmentStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}
function RouteMap({ shipments }: { shipments: Shipment[] }) {
  const active = shipments.filter((s) =>
    ['assigned', 'picked_up', 'in_transit', 'returning'].includes(s.status),
  );
  return (
    <div className="route-map">
      <svg viewBox="0 0 740 270" role="img" aria-label="مخطط توضيحي لمراحل النقل في دمشق">
        <defs>
          <pattern
            id="blocks"
            width="94"
            height="70"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-17)"
          >
            <rect x="6" y="6" width="80" height="55" rx="7" fill="#e8edeb" />
            <path d="M0 0H94M0 0V70" stroke="#fff" strokeWidth="9" />
          </pattern>
          <linearGradient id="river">
            <stop stopColor="#9ed5d8" />
            <stop offset="1" stopColor="#d6eaea" />
          </linearGradient>
        </defs>
        <rect width="740" height="270" fill="#f2f5f2" />
        <rect width="740" height="270" fill="url(#blocks)" />
        <path
          d="M-20 224C170 176 160 139 326 132S540 50 760 38"
          stroke="url(#river)"
          strokeWidth="13"
          fill="none"
        />
        <path
          d="M-30 92L190 110L277 170L540 181L770 226M133 -10L175 66L180 200L195 280M422 -10L388 55L457 157L467 285M-10 247L225 204L491 78L765 82"
          stroke="white"
          strokeWidth="13"
          fill="none"
        />
        <rect x="274" y="28" width="92" height="47" rx="20" fill="#d6e6d9" />
        <rect x="520" y="203" width="85" height="54" rx="18" fill="#d6e6d9" />
        <text x="350" y="104" fill="#8e9e96" fontSize="15">
          الروضة
        </text>
        <text x="99" y="180" fill="#8e9e96" fontSize="15">
          المزة
        </text>
        <text x="590" y="131" fill="#8e9e96" fontSize="15">
          الصالحية
        </text>
        <path
          d="M185 176L278 169L390 116L481 95L566 95"
          fill="none"
          stroke="#168d80"
          strokeWidth="4"
          strokeDasharray="7 7"
        />
        <circle cx="185" cy="176" r="11" fill="#fff" stroke="#168d80" strokeWidth="4" />
        <circle cx="566" cy="95" r="11" fill="#fff" stroke="#168d80" strokeWidth="4" />
        <g transform="translate(376 122)">
          <circle r="23" fill="#0f6964" opacity=".13" />
          <circle r="14" fill="#0d7169" stroke="#fff" strokeWidth="4" />
          <path d="M-5 -1H5M1 -5L5 -1L1 3" stroke="white" strokeWidth="2" fill="none" />
        </g>
      </svg>
      <div className="map-caption">
        <span>
          <span className="live-dot" />
          {fmt.format(active.length)} شحنات نشطة على الشبكة
        </span>
        <span>مخطط تجريبي · ليس تتبعًا مباشرًا</span>
      </div>
    </div>
  );
}

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [nav, setNav] = useState('overview');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedReturn, setSelectedReturn] = useState<string | null>(null);
  const [returnRevision, setReturnRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [menu, setMenu] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [tracking, setTracking] = useState<null | {
    reference: string;
    status: ShipmentStatus;
    city: string;
    updatedAt: string;
    timeline: { type: string; createdAt: string }[];
  }>(null);
  const [publicMode, setPublicMode] = useState(false);
  const refresh = useCallback(async () => {
    const fresh = await api<Bootstrap>('/api/bootstrap');
    setData(fresh);
    setReturnRevision((x) => x + 1);
    setError('');
  }, []);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : 'تعذر إتمام العملية'),
    [],
  );
  useEffect(() => {
    let disposed = false;
    async function start() {
      try {
        const token = new URLSearchParams(location.search).get('tracking');
        if (token) {
          setPublicMode(true);
          const t = await api<typeof tracking>('/api/tracking/' + encodeURIComponent(token));
          if (!disposed) setTracking(t);
          return;
        }
        const result = await api<{ accounts: Account[] }>('/api/demo/accounts');
        if (!disposed) setAccounts(result.accounts);
        try {
          await refresh();
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            await api('/api/demo/session', {
              method: 'POST',
              body: JSON.stringify({ accountId: 'ops' }),
            });
            await refresh();
          } else throw e;
        }
      } catch (e) {
        if (!disposed) report(e);
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void start();
    return () => {
      disposed = true;
    };
  }, [refresh, report]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const online = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', off);
    };
  }, []);
  async function switchAccount(id: string) {
    setLoading(true);
    try {
      await api('/api/demo/session', { method: 'POST', body: JSON.stringify({ accountId: id }) });
      setSelected(null);
      setSelectedReturn(null);
      setNav('overview');
      setSearch('');
      setFilter('all');
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }
  const shipments = data?.shipments ?? [];
  const visible = shipments.filter(
    (s) =>
      (filter === 'all' || s.status === filter) &&
      `${s.reference} ${s.recipientName} ${s.merchantName} ${s.destination}`.includes(search),
  );
  const operator = data?.account.role === 'operator';
  const title = ['inventory', 'transfers', 'cash', 'payouts', 'returns'].includes(nav)
    ? labels[nav]
    : data?.account.role === 'courier'
      ? 'جولتك اليوم'
      : data?.account.role === 'merchant'
        ? 'طلبات متجرك'
        : data?.account.role === 'pickup'
          ? (data.sites.find((s) => s.id === data.account.pickupSiteId)?.name ?? 'نقطة الاستلام')
          : labels[nav];

  if (publicMode)
    return (
      <main className="public-tracking">
        <div className="brand-mark">
          <Box />
        </div>
        <p className="eyebrow">الشبكة اللوجستية</p>
        <h1>تتبّع شحنتك</h1>
        {loading ? (
          <Loading />
        ) : error ? (
          <div className="alert">{error}</div>
        ) : (
          tracking && (
            <section className="tracking-card">
              <div className="split">
                <b dir="ltr">{tracking.reference}</b>
                <Status status={tracking.status} />
              </div>
              <h2>{tracking.city}</h2>
              <p>آخر تحديث {date(tracking.updatedAt)}</p>
              <div className="timeline">
                {tracking.timeline.map((e, i) => (
                  <div className="timeline-item timeline-recorded" key={i}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {eventLabels[e.type.replace('shipment.', '')] ?? 'تحديث الشحنة'}
                      </strong>
                      <small>{date(e.createdAt)}</small>
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted">بيانات تجريبية · عنوان المستلم ومعلوماته الخاصة غير معروضة</p>
            </section>
          )
        )}
      </main>
    );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Box size={26} />
          </div>
          <div>
            <strong>الشبكة اللوجستية</strong>
            <small>إدارة وتنفيذ وتوصيل</small>
          </div>
        </div>
        <div className="workspace-label">مساحة العمل</div>
        <nav aria-label="التنقل الرئيسي">
          {navItems
            .filter(
              (n) =>
                operator ||
                ['overview', 'shipments', 'cash'].includes(n.id) ||
                (n.id === 'returns' &&
                  ['merchant', 'courier'].includes(data?.account.role ?? '')) ||
                (n.id === 'payouts' && data?.account.role === 'merchant') ||
                (n.id === 'inventory' && data?.account.role === 'merchant') ||
                (n.id === 'transfers' &&
                  ['merchant', 'courier'].includes(data?.account.role ?? '')),
            )
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${nav === item.id ? 'active' : ''}`}
                onClick={() => {
                  setNav(item.id);
                  setMenu(false);
                }}
              >
                <item.icon size={20} />
                <span>{item.label}</span>
                {item.id === 'shipments' && <span className="nav-count">{shipments.length}</span>}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-note">
            <ShieldCheck size={20} />
            <div>
              <strong>مساحة آمنة للتجربة</strong>
              <p>بيانات اصطناعية، دون رسائل أو مدفوعات حقيقية.</p>
            </div>
          </div>
          <div className="sidebar-version">
            <span className="live-dot" />
            الشريحة الأولى · v0.1
          </div>
        </div>
      </aside>
      {menu && (
        <button className="nav-scrim" aria-label="إغلاق القائمة" onClick={() => setMenu(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="فتح القائمة"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={21} />
            </button>
            <span>مساحة العمل</span>
            <ChevronLeft size={15} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <a className="storefront-link" href="/shop" target="_blank" rel="noreferrer">
              <Store size={16} /> تجربة المتجر
            </a>
            <span className="demo-chip">
              <span />
              بيئة تجريبية
            </span>
            <div className="account-control">
              <span className="avatar">{data?.account.name.charAt(0) ?? 'م'}</span>
              <label className="sr-only" htmlFor="account">
                حساب العرض
              </label>
              <select
                id="account"
                value={data?.account.id ?? 'ops'}
                onChange={(e) => void switchAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
        </header>
        <main className="main-content">
          {offline && (
            <div className="alert">
              <WifiOff size={18} />
              الاتصال غير متاح. الإجراءات تحتاج تأكيد الخادم؛ لن تُسجل كعمليات مكتملة دون اتصال.
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              <span>{error}</span>
              <button
                onClick={() => {
                  void refresh().catch(report);
                }}
              >
                <RefreshCw size={15} />
                إعادة المحاولة
              </button>
              <button
                className="icon-button"
                aria-label="إغلاق التنبيه"
                onClick={() => setError('')}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {nav === 'overview' ? 'رؤية أوضح. تشغيل أكثر انسيابية.' : 'الشبكة اللوجستية'}
              </p>
              <h1>{title}</h1>
              <p>
                {nav === 'inventory'
                  ? 'تابع المتاح والمحجوز، وسجّل الوارد وافحص المرتجعات بأرصدة واضحة.'
                  : nav === 'transfers'
                    ? 'تابع حجز القطع وانتقال عهدتها واستلامها بين مواقع التخزين.'
                    : nav === 'cash'
                      ? 'تابع التحصيل النقدي وعهدة الأموال وإقرارات الاستلام والفروق.'
                      : nav === 'payouts'
                        ? 'تابع حجز مستحقات المتاجر وخروج النقد وإقرار الاستلام المستقل.'
                        : data?.account.role === 'courier'
                          ? 'كل مهمة، من الاستلام حتى التسليم، في مكان واحد.'
                          : data?.account.role === 'pickup'
                            ? 'استلم عهدة الطرود، وتحقق من رمز العميل، ونظّم تسليم المرتجعات.'
                            : data?.account.role === 'merchant'
                              ? 'تابع رحلة طلباتك من المتجر حتى العميل.'
                              : nav === 'overview'
                                ? 'تابع حركة الشحنات، ونسّق فريقك، واتخذ الخطوة التالية بثقة.'
                                : nav === 'network'
                                  ? 'المواقع والمندوبون الذين يشكلون شبكة التنفيذ.'
                                  : nav === 'integration'
                                    ? 'اختبر استقبال الأحداث وتعافي التكامل قبل الربط بالتطبيقات.'
                                    : 'إدارة رحلة كل طرد، مع تفاصيل واضحة وإجراءات موثقة.'}
              </p>
            </div>
            {!['transfers', 'cash', 'payouts', 'returns'].includes(nav) && (
              <div className="heading-actions">
                <button
                  className="button secondary"
                  onClick={() => void refresh().catch(report)}
                  aria-label="تحديث البيانات"
                >
                  <RefreshCw size={16} />
                  تحديث
                </button>
                {['operator', 'merchant'].includes(data?.account.role ?? '') && (
                  <button className="button primary" onClick={() => setCreating(true)}>
                    <Plus size={18} />
                    إنشاء شحنة
                  </button>
                )}
              </div>
            )}
          </div>
          {data && nav !== 'cash' && nav !== 'payouts' && (
            <FinancialNotice key={data.account.id} actorId={data.account.id} onOpen={setNav} />
          )}
          {loading ? (
            <Loading />
          ) : (
            data && (
              <>
                {operator && ['overview', 'shipments'].includes(nav) && (
                  <PickupAlerts onOpen={setSelected} />
                )}
                {nav === 'overview' && (
                  <>
                    <div className="stats-grid">
                      <Metric
                        title="إجمالي الشحنات"
                        value={data.stats.total}
                        icon={Package}
                        subtitle="الشحنات الظاهرة لحسابك"
                      />
                      <Metric
                        title="قيد التنفيذ"
                        value={data.stats.active}
                        icon={Truck}
                        subtitle="من الإسناد حتى اكتمال المهمة"
                      />
                      <Metric
                        title="تم التسليم"
                        value={data.stats.delivered}
                        icon={CheckCheck}
                        subtitle="شحنات مكتملة التسليم"
                      />
                      <Metric
                        title="تحتاج متابعة"
                        value={data.stats.exceptions}
                        icon={Clock3}
                        subtitle="حالات تعذر التسليم"
                        warning
                      />
                    </div>
                    <div className="overview-grid">
                      <section className="panel map-panel">
                        <div className="panel-title">
                          <div>
                            <h2>حركة الشبكة</h2>
                            <p>نظرة على مراحل التنفيذ الحالية</p>
                          </div>
                          <span className="subtle-chip">
                            <MapPin size={13} />
                            دمشق
                          </span>
                        </div>
                        <RouteMap shipments={shipments} />
                        <div className="map-legend">
                          <span>
                            <i className="legend-origin" />
                            نقطة الاستلام
                          </span>
                          <span>
                            <i className="legend-courier" />
                            مرحلة النقل
                          </span>
                          <span>
                            <i className="legend-destination" />
                            الوجهة
                          </span>
                        </div>
                      </section>
                      <section className="panel flow-panel">
                        <div className="panel-title">
                          <div>
                            <h2>نبض العمليات</h2>
                            <p>توزيع الشحنات حسب مرحلة التنفيذ</p>
                          </div>
                          <Activity size={20} />
                        </div>
                        <div className="flow-bars">
                          {(['ready', 'assigned', 'in_transit', 'delivered'] as const).map((s) => {
                            const count = shipments.filter((x) => x.status === s).length;
                            return (
                              <div className="flow-row" key={s}>
                                <div>
                                  <span>{statusLabels[s]}</span>
                                  <strong>{fmt.format(count)}</strong>
                                </div>
                                <div className="flow-track">
                                  <span
                                    style={{
                                      width: `${shipments.length ? (count / shipments.length) * 100 : 0}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="flow-footer">
                          <ShieldCheck size={17} />
                          <span>المؤشرات محسوبة من قاعدة العرض</span>
                        </div>
                      </section>
                    </div>
                  </>
                )}
                {data.account.role === 'courier' && ['overview', 'shipments'].includes(nav) && (
                  <CourierTasks
                    key={data.account.id}
                    shipments={shipments}
                    revision={returnRevision}
                    onShipment={setSelected}
                    onReturn={setSelectedReturn}
                  />
                )}
                {data.account.role !== 'courier' && ['overview', 'shipments'].includes(nav) && (
                  <section className="panel shipments-panel">
                    <div className="panel-title">
                      <div>
                        <h2>{nav === 'overview' ? 'الشحنات الأخيرة' : 'جميع الشحنات'}</h2>
                        <p>تتبّع الحالة وافتح التفاصيل للإجراء التالي</p>
                      </div>
                      <span className="subtle-chip">{fmt.format(shipments.length)} شحنة</span>
                    </div>
                    <div className="table-toolbar">
                      <div className="search-field">
                        <Search size={18} />
                        <input
                          aria-label="البحث في الشحنات"
                          placeholder="ابحث عن شحنة، عميل أو متجر..."
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <div className="filter-control">
                        <Filter size={16} />
                        <select
                          aria-label="تصفية حالة الشحنة"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        >
                          <option value="all">كل الحالات</option>
                          {Object.entries(statusLabels).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {visible.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>الشحنة</th>
                              <th>العميل والوجهة</th>
                              <th>الحالة</th>
                              <th>المندوب</th>
                              <th>رسوم الخدمة</th>
                              <th>آخر تحديث</th>
                              <th>
                                <span className="sr-only">التفاصيل</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visible.map((s) => (
                              <tr key={s.id} onClick={() => setSelected(s.id)}>
                                <td>
                                  <button
                                    className="reference-button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelected(s.id);
                                    }}
                                    dir="ltr"
                                  >
                                    {s.reference}
                                  </button>
                                  <small>{s.merchantName}</small>
                                </td>
                                <td>
                                  <strong>{s.recipientName}</strong>
                                  <small>
                                    <MapPin size={11} />
                                    {s.destination}
                                  </small>
                                </td>
                                <td>
                                  <Status status={s.status} />
                                  {s.pickupOverdue && (
                                    <small className="pickup-late-label">
                                      <Clock3 size={12} />
                                      تأخر الاستلام من المنشأ
                                    </small>
                                  )}
                                </td>
                                <td>
                                  {s.courierName ? (
                                    <span className="courier-name">
                                      <span className="mini-avatar">{s.courierName.charAt(0)}</span>
                                      {s.courierName}
                                    </span>
                                  ) : (
                                    <span className="muted">لم يُعيّن بعد</span>
                                  )}
                                </td>
                                <td className="money">{money(s.feeMinor)}</td>
                                <td className="muted">{date(s.updatedAt)}</td>
                                <td>
                                  <button
                                    className="icon-button"
                                    aria-label={`تفاصيل ${s.reference}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelected(s.id);
                                    }}
                                  >
                                    <ChevronLeft size={17} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty
                        text={
                          search || filter !== 'all'
                            ? 'لا توجد شحنات تطابق البحث. جرّب تغيير الفلاتر.'
                            : 'لا توجد شحنات لهذا الحساب بعد.'
                        }
                      />
                    )}
                    <div className="table-footer">
                      <span>
                        عرض {fmt.format(visible.length)} من {fmt.format(shipments.length)} شحنة · حد
                        العرض 100
                      </span>
                      <span>
                        <span className="live-dot" />
                        متصل بقاعدة العرض
                      </span>
                    </div>
                  </section>
                )}
                {nav === 'network' && (
                  <Network
                    data={data}
                    notify={setToast}
                    onChanged={async () => {
                      await refresh();
                      setAccounts(
                        (await api<{ accounts: Account[] }>('/api/demo/accounts')).accounts,
                      );
                    }}
                  />
                )}
                {nav === 'integration' && <Integration report={report} notify={setToast} />}
                {nav === 'inventory' && <Inventory key={data.account.id} notify={setToast} />}
                {nav === 'transfers' && (
                  <InventoryTransfers
                    key={data.account.id}
                    account={data.account}
                    couriers={data.couriers}
                    notify={setToast}
                    onCommitted={refresh}
                  />
                )}
                {nav === 'returns' && (
                  <CommercialReturns
                    key={data.account.id}
                    account={data.account}
                    couriers={data.couriers}
                  />
                )}
                {nav === 'cash' && <Cash key={data.account.id} account={data.account} />}
                {nav === 'payouts' && <Payouts key={data.account.id} account={data.account} />}
                {nav === 'overview' && (
                  <div className="bottom-note">
                    <Globe2 size={17} />
                    <span>
                      منصة مستقلة تخدم التطبيقات عبر API. الربط الفعلي مع Tendsy في مرحلة لاحقة.
                    </span>
                    <span className="note-badge">نقل طرد محلي</span>
                  </div>
                )}
              </>
            )
          )}
        </main>
        <footer className="app-footer">
          <span>الشبكة اللوجستية · تجربة تنفيذ مستقلة</span>
          <span>جميع البيانات المعروضة اصطناعية</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
      {creating && data && (
        <CreateShipment
          data={data}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await refresh();
            setSelected(id);
            setToast('تم إنشاء طلب التنفيذ بنجاح');
          }}
          report={report}
        />
      )}
      {selectedReturn && data?.account.role === 'courier' && (
        <Modal
          title="مهمة استلام مرتجع"
          subtitle="الاستلام والعهدة والإجراء التالي"
          wide
          onClose={() => setSelectedReturn(null)}
        >
          <CommercialReturns
            key={data.account.id + selectedReturn}
            account={data.account}
            couriers={data.couriers}
            focusId={selectedReturn}
            onChanged={async () => {
              await refresh();
            }}
          />
        </Modal>
      )}
      {selected && data && (
        <ShipmentDetails
          id={selected}
          data={data}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          report={report}
          notify={setToast}
        />
      )}
    </div>
  );
}

function Metric({
  title,
  value,
  icon: Icon,
  subtitle,
  warning = false,
}: {
  title: string;
  value: number;
  icon: typeof Package;
  subtitle: string;
  warning?: boolean;
}) {
  return (
    <section className={`metric ${warning ? 'metric-warning' : ''}`}>
      <div className="metric-top">
        <span>{title}</span>
        <div className="metric-icon">
          <Icon size={21} />
        </div>
      </div>
      <strong>{fmt.format(value)}</strong>
      <small>{subtitle}</small>
    </section>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={25} />
      <span>جارٍ تحميل البيانات...</span>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Package size={32} />
      <strong>{text}</strong>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]',
          ) ?? [],
        ).filter((x) => x.getClientRects().length > 0);
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', handler);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="إغلاق النافذة">
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreateShipment({
  data,
  onClose,
  onCreated,
  report,
}: {
  data: Bootstrap;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  report: (e: unknown) => void;
}) {
  const sites = data.sites.filter((s) => s.merchantId);
  const [input, setInput] = useState<ShipmentInput>({
    externalReference: 'WEB-' + Date.now().toString(36).toUpperCase(),
    originId: sites[0]?.id ?? '',
    recipientName: '',
    destination: '',
    weightKg: 1,
  });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [idempotencyKey] = useState(key);
  const merchantId = sites.find((s) => s.id === input.originId)?.merchantId;
  function change<K extends keyof ShipmentInput>(field: K, value: ShipmentInput[K]) {
    setInput((x) => ({ ...x, [field]: value }));
    setQuote(null);
    setFormError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      if (!quote) {
        const result = await api<Quote>('/api/demo-commerce/quotes', {
          method: 'POST',
          body: JSON.stringify({ merchantId, input }),
        });
        setQuote(result);
      } else {
        const shipment = await api<Shipment>('/api/demo-commerce/orders', {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify({ merchantId, quoteId: quote.id }),
        });
        await onCreated(shipment.id);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'تعذر الإرسال');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="إنشاء شحنة جديدة"
      subtitle="طرد جاهز للنقل داخل دمشق · تطبيق تجاري تجريبي"
      onClose={onClose}
    >
      <form onSubmit={submit} className="shipment-form">
        {formError && (
          <div className="alert" role="alert">
            {formError}
          </div>
        )}
        <div className="form-grid">
          <label>
            موقع الاستلام
            <select
              value={input.originId}
              onChange={(e) => change('originId', e.target.value)}
              required
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.city}
                </option>
              ))}
            </select>
          </label>
          <label>
            مرجع طلب البيع
            <input
              dir="ltr"
              value={input.externalReference}
              minLength={3}
              maxLength={80}
              onChange={(e) => change('externalReference', e.target.value)}
              required
            />
          </label>
          <label>
            اسم المستلم
            <input
              value={input.recipientName}
              onChange={(e) => change('recipientName', e.target.value)}
              required
              minLength={2}
              maxLength={80}
              placeholder="مثال: رامي أحمد"
            />
          </label>
          <label>
            وزن الطرد بالكيلوغرام
            <input
              type="number"
              min="0.1"
              max="50"
              step="0.1"
              value={input.weightKg}
              onChange={(e) => change('weightKg', Number(e.target.value))}
              required
            />
          </label>
          <label className="span-two">
            عنوان التسليم
            <input
              value={input.destination}
              onChange={(e) => change('destination', e.target.value)}
              required
              minLength={5}
              maxLength={180}
              placeholder="الحي والشارع، دمشق"
            />
          </label>
        </div>
        <div className="form-note">
          <ShieldCheck size={18} />
          <span>الشريحة الحالية للنقل فقط. لا يُحصّل مال ولا يُحجز مخزون لهذا الطلب.</span>
        </div>
        {quote && (
          <div className="quote-summary">
            <div>
              <span>التوصيل المحلي</span>
              <strong>{money(quote.feeMinor)}</strong>
            </div>
            <p>
              <Clock3 size={15} />
              {quote.estimateLabel}
            </p>
            <small>العرض صالح حتى {date(quote.expiresAt)} · تسعير اصطناعي للتجربة</small>
          </div>
        )}
        <div className="modal-footer">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : quote ? (
              <Check size={17} />
            ) : (
              <ArrowLeft size={17} />
            )}{' '}
            {quote ? 'تأكيد طلب التنفيذ' : 'عرض خيارات التوصيل'}
          </button>
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            إغلاق
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ShipmentDetails({
  id,
  data,
  onClose,
  onChanged,
  report,
  notify,
}: {
  id: string;
  data: Bootstrap;
  onClose: () => void;
  onChanged: () => Promise<void>;
  report: (e: unknown) => void;
  notify: (s: string) => void;
}) {
  const pendingCommand = useRef<{ body: string; key: string } | null>(null);
  const [detail, setDetail] = useState<{
    shipment: Shipment;
    timeline: TimelineEvent[];
    inventory: {
      productId: string;
      quantity: number;
      state: string;
      expiresAt: string | null;
      restocked: number;
      discarded: number;
    }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [commandUncertain, setCommandUncertain] = useState(false);
  const [courierId, setCourierId] = useState(data.couriers.find((c) => c.available)?.id ?? '');
  const [reason, setReason] = useState('');
  const [deliveryCode, setDeliveryCode] = useState('');
  const [cashAmount, setCashAmount] = useState(''),
    [cashReference, setCashReference] = useState(''),
    [cashReviewed, setCashReviewed] = useState(false);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const load = useCallback(async () => {
    const next = await api<NonNullable<typeof detail>>('/api/shipments/' + id);
    setDetail((previous) =>
      !previous || next.shipment.version >= previous.shipment.version ? next : previous,
    );
  }, [id]);
  useEffect(() => {
    void load().catch((e) => setLocalError(e.message));
  }, [load]);
  useEffect(() => {
    if (busy || confirm || commandUncertain) return;
    let stopped = false,
      inFlight = false;
    const refresh = async () => {
      if (stopped || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const next = await api<NonNullable<typeof detail>>('/api/shipments/' + id);
        if (!stopped)
          setDetail((previous) =>
            !previous || next.shipment.version >= previous.shipment.version ? next : previous,
          );
      } catch {
        // Keep the last confirmed state; a background failure must not erase the journey.
      } finally {
        inFlight = false;
      }
    };
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
  }, [id, busy, confirm, commandUncertain]);
  async function act(action: Action) {
    if (!detail) return;
    setBusy(true);
    setLocalError('');
    try {
      const body =
        commandUncertain && pendingCommand.current
          ? pendingCommand.current.body
          : JSON.stringify({
              action,
              expectedVersion: detail.shipment.version,
              ...(['assign', 'assign_return'].includes(action)
                ? { courierId }
                : action === 'handover_origin'
                  ? { courierId: detail.shipment.courierId }
                  : {}),
              ...(['fail', 'return', 'decline', 'unassign'].includes(action) ? { reason } : {}),
              ...(['deliver', 'release_pickup'].includes(action) &&
              detail.shipment.deliveryProofRequired
                ? { deliveryCode }
                : {}),
              ...(['deliver', 'release_pickup'].includes(action) && detail.shipment.collection
                ? {
                    cash: {
                      amountMinor: parseCash(cashAmount),
                      currency: 'SYP',
                      reference: cashReference,
                    },
                  }
                : {}),
            });
      if (pendingCommand.current?.body !== body) pendingCommand.current = { body, key: key() };
      const shipment = await api<Shipment>('/api/shipments/' + id + '/actions', {
        method: 'POST',
        headers: { 'idempotency-key': pendingCommand.current.key },
        body,
      });
      pendingCommand.current = null;
      setCommandUncertain(false);
      if (action === 'decline' || (action === 'receive_pickup' && role === 'courier')) {
        await onChanged();
        notify('أعيدت الشحنة للإسناد وتحررت سعة المندوب');
        onClose();
        return;
      }
      setDetail((x) => (x ? { ...x, shipment } : x));
      await load();
      await onChanged();
      setConfirm(null);
      setReason('');
      notify('تم تسجيل الإجراء وتحديث رحلة الشحنة');
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'تعذر الإجراء');
      if (pendingCommand.current && (!(e instanceof ApiError) || e.status >= 500)) {
        setCommandUncertain(true);
        setLocalError(
          'لم نتأكد من نتيجة الإجراء. أعد التأكيد نفسه دون تعديل الحقول؛ لن يتكرر التسليم أو التحصيل.',
        );
      } else if (e instanceof ApiError && e.status < 500) {
        pendingCommand.current = null;
        setCommandUncertain(false);
      }
      if (e instanceof ApiError && ['VERSION_CONFLICT', 'ASSIGNMENT_EXPIRED'].includes(e.code))
        try {
          await load();
        } catch (refreshError) {
          if (refreshError instanceof ApiError && refreshError.status === 404) {
            await onChanged();
            notify('لم تعد هذه المهمة مسندة لهذا الحساب؛ حدّث قائمة المهام');
            onClose();
          } else {
            setLocalError('تعذر تحديث المهمة؛ أعد فتحها عند استعادة الاتصال');
          }
        }
    } finally {
      setBusy(false);
    }
  }
  const s = detail?.shipment;
  const role = data.account.role;
  const custody = s
    ? s.status === 'delivered'
      ? 'العميل'
      : s.status === 'returned'
        ? 'موقع المنشأ'
        : ['ready', 'assigned', 'cancelled'].includes(s.status)
          ? s.originReleased && s.status === 'assigned'
            ? 'تسليم مسجل؛ بانتظار تأكيد المندوب'
            : s.originName
          : s.custodySiteId
            ? (s.pickupSiteName ?? 'نقطة الاستلام')
            : (s.courierName ?? 'غير محدد')
    : '';
  const deliveryAction = confirm === 'deliver' || confirm === 'release_pickup';
  const confirmationIssues: string[] = [];
  if (deliveryAction && s?.deliveryProofRequired && deliveryCode.length !== 6)
    confirmationIssues.push('أدخل رمز استلام العميل المكوّن من 6 أرقام.');
  if (deliveryAction && s?.collection) {
    if (parseCash(cashAmount) !== s.collection.totalMinor)
      confirmationIssues.push(`أدخل كامل المبلغ المطلوب: ${cashMoney(s.collection.totalMinor)}.`);
    if (cashReference.trim().length < 3)
      confirmationIssues.push('اكتب مرجع إقرار التحصيل من 3 أحرف على الأقل، مثل: إيصال 123.');
    if (!cashReviewed) confirmationIssues.push('أكد استلام كامل النقد بوضع علامة في مربع الإقرار.');
  }
  if (
    confirm &&
    ['fail', 'return', 'decline', 'unassign'].includes(confirm) &&
    reason.trim().length < 3
  )
    confirmationIssues.push('اكتب سبب الإجراء من 3 أحرف على الأقل.');
  const happened = (action: string) =>
    detail?.timeline.some((event) => event.type === 'shipment.' + action);
  const atOrigin = s && ['ready', 'assigned', 'cancelled', 'returned'].includes(s.status);
  const routeStops = s
    ? [
        {
          label: 'المنشأ',
          name: s.originName,
          done: !!happened('pickup') || s.originReceived,
          current: !!atOrigin,
        },
        ...(s.pickupSiteId
          ? [
              {
                label: 'نقطة الاستلام',
                name: s.pickupSiteName ?? s.destination,
                done: !!happened('receive_pickup') || s.status === 'delivered',
                current: !!s.custodySiteId,
              },
            ]
          : []),
        {
          label: 'استلام العميل',
          name: s.pickupSiteId ? s.recipientName : s.destination,
          done: s.status === 'delivered',
          current: s.status === 'delivered',
        },
      ]
    : [];
  return (
    <Modal
      title={s ? s.reference : 'تفاصيل الشحنة'}
      subtitle="رحلة الطرد وسجل العهدة والإجراء التالي"
      onClose={onClose}
      wide
    >
      {localError && (
        <div className="alert" role="alert">
          {localError}
        </div>
      )}
      {!detail ? (
        <Loading />
      ) : (
        <>
          <div className="detail-summary">
            <Status status={s!.status} />
            <span>الإصدار {s!.version}</span>
            <span>آخر تحديث {date(s!.updatedAt)}</span>
          </div>
          {commandUncertain && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void act(JSON.parse(pendingCommand.current!.body).action)}
            >
              إعادة تأكيد الإجراء المعلق
            </button>
          )}
          <fieldset className="action-panel" disabled={busy || commandUncertain}>
            <h3>الخطوة التالية</h3>
            <p className="scope-note">
              {s!.recipientName} · {s!.originName} → {s!.destination}
            </p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void load().catch((e) => setLocalError(e.message))}
            >
              <RefreshCw size={15} />
              تحديث تفاصيل الشحنة
            </button>
            {s!.originHandoverRequired && (
              <div className="origin-checklist">
                <div className={s!.originPrepared ? 'complete' : ''}>
                  {s!.originPrepared ? <Check size={15} /> : <Clock3 size={15} />}
                  <span>تجهيز المتجر · {s!.originPrepared ? 'مكتمل' : 'بانتظار'}</span>
                </div>
                <div className={s!.originReleased ? 'complete' : ''}>
                  {s!.originReleased ? <Check size={15} /> : <Clock3 size={15} />}
                  <span>تسليم المتجر · {s!.originReleased ? 'مكتمل' : 'بانتظار'}</span>
                </div>
                <div className={s!.originReceived ? 'complete' : ''}>
                  {s!.originReceived ? <Check size={15} /> : <Clock3 size={15} />}
                  <span>استلام المندوب · {s!.originReceived ? 'مكتمل' : 'بانتظار'}</span>
                </div>
              </div>
            )}
            {!!detail!.inventory?.length && (
              <div className="shipment-stock-summary">
                <strong>كميات الطلب</strong>
                {detail!.inventory.map((item) => (
                  <p key={item.productId}>
                    {catalog.find((p) => p.id === item.productId)?.name ?? item.productId} ×{' '}
                    {item.quantity} ·{' '}
                    {{
                      reserved: 'محجوز',
                      prepared: 'مجهز ومحجوز',
                      dispatched: 'غادر المنشأ',
                      fulfilled: 'استلمه العميل',
                      released: 'حُرر الحجز',
                      quarantined: 'معزول للفحص',
                      restocked: 'أعيد للبيع بعد الفحص',
                      discarded: 'تالف مستبعد',
                      inspected: 'فحص مكتمل بنتائج مختلطة',
                    }[item.state] ?? item.state}
                    {(item.restocked > 0 || item.discarded > 0) && (
                      <small>
                        أعيد للبيع: {item.restocked} · تالف: {item.discarded}
                        {item.state === 'quarantined'
                          ? ` · يبقى معزولًا: ${item.quantity - item.restocked - item.discarded}`
                          : ''}
                      </small>
                    )}
                    {item.expiresAt && (
                      <small>
                        مهلة التجهيز: {new Date(item.expiresAt).toLocaleString('ar-SY')}
                      </small>
                    )}
                  </p>
                ))}
              </div>
            )}
            {!detail!.inventory?.length && ['operator', 'merchant'].includes(role) && (
              <p className="scope-note">
                هذه الشحنة غير مرتبطة بحجز منتجات في النظام؛ تأكيد التجهيز يخص الطرد فقط. الطلبات
                السابقة لم تُحتسب في المخزون بأثر رجعي.
              </p>
            )}
            {!s!.originHandoverRequired && (
              <p className="scope-note">
                حالة عرض سابقة لتطبيق تأكيد المنشأ؛ لم تُنشأ لها تأكيدات بأثر رجعي.
              </p>
            )}
            {s!.pickupDueAt && (
              <p
                className={s!.pickupOverdue ? 'alert' : 'assignment-deadline'}
                role={s!.pickupOverdue ? 'alert' : undefined}
              >
                <Clock3 size={16} />
                {s!.pickupOverdue
                  ? 'تأخر الاستلام من المنشأ. تحقق من التجهيز والعهدة؛ السعة لا تزال محجوزة.'
                  : 'مهلة الاستلام بعد قبول المهمة: '}
                {new Date(s!.pickupDueAt).toLocaleString('ar-SY')}
              </p>
            )}
            {role === 'merchant' &&
              s!.originHandoverRequired &&
              ['ready', 'assigned'].includes(s!.status) &&
              !s!.originPrepared && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('prepare')}
                >
                  تأكيد تجهيز الطرد
                </button>
              )}
            {role === 'merchant' &&
              s!.status === 'assigned' &&
              s!.originPrepared &&
              s!.assignmentAccepted &&
              !s!.originReleased && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('handover_origin')}
                >
                  تأكيد تسليم الطرد للمندوب
                </button>
              )}
            {role === 'merchant' && s!.originPrepared && s!.status === 'ready' && (
              <p className="muted">الطرد مجهز؛ بانتظار إسناد العمليات وقبول المندوب.</p>
            )}
            {s!.status === 'assigned' && s!.originReleased && (
              <p className="muted">
                سجل المتجر التسليم إلى {s!.courierName}. يلزم تأكيد المندوب قبل بدء التوصيل. لا يمكن
                إلغاء الطرد أو تحرير الإسناد في هذه المرحلة.
              </p>
            )}
            {s!.assignmentExpiresAt && !s!.assignmentAccepted && s!.status === 'assigned' && (
              <p className="assignment-deadline">
                <Clock3 size={16} /> مهلة قبول المهمة حتى {date(s!.assignmentExpiresAt)}؛ عند
                انتهائها تتحرر السعة وتعود الشحنة للإسناد. المهلة الحالية خمس دقائق.
              </p>
            )}
            {role === 'operator' &&
              (!s!.originReleased || s!.status === 'returning') &&
              (s!.status === 'assigned' || (s!.status === 'returning' && s!.custodySiteId)) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm('unassign')}
                >
                  تحرير الإسناد قبل الاستلام
                </button>
              )}
            {role === 'operator' && ['ready', 'pickup_expired'].includes(s!.status) && (
              <div className="inline-action">
                <label className="sr-only" htmlFor="courier-select">
                  اختيار المندوب
                </label>
                <select
                  id="courier-select"
                  value={courierId}
                  onChange={(e) => setCourierId(e.target.value)}
                >
                  {data.couriers
                    .filter((c) => c.available)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · متاح {fmt.format(c.capacityKg - c.activeKg)} كغ
                      </option>
                    ))}
                </select>
                <button
                  className="button primary"
                  disabled={busy || !courierId}
                  onClick={() =>
                    void act(s!.status === 'pickup_expired' ? 'assign_return' : 'assign')
                  }
                >
                  <Truck size={17} />
                  {s!.status === 'pickup_expired' ? 'إسناد الإرجاع' : 'إسناد المهمة'}
                </button>
              </div>
            )}
            {role === 'courier' &&
              (s!.status === 'assigned' || (s!.status === 'returning' && s!.custodySiteId)) &&
              !s!.assignmentAccepted && (
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void act('accept')}
                  >
                    <Check size={17} />
                    قبول المهمة
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm('decline')}
                  >
                    رفض المهمة
                  </button>
                </div>
              )}
            {role === 'courier' && s!.status === 'assigned' && s!.assignmentAccepted && (
              <>
                {s!.originHandoverRequired && !s!.originReleased && (
                  <p className="muted">
                    بانتظار تجهيز المتجر وتأكيد تسليم الطرد إلى المندوب المكلف.
                  </p>
                )}
                <button
                  className="button primary"
                  disabled={busy || (s!.originHandoverRequired && !s!.originReleased)}
                  onClick={() => setConfirm('pickup')}
                >
                  <Package size={17} />
                  تأكيد استلام الطرد
                </button>
              </>
            )}
            {role === 'courier' && s!.status === 'picked_up' && (
              <button className="button primary" disabled={busy} onClick={() => void act('depart')}>
                <Truck size={17} />
                بدء التوصيل
              </button>
            )}
            {role === 'courier' && s!.status === 'in_transit' && !s!.pickupSiteId && (
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('deliver')}
                >
                  <CheckCheck size={17} />
                  {s!.deliveryProofRequired
                    ? 'تأكيد التسليم برمز العميل'
                    : 'تأكيد التسليم التجريبي'}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm('fail')}
                >
                  تعذر التسليم
                </button>
              </div>
            )}
            {s!.pickupSiteId && (
              <p className="assignment-deadline">
                <MapPin size={16} />
                {s!.pickupSiteName} · {s!.destination}
                {s!.pickupExpiresAt && <> · مهلة الاستلام حتى {date(s!.pickupExpiresAt)}</>}
              </p>
            )}
            {role === 'courier' && s!.status === 'in_transit' && s!.pickupSiteId && (
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('arrive_pickup')}
                >
                  تأكيد الوصول إلى النقطة
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm('fail')}
                >
                  تعذر الوصول
                </button>
              </div>
            )}
            {role === 'courier' && s!.status === 'awaiting_handover' && (
              <p className="muted">
                بانتظار تأكيد موظف النقطة استلام العهدة. بعد التأكيد تُحذف المهمة من قائمة المندوب
                وتتحرر سعته.
              </p>
            )}
            {role === 'pickup' && s!.status === 'awaiting_handover' && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setConfirm('receive_pickup')}
              >
                تأكيد استلام الطرد من المندوب
              </button>
            )}
            {role === 'pickup' && s!.status === 'ready_for_pickup' && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setConfirm('release_pickup')}
              >
                تسليم العميل برمز الاستلام
              </button>
            )}
            {role === 'pickup' && s!.status === 'pickup_expired' && (
              <p className="muted">
                انتهت مهلة العميل. احتفظ بالطرد حتى إسناد مندوب الإرجاع وقبوله المهمة.
              </p>
            )}
            {role === 'pickup' &&
              s!.status === 'returning' &&
              s!.custodySiteId &&
              s!.assignmentAccepted && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('handover_return')}
                >
                  تأكيد تسليم الطرد لمندوب الإرجاع
                </button>
              )}
            {s!.status === 'returning' && s!.custodySiteId && (
              <p className="muted">
                الإرجاع مسند إلى {s!.courierName}؛ العهدة لا تزال عند النقطة حتى تأكيد تسليمها
                للمندوب.
              </p>
            )}
            {role === 'operator' && ['picked_up', 'in_transit', 'failed'].includes(s!.status) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirm('return')}
              >
                <RefreshCw size={17} />
                فتح مسار إرجاع
              </button>
            )}
            {role === 'operator' &&
              s!.status === 'returning' &&
              !s!.custodySiteId &&
              s!.assignmentAccepted && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => setConfirm('receive_return')}
                >
                  تأكيد وصول المرتجع للمنشأ
                </button>
              )}
            {['operator', 'merchant'].includes(role) &&
              !s!.originReleased &&
              ['ready', 'assigned'].includes(s!.status) && (
                <button
                  className="text-danger"
                  disabled={busy}
                  onClick={() => setConfirm('cancel')}
                >
                  إلغاء قبل الاستلام
                </button>
              )}
            {['delivered', 'returned', 'cancelled'].includes(s!.status) ? (
              <p className="muted">اكتملت هذه الرحلة. سجل الأحداث محفوظ للمراجعة.</p>
            ) : role !== 'courier' && s!.status === 'assigned' ? (
              <p className="muted">
                {s!.assignmentAccepted
                  ? 'قبل المندوب المهمة؛ بانتظار استلام الطرد.'
                  : 'بانتظار قبول المهمة من حساب المندوب المكلف.'}
              </p>
            ) : null}
            {confirm && (
              <div className="confirmation">
                <strong>
                  {confirm === 'prepare'
                    ? detail!.inventory?.length
                      ? 'هل جهزت جميع كميات الطلب المحجوزة وأغلقت الطرد؟ سيُثبت التجهيز وتتوقف مهلة الحجز.'
                      : 'هل الطرد مجهز ومغلق وجاهز فعليًا؟ هذه الشحنة خدمة نقل دون حجز منتجات.'
                    : confirm === 'handover_origin'
                      ? `هل سلمت الطرد فعليًا إلى ${s!.courierName}؟ تحقق من المندوب المكلف قبل التأكيد؛ بعدها لا يمكن تحرير الإسناد أو إلغاء الطرد.`
                      : confirm === 'receive_pickup'
                        ? 'أكد الاستلام الفعلي من المندوب. ستنتقل العهدة للنقطة وتبدأ مهلة العميل.'
                        : confirm === 'arrive_pickup'
                          ? 'هل وصلت فعليًا إلى نقطة الاستلام؟ تبقى العهدة معك حتى تأكيد موظف النقطة.'
                          : confirm === 'handover_return'
                            ? 'هل سلمت الطرد فعليًا لمندوب الإرجاع المكلف؟'
                            : confirm === 'release_pickup'
                              ? 'تحقق من رمز العميل عند تسليم الطرد له.'
                              : confirm === 'cancel'
                                ? 'سيُلغى الطلب قبل استلام الطرد.'
                                : confirm === 'pickup'
                                  ? 'هل استلمت الطرد فعليًا من المنشأ؟'
                                  : confirm === 'deliver'
                                    ? s!.deliveryProofRequired
                                      ? 'اطلب الرمز من العميل بعد تسليمه الطرد. لا تحصل على الرمز مسبقًا.'
                                      : 'هل سُلّم الطرد للعميل؟ هذا إقرار تجريبي دون رمز استلام.'
                                    : confirm === 'receive_return'
                                      ? 'هل استُلم الطرد المعاد فعليًا في المنشأ؟'
                                      : 'سجل السبب قبل متابعة الإجراء.'}
                </strong>
                {['deliver', 'release_pickup'].includes(confirm) && s!.deliveryProofRequired && (
                  <label>
                    رمز استلام العميل
                    <input
                      aria-label="رمز استلام العميل"
                      value={deliveryCode}
                      onChange={(e) =>
                        setDeliveryCode(
                          e.target.value
                            .replace(/[٠-٩۰-۹]/g, (digit) =>
                              String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)),
                            )
                            .replace(/[^0-9]/g, '')
                            .slice(0, 6),
                        )
                      }
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      dir="ltr"
                      placeholder="000000"
                    />
                    <small>الرمز من صفحة طلب العميل. خمس محاولات كحد أقصى.</small>
                  </label>
                )}
                {['fail', 'return', 'decline', 'unassign'].includes(confirm) && (
                  <label>
                    سبب الإجراء
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      minLength={3}
                      maxLength={240}
                      placeholder="مثال: تعذر التواصل مع المستلم"
                    />
                  </label>
                )}
                {['deliver', 'release_pickup'].includes(confirm) && s!.collection && (
                  <div className="cash-confirmation">
                    <strong>مطلوب نقدًا كاملًا: {cashMoney(s!.collection!.totalMinor)}</strong>
                    <p>
                      إقرار تجريبي: سيُسجّل النقد في عهدة حسابك مع تسليم الطرد، ولن يُعتبر مستلمًا
                      لدى العمليات.
                    </p>
                    <label>
                      المبلغ النقدي المستلم بالليرة السورية
                      <input
                        aria-label="المبلغ النقدي المستلم بالليرة السورية"
                        inputMode="decimal"
                        value={cashAmount}
                        onChange={(e) => {
                          setCashAmount(e.target.value);
                          setCashReviewed(false);
                        }}
                      />
                    </label>
                    <label>
                      مرجع إقرار التحصيل
                      <input
                        aria-label="مرجع إقرار التحصيل"
                        value={cashReference}
                        onChange={(e) => {
                          setCashReference(e.target.value);
                          setCashReviewed(false);
                        }}
                        aria-describedby="cash-reference-help"
                        placeholder="مثال: إيصال 123"
                        minLength={3}
                        maxLength={100}
                      />
                      <small id="cash-reference-help">
                        مرجع يوضح إقرار استلام النقد، من 3 أحرف على الأقل.
                      </small>
                    </label>
                    <label className="transfer-review">
                      <input
                        type="checkbox"
                        checked={cashReviewed}
                        onChange={(e) => setCashReviewed(e.target.checked)}
                      />
                      أؤكد استلام كامل النقد فعليًا في تجربة العرض.
                    </label>
                  </div>
                )}
                <div
                  id="confirmation-requirements"
                  className="confirmation-requirements"
                  role="status"
                  aria-live="polite"
                >
                  {confirmationIssues.length > 0 ? (
                    <>
                      <strong>لإتاحة التأكيد:</strong>
                      <ul>
                        {confirmationIssues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <span>اكتملت البيانات المطلوبة. سيُتحقق من صحتها عند التأكيد.</span>
                  )}
                </div>
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={busy || confirmationIssues.length > 0}
                    aria-describedby="confirmation-requirements"
                    onClick={() => void act(confirm)}
                  >
                    {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}تأكيد
                    الإجراء
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    تراجع
                  </button>
                </div>
              </div>
            )}
          </fieldset>
          {data.account.role !== 'pickup' && (
            <LocationSharing shipment={s!} role={data.account.role} />
          )}
          <div className="detail-grid">
            <section>
              <div className="detail-card">
                <h3>
                  <Package size={18} />
                  بيانات التنفيذ
                </h3>
                <dl>
                  <div>
                    <dt>المتجر</dt>
                    <dd>{s!.merchantName}</dd>
                  </div>
                  <div>
                    <dt>المستلم</dt>
                    <dd>{s!.recipientName}</dd>
                  </div>
                  <div>
                    <dt>الوزن</dt>
                    <dd>{fmt.format(s!.weightKg)} كغ</dd>
                  </div>
                  <div>
                    <dt>رسوم الخدمة</dt>
                    <dd>
                      {money(s!.feeMinor)} <small>تجريبية</small>
                    </dd>
                  </div>
                  <div>
                    <dt>مرجع البيع</dt>
                    <dd dir="ltr">{s!.externalReference}</dd>
                  </div>
                </dl>
              </div>
              <div className="detail-card">
                <h3>
                  <Route size={18} />
                  المسار والعهدة
                </h3>
                <div aria-label="مخطط تقدم التسليم" className="shipment-route">
                  {routeStops.map((stop) => (
                    <div
                      key={stop.label}
                      className={`stop ${stop.done ? 'stop-done' : 'stop-waiting'} ${stop.current ? 'stop-current' : ''}`}
                      aria-current={stop.current ? 'step' : undefined}
                    >
                      <i aria-hidden="true" />
                      <div>
                        <small>
                          {stop.label} ·{' '}
                          {stop.done ? 'مكتمل' : stop.current ? 'الطرد هنا' : 'بانتظار التأكيد'}
                        </small>
                        <strong>{stop.name}</strong>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="custody">
                  <ShieldCheck size={17} />
                  <div>
                    <small>حائز الطرد حاليًا</small>
                    <strong>{custody}</strong>
                  </div>
                </div>
              </div>
            </section>
            <section className="detail-card timeline-card">
              <h3>
                <Clock3 size={18} />
                سجل الرحلة
              </h3>
              <p className="muted">
                النقاط الممتلئة أحداث مسجّلة بالفعل. يتحدث السجل تلقائيًا كل 5 ثوانٍ خارج نموذج
                التأكيد.
              </p>
              <div className="timeline">
                {detail.timeline.map((e) => (
                  <div key={e.id} className="timeline-item timeline-recorded">
                    <span className="timeline-dot" />
                    <div>
                      <strong>{eventLabels[e.type.replace('shipment.', '')] ?? 'تحديث'}</strong>
                      <p>{e.description}</p>
                      <small>
                        {e.actorName} · {date(e.createdAt)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="modal-footer">
            <button className="button secondary" onClick={onClose}>
              إغلاق
            </button>
            {s!.trackingToken && s!.status !== 'cancelled' && (
              <a
                className="button secondary"
                href={`/?tracking=${s!.trackingToken}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={15} />
                تتبع العميل
              </a>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function PickupAlerts({ onOpen }: { onOpen: (id: string) => void }) {
  const [queue, setQueue] = useState<{
    total: number;
    alerts: { id: string; reference: string; dueAt: string; released: boolean }[];
  }>({ total: 0, alerts: [] });
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<typeof queue>('/api/shipments/pickup-alerts');
        if (!disposed) {
          setQueue(result);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  if (!queue.total && !error) return null;
  return (
    <section className="pickup-alerts" aria-label="متابعة تأخر الاستلام" aria-live="polite">
      <h3>
        <Clock3 size={20} /> مهام متأخرة عن الاستلام <span>{queue.total}</span>
      </h3>
      <p>راجع سبب التأخير. تبقى سعة المندوب محجوزة حتى الاستلام أو تحرير الإسناد المسموح.</p>
      {error && (
        <p role="alert">
          تعذر تحديث التنبيهات؛ قد تكون القائمة السابقة غير محدثة. سنعيد المحاولة تلقائيًا.
        </p>
      )}
      <div className="pickup-alert-list">
        {queue.alerts.map((item) => (
          <button
            key={item.id}
            aria-label={'متابعة تأخر ' + item.reference}
            onClick={() => onOpen(item.id)}
          >
            <strong dir="ltr">{item.reference}</strong>
            <span>
              {item.released ? 'بانتظار تأكيد استلام المندوب' : 'بانتظار التسليم من المنشأ'}
            </span>
            <time>{date(item.dueAt)}</time>
            <ArrowLeft size={16} />
          </button>
        ))}
      </div>
      {queue.total > 20 && (
        <p>تُعرض أقدم 20 مهمة من أصل {queue.total}؛ تظهر التالية عند معالجة التأخير.</p>
      )}
    </section>
  );
}

function Network({
  data,
  notify,
  onChanged,
}: {
  data: Bootstrap;
  notify: (s: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [audit, setAudit] = useState<
    {
      id: string;
      siteId: string;
      actorName: string;
      action: string;
      reason: string;
      createdAt: string;
    }[]
  >([]);
  const [auditError, setAuditError] = useState('');
  const loadAudit = useCallback(async () => {
    try {
      setAudit((await api<{ audit: typeof audit }>('/api/network/audit')).audit);
      setAuditError('');
    } catch {
      setAuditError('تعذر تحميل سجل التغييرات');
    }
  }, []);
  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);
  return (
    <>
      <div className="network-grid">
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>مواقع الشبكة</h2>
              <p>بيانات مواقع اصطناعية للتجربة</p>
            </div>
            <button className="button primary" onClick={() => setEditing('new')}>
              <Plus size={16} />
              إضافة نقطة استلام
            </button>
          </div>
          {data.sites.map((s) => (
            <div
              className={`site-item ${s.kind === 'pickup' ? 'pickup-network-card' : ''}`}
              key={s.id}
            >
              <span className="site-icon">
                {s.kind === 'store' ? <Store size={21} /> : <Box size={21} />}
              </span>
              <div>
                <strong>{s.name}</strong>
                <p>{s.address}</p>
                {s.kind === 'pickup' && (
                  <>
                    <span className={`availability ${s.pickupEnabled ? 'on' : ''}`}>
                      {s.pickupEnabled ? 'تستقبل طلبات جديدة' : 'متوقفة للطلبات الجديدة'}
                    </span>
                    <div className="capacity">
                      <span>الوزن المحجوز</span>
                      <b>
                        {fmt.format(s.reservedKg)} / {fmt.format(s.pickupCapacityKg)} كغ
                      </b>
                    </div>
                    <div className="flow-track">
                      <span
                        style={{
                          width: `${Math.min(100, (s.reservedKg / s.pickupCapacityKg) * 100)}%`,
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
              <span className="subtle-chip">
                {s.kind === 'store'
                  ? 'متجر'
                  : s.kind === 'warehouse'
                    ? 'موقع تخزين'
                    : s.kind === 'hub'
                      ? 'مركز'
                      : 'نقطة استلام'}
              </span>
              {s.kind === 'pickup' && (
                <button
                  className="button secondary"
                  onClick={() => setEditing(s)}
                  aria-label={'إدارة ' + s.name}
                >
                  <Settings2 size={15} />
                  إدارة
                </button>
              )}
            </div>
          ))}
          <p className="scope-note">
            إيقاف النقطة يمنع الطلبات الجديدة ويحافظ على معالجة الطرود الموجودة. إدارة المستودعات
            وساعات العمل والتعاقدات تضاف في المراحل التالية.
          </p>
        </section>
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>فريق النقل</h2>
              <p>السعة محجوزة بحسب المهام النشطة</p>
            </div>
            <Users size={20} />
          </div>
          {data.couriers.map((c) => (
            <div className="courier-card" key={c.id}>
              <div className="split">
                <div className="courier-name">
                  <span className="avatar">{c.name.charAt(0)}</span>
                  <div>
                    <strong>{c.name}</strong>
                    <small>{c.vehicle}</small>
                  </div>
                </div>
                <span className={`availability ${c.available ? 'on' : ''}`}>
                  {c.available ? 'متاح' : 'غير متاح'}
                </span>
              </div>
              <div className="capacity">
                <span>الحمولة المحجوزة</span>
                <b>
                  {fmt.format(c.activeKg)} / {fmt.format(c.capacityKg)} كغ
                </b>
              </div>
              <div className="flow-track">
                <span style={{ width: `${(c.activeKg / c.capacityKg) * 100}%` }} />
              </div>
            </div>
          ))}
        </section>
      </div>
      <section className="panel network-audit">
        <div className="panel-title">
          <div>
            <h2>سجل تغييرات الشبكة</h2>
            <p>آخر 20 تغييرًا، مع المسؤول والسبب</p>
          </div>
          <ShieldCheck size={20} />
        </div>
        {auditError && (
          <p className="alert" role="alert">
            {auditError}
          </p>
        )}
        {audit.length ? (
          audit.map((e) => (
            <div className="network-audit-row" key={e.id}>
              <span className="subtle-chip">
                {e.action === 'created'
                  ? 'إضافة نقطة'
                  : e.action === 'inventory_site_created'
                    ? 'إضافة موقع تخزين'
                    : e.action === 'inventory_products_registered'
                      ? 'ربط منتجات'
                      : 'تعديل إعدادات'}
              </span>
              <div>
                <b>{data.sites.find((s) => s.id === e.siteId)?.name ?? e.siteId}</b>
                <p>{e.reason}</p>
                <small>
                  {e.actorName} · {new Date(e.createdAt).toLocaleString('ar-SY')}
                </small>
              </div>
            </div>
          ))
        ) : (
          <p className="scope-note">لم تُسجل تغييرات بعد.</p>
        )}
      </section>
      {editing && (
        <PickupSiteEditor
          site={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await onChanged();
            await loadAudit();
            setEditing(null);
            notify('حُفظت إعدادات النقطة وسُجل سبب التغيير');
          }}
        />
      )}
    </>
  );
}

function PickupSiteEditor({
  site,
  onClose,
  onSaved,
}: {
  site: Site | 'new';
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = site === 'new' ? null : site;
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    address: existing?.address ?? '',
    capacityKg: String(existing?.pickupCapacityKg ?? 100),
    enabled: existing?.pickupEnabled ?? true,
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null);
  const [committed, setCommitted] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    let saved = committed;
    try {
      if (committed) {
        await onSaved();
        return;
      }
      const body = JSON.stringify({
        ...form,
        capacityKg: Number(form.capacityKg),
        ...(existing ? { expectedVersion: existing.version } : {}),
      });
      if (pending.current?.body !== body) pending.current = { body, key: key() };
      await api('/api/network/pickup-sites' + (existing ? '/' + existing.id : ''), {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'idempotency-key': pending.current.key },
        body,
      });
      saved = true;
      setCommitted(true);
      await onSaved();
    } catch (e) {
      setError(
        saved
          ? 'حُفظت الإعدادات، لكن تعذر تحديث العرض. أعد تحميل الشبكة دون إعادة الحفظ.'
          : e instanceof Error
            ? e.message
            : 'تعذر الحفظ',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? 'إدارة نقطة الاستلام' : 'إضافة نقطة استلام'}
      subtitle="الإعدادات التشغيلية للعرض المحلي داخل دمشق"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="pickup-site-form" onSubmit={save}>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <fieldset className="pickup-editor-fields" disabled={busy || committed}>
          <label>
            اسم النقطة
            <input
              autoFocus
              required
              minLength={3}
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            العنوان في دمشق
            <input
              required
              minLength={5}
              maxLength={130}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </label>
          <label>
            السعة القصوى بالكيلوغرام
            <input
              type="number"
              min={1}
              max={10000}
              step="0.1"
              required
              value={form.capacityKg}
              onChange={(e) => setForm({ ...form, capacityKg: e.target.value })}
            />
            <small>
              المحجوز حاليًا: {fmt.format(existing?.reservedKg ?? 0)} كغ. لا يسمح بتخفيض السعة دون
              المحجوز.
            </small>
          </label>
          <label className="pickup-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>
              <b>استقبال طلبات جديدة</b>
              <small>إيقاف الاستقبال لا يمنع استلام أو تسليم الطرود الحالية.</small>
            </span>
          </label>
          <label>
            سبب الإجراء
            <input
              required
              minLength={3}
              maxLength={240}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="مثال: تجهيز نقطة جديدة لخدمة الحي"
            />
          </label>
        </fieldset>
        <div className="button-row">
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            {committed ? 'إعادة تحميل الشبكة' : 'حفظ إعدادات النقطة'}
          </button>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            إلغاء
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Integration({
  report,
  notify,
}: {
  report: (e: unknown) => void;
  notify: (s: string) => void;
}) {
  const [state, setState] = useState<IntegrationState | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [eventFilter, setEventFilter] = useState('all');
  const [eventPage, setEventPage] = useState(0);
  const [eventList, setEventList] = useState<{
    events: OutboxEvent[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const loadSequence = useRef(0);
  const [target, setTarget] = useState<{
    kind: 'retry' | 'repair';
    id: string;
    version: number;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const command = useRef<{ payload: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const [events, comparison, listing] = await Promise.all([
      api<IntegrationState>('/api/integration'),
      api<Reconciliation>('/api/integration/reconciliation'),
      api<{ events: OutboxEvent[]; total: number; page: number; pageSize: number }>(
        `/api/integration/events?status=${eventFilter}&page=${eventPage}`,
      ),
    ]);
    if (sequence !== loadSequence.current) return;
    setState(events);
    setReconciliation(comparison);
    setEventList(listing);
  }, [eventFilter, eventPage]);
  async function recover() {
    if (!target) return;
    setBusy(true);
    setRecoveryError('');
    try {
      const body = JSON.stringify({
        reason,
        ...(target.kind === 'retry'
          ? { expectedRetryCount: target.version }
          : { expectedVersion: target.version }),
      });
      const url =
        target.kind === 'retry'
          ? `/api/integration/events/${target.id}/retry`
          : `/api/integration/reconciliation/${target.id}/repair`;
      const fingerprint = url + body;
      if (command.current?.payload !== fingerprint)
        command.current = { payload: fingerprint, key: key() };
      await api(url, { method: 'POST', headers: { 'idempotency-key': command.current.key }, body });
      command.current = null;
      await load();
      setTarget(null);
      setReason('');
      notify('سُجل الإجراء وأُضيف الحدث لقائمة الإرسال؛ راقب نتيجة الاستقبال');
    } catch (e) {
      setRecoveryError(e instanceof Error ? e.message : 'تعذر الإجراء');
    } finally {
      setBusy(false);
    }
  }
  function openRecovery(kind: 'retry' | 'repair', id: string, version: number) {
    setTarget({ kind, id, version });
    setReason('');
    setRecoveryError('');
    command.current = null;
  }
  useEffect(() => {
    void load().catch(report);
    const timer = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, [load, report]);
  async function toggle() {
    if (!state) return;
    setBusy(true);
    try {
      await api('/api/integration/receiver', {
        method: 'POST',
        body: JSON.stringify({ paused: !state.paused }),
      });
      await load();
      notify(state.paused ? 'عاد مستقبل الأحداث للعمل' : 'أُوقف المستقبل لاختبار إعادة المحاولة');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    try {
      await api('/api/integration/flush', { method: 'POST', body: '{}' });
      await load();
      notify('اكتملت محاولة تسليم الأحداث المعلقة');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  if (!state) return <Loading />;
  return (
    <>
      <section className="integration-hero">
        <div className="integration-symbol">
          <Activity size={29} />
        </div>
        <div>
          <h2>التطبيق التجاري التجريبي</h2>
          <p>مستقبل محلي لأحداث موقعة، مع إعادة محاولة ومنع تكرار. لا يوجد اتصال فعلي بـTendsy.</p>
        </div>
        <span className={`availability ${!state.paused ? 'on' : ''}`}>
          {state.paused ? 'المستقبل متوقف' : 'المستقبل يعمل'}
        </span>
      </section>
      <section className="panel integration-events-panel">
        <div className="panel-title">
          <div>
            <h2>اختبار التعافي</h2>
            <p>أوقف الاستقبال، نفذ إجراء على شحنة، ثم أعد الاستقبال وشاهد وصول الحدث.</p>
          </div>
          <div className="button-row">
            <button className="button secondary" disabled={busy} onClick={() => void toggle()}>
              {state.paused ? 'استئناف الاستقبال' : 'محاكاة توقف المستقبل'}
            </button>
            <button className="button primary" disabled={busy} onClick={() => void retry()}>
              <RefreshCw size={16} />
              إعادة محاولة المعلق
            </button>
          </div>
        </div>
        <div className="integration-stats">
          <span>
            أحداث معروضة (آخر 50) <b>{state.events.length}</b>
          </span>
          <span>
            مستلمة دون تكرار <b>{state.received.length}</b>
          </span>
          <span>
            قيد المحاولة <b>{state.events.filter((e) => e.status === 'pending').length}</b>
          </span>
        </div>
        <div className="table-scroll">
          <div className="integration-list-controls">
            <label>
              عرض الأحداث
              <select
                aria-label="تصفية أحداث التكامل"
                value={eventFilter}
                onChange={(e) => {
                  setEventFilter(e.target.value);
                  setEventPage(0);
                }}
              >
                <option value="all">جميع الأحداث</option>
                <option value="failed">الفشل النهائي</option>
                <option value="pending">بانتظار المحاولة</option>
              </select>
            </label>
            <span>نتائج {eventList?.total ?? 0}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>الحدث</th>
                <th>المرجع</th>
                <th>الحالة</th>
                <th>المحاولات</th>
                <th>وقت الإنشاء</th>
                <th>التعافي</th>
              </tr>
            </thead>
            <tbody>
              {(eventList?.events ?? []).map((e) => (
                <tr key={e.id}>
                  <td>{eventLabels[e.type.replace('shipment.', '')] ?? e.type}</td>
                  <td dir="ltr" className="mono">
                    {e.id.slice(0, 8)}
                  </td>
                  <td>
                    <span className={`availability ${e.status === 'sent' ? 'on' : ''}`}>
                      {e.status === 'sent'
                        ? 'تم الاستلام'
                        : e.status === 'failed'
                          ? 'فشل نهائي'
                          : 'بانتظار إعادة المحاولة'}
                    </span>
                  </td>
                  <td>{e.attempts}</td>
                  <td>{date(e.createdAt)}</td>
                  <td>
                    <small>
                      {e.lastError ?? '—'} · دورات إعادة التشغيل {e.retryCount}
                    </small>
                    {e.status === 'failed' && (
                      <button
                        className="button secondary"
                        disabled={busy || e.retryCount >= 3}
                        onClick={() => openRecovery('retry', e.id, e.retryCount)}
                      >
                        إعادة تشغيل الفشل
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!eventList?.events.length && <Empty text="لا توجد أحداث مطابقة لهذا المرشح." />}
        </div>
        <div className="integration-list-controls">
          <button
            className="button secondary"
            disabled={eventPage === 0 || busy}
            onClick={() => setEventPage((p) => p - 1)}
          >
            السابق
          </button>
          <span>
            صفحة {eventPage + 1} من {Math.max(1, Math.ceil((eventList?.total ?? 0) / 10))}
          </span>
          <button
            className="button secondary"
            disabled={busy || (eventPage + 1) * 10 >= (eventList?.total ?? 0)}
            onClick={() => setEventPage((p) => p + 1)}
          >
            التالي
          </button>
        </div>
      </section>
      {reconciliation && (
        <section className="panel reconciliation-panel">
          <div className="panel-title">
            <div>
              <h2>مطابقة حالات التطبيق</h2>
              <p>مقارنة حالة المنصة مع المستقبل المحلي. المطابقة لا تغيّر حالة الشحنة.</p>
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void load().catch(report)}
            >
              <RefreshCw size={16} /> تحديث المطابقة
            </button>
          </div>
          <div className="integration-stats">
            <span>
              شحنات مفحوصة <b>{reconciliation.total}</b>
            </span>
            <span>
              مطابقة <b>{reconciliation.matched}</b>
            </span>
            <span>
              غير مطابقة <b>{reconciliation.total - reconciliation.matched}</b>
            </span>
            <span>
              وقت الفحص <b>{date(reconciliation.checkedAt)}</b>
            </span>
          </div>
          <p className="reconciliation-note">
            نعرض أول {reconciliation.displayLimit} فرق بما فيها السجلات غير المعروفة. نصحح المفقود
            والمتأخر برسالة جديدة؛ الإصدار المتقدم أو الحالة المتعارضة يحتاج تحقيقًا.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>الشحنة</th>
                  <th>المنصة</th>
                  <th>التطبيق</th>
                  <th>نتيجة المطابقة</th>
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.differences.map((d, i) => (
                  <tr key={d.shipmentId ?? `unknown-${i}`}>
                    <td dir="ltr">{d.reference ?? 'غير معروف'}</td>
                    <td>
                      {d.sourceStatus ? statusLabels[d.sourceStatus] : '—'} ·{' '}
                      {d.sourceVersion ?? '—'}
                    </td>
                    <td>
                      {d.receiverStatus ? statusLabels[d.receiverStatus] : '—'} ·{' '}
                      {d.receiverVersion ?? '—'}
                    </td>
                    <td>
                      {
                        {
                          missing: 'لم تصل الحالة',
                          behind: 'إصدار متأخر',
                          ahead: 'إصدار متقدم',
                          conflict: 'حالة متعارضة',
                          orphan: 'سجل تطبيق غير معروف',
                        }[d.kind]
                      }
                    </td>
                    <td>
                      {d.shipmentId && d.sourceVersion && ['missing', 'behind'].includes(d.kind) ? (
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => openRecovery('repair', d.shipmentId!, d.sourceVersion!)}
                        >
                          إرسال حالة للمطابقة
                        </button>
                      ) : (
                        <span className="muted">تحقيق يدوي مطلوب</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!reconciliation.differences.length && (
              <Empty text="جميع حالات الشحنات مطابقة مع المستقبل المحلي." />
            )}
          </div>
          <div className="recovery-audit">
            <h3>سجل إجراءات التعافي</h3>
            {reconciliation.audit.length ? (
              reconciliation.audit.map((a, i) => (
                <div key={a.createdAt + a.entityId + i}>
                  <strong>
                    {a.action === 'event.retry' ? 'إعادة تشغيل حدث' : 'إرسال حالة للمطابقة'}
                  </strong>
                  <span>{a.reason}</span>
                  <small>
                    {a.actorId} · {date(a.createdAt)} · {a.entityId.slice(0, 8)}
                  </small>
                </div>
              ))
            ) : (
              <p className="muted">لا توجد إجراءات تعافٍ مسجلة بعد.</p>
            )}
          </div>
        </section>
      )}
      {target && (
        <Modal
          title={target.kind === 'retry' ? 'إعادة تشغيل حدث فشل نهائيًا' : 'إرسال حالة للمطابقة'}
          subtitle="يُحفظ السبب والفاعل في سجل التدقيق. هذا الإجراء يجهّز رسالة للإرسال ولا يعلن نجاح الاستقبال."
          onClose={() => {
            if (!busy) setTarget(null);
          }}
        >
          <div className="recovery-form">
            {recoveryError && (
              <div className="alert" role="alert">
                {recoveryError}
              </div>
            )}
            <label>
              سبب إجراء التعافي
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={240}
                placeholder="اذكر المشكلة التي عولجت قبل إعادة الإرسال"
              />
            </label>
            <p>تحقق من سبب الفشل أولًا. إعادة تشغيل الفشل محدودة بثلاث دورات، بفاصل دقيقة.</p>
            <div className="button-row">
              <button
                className="button primary"
                disabled={busy || reason.trim().length < 3}
                onClick={() => void recover()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} تأكيد
                إجراء التعافي
              </button>
              <button className="button secondary" disabled={busy} onClick={() => setTarget(null)}>
                تراجع
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
