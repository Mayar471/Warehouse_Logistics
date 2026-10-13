import { CustomerLocations } from './CustomerLocations.js';
import { ServiceRatings } from './ServiceRatings.js';
import type { Coordinates, PickupOption } from '../shared/customer-locations.js';
import { CustomerReturn } from './CustomerReturn.js';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpLeft,
  Check,
  CheckCircle2,
  Coffee,
  Headphones,
  LampDesk,
  LoaderCircle,
  MapPin,
  Minus,
  Package,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Wallet,
  Watch,
  X,
} from 'lucide-react';
import { api, ApiError } from './api.js';
import { LocationSharing } from './LocationSharing.js';
import {
  catalog,
  type CartItem,
  type Product,
  type StoreCheckout,
  type StoreOrder,
} from '../shared/catalog.js';
import { statusLabels } from '../shared/contracts.js';
import { Notifications, focusNotificationTarget } from './Notifications.js';
import './storefront.css';
import './trend-identity.css';
import trendLogo from '../logo.jpg';

import '@fontsource/tajawal/400.css';
import '@fontsource/tajawal/500.css';
import '@fontsource/tajawal/700.css';
import '@fontsource/tajawal/800.css';
const AmbientScene = lazy(() => import('./AmbientScene.js'));
const ProductScene = lazy(() => import('./ProductScene.js'));
const productTypes = [
  {
    id: 'bag',
    label: 'حقائب',
    title: 'رفيق كل مشوار.',
    description: 'حقيبة تحمل تفاصيل يومك، وتكمّل أسلوبك.',
  },
  {
    id: 'headphones',
    label: 'سماعات',
    title: 'على إيقاعك.',
    description: 'اختر مساحتك الخاصة من الصوت والهدوء.',
  },
  {
    id: 'watch',
    label: 'ساعات',
    title: 'وقتك، بطريقتك.',
    description: 'تفاصيل ترافقك من بداية يومك إلى آخره.',
  },
  {
    id: 'cup',
    label: 'أكواب',
    title: 'بداية ألطف.',
    description: 'أشياء صغيرة تستحق مكانًا في ركنك المفضل.',
  },
  {
    id: 'lamp',
    label: 'إضاءة',
    title: 'نور لركنك.',
    description: 'إضاءة تضيف دفئًا وشخصية إلى مساحتك.',
  },
  {
    id: 'wallet',
    label: 'محافظ',
    title: 'كل شيء بمكانه.',
    description: 'تفاصيل عملية لكل يوم ولكل مشوار.',
  },
] as const;

function BrandLogo() {
  return (
    <svg className="trend-logo" viewBox="214 308 755 267" role="img" aria-label="تريند سي">
      <image href={trendLogo} width="1184" height="911" />
    </svg>
  );
}

const money = (v: number) => new Intl.NumberFormat('ar-SY').format(v / 100) + ' ل.س';
const icons = {
  bag: ShoppingBag,
  headphones: Headphones,
  cup: Coffee,
  lamp: LampDesk,
  watch: Watch,
  wallet: Wallet,
};
let shopSession:
  | Promise<{
      pickupSites: PickupOption[];
      availability: { productId: string; available: number }[];
    }>
  | undefined;
function Art({
  product,
  large = false,
}: {
  product: Product;
  large?: boolean;
  interactive?: boolean;
}) {
  const Icon = icons[product.icon];
  const [failed, setFailed] = useState(false);
  return (
    <div className={`shop-art product-photo ${product.color} ${large ? 'large' : ''}`}>
      {failed ? (
        <Icon aria-label={product.name} />
      ) : (
        <img
          src={`/images/${product.id}.jpg`}
          alt={product.name}
          loading={large ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
function readCart(): CartItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem('shop-cart') ?? '[]');
    return Array.isArray(saved)
      ? saved
          .filter(
            (i) =>
              catalog.some((p) => p.id === i.productId) &&
              Number.isInteger(i.quantity) &&
              i.quantity > 0 &&
              i.quantity <= 5,
          )
          .slice(0, 6)
      : [];
  } catch {
    return [];
  }
}
export function Storefront() {
  const [cart, setCart] = useState<CartItem[]>(readCart);
  const [page, setPage] = useState<
    'browse' | 'product' | 'cart' | 'checkout' | 'orders' | 'success'
  >('browse');
  const [selectedProduct, setSelectedProduct] = useState<Product>(catalog[0]);
  const [category, setCategory] = useState('الكل');
  const [productType, setProductType] = useState('الكل');
  const [sort, setSort] = useState('featured');
  const [inStockOnly, setInStockOnly] = useState(false);
  function selectCategory(value: string) {
    setCategory(value);
    setProductType('الكل');
  }
  const [search, setSearch] = useState('');
  const [ready, setReady] = useState(false);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [stockStale, setStockStale] = useState(false);
  const available = (id: string) => stock[id] ?? 0;
  async function refreshStock() {
    const result = await api<{ availability: { productId: string; available: number }[] }>(
      '/api/storefront/availability',
    );
    setStock(Object.fromEntries(result.availability.map((p) => [p.productId, p.available])));
    setStockStale(false);
  }
  const [pickupSites, setPickupSites] = useState<PickupOption[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<'home' | 'pickup'>('home');
  const [paymentMode, setPaymentMode] = useState<'none' | 'cod'>('none');
  const [pickupSiteId, setPickupSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [quote, setQuote] = useState<StoreCheckout | null>(null);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [lastOrder, setLastOrder] = useState<StoreOrder | null>(null);
  const [proofs, setProofs] = useState<Record<string, { code: string; expiresAt: string }>>({});
  const [issuing, setIssuing] = useState<string | null>(null);
  async function getProof(id: string) {
    setIssuing(id);
    try {
      const proof = await api<{ code: string; expiresAt: string }>(
        `/api/storefront/orders/${id}/delivery-code`,
        { method: 'POST', body: '{}' },
      );
      setProofs((p) => ({ ...p, [id]: proof }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر إصدار الرمز');
    } finally {
      setIssuing(null);
    }
  }
  const [deliveryLocation, setDeliveryLocation] = useState<Coordinates | null>(null);
  const [address, setAddress] = useState({ recipientName: '', district: 'الروضة', address: '' });
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const count = cart.reduce((sum, i) => sum + i.quantity, 0);
  const subtotal = cart.reduce(
    (sum, i) => sum + catalog.find((p) => p.id === i.productId)!.priceMinor * i.quantity,
    0,
  );
  useEffect(() => {
    document.title = 'تريند سي | المتجر التجريبي';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#87176e');
    shopSession ??= api('/api/storefront/session', { method: 'POST', body: '{}' });
    void shopSession
      .then((session) => {
        setPickupSites(session.pickupSites);
        setStock(Object.fromEntries(session.availability.map((p) => [p.productId, p.available])));
        setPickupSiteId(session.pickupSites[0]?.id ?? '');
        setReady(true);
      })
      .catch(() => setError('تعذر الاتصال بالمتجر. حدّث الصفحة للمحاولة مجددًا.'));
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await api<{ availability: { productId: string; available: number }[] }>(
          '/api/storefront/availability',
        );
        if (!disposed) {
          setStock(Object.fromEntries(result.availability.map((p) => [p.productId, p.available])));
          setStockStale(false);
        }
      } catch {
        if (!disposed) setStockStale(true);
      }
    };
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [ready]);
  useEffect(() => {
    try {
      localStorage.setItem('shop-cart', JSON.stringify(cart));
    } catch {
      /* The cart still works in memory when browser storage is unavailable. */
    }
  }, [cart]);
  useEffect(() => {
    heading.current?.focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
    setError('');
  }, [page]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2800);
    return () => clearTimeout(timer);
  }, [notice]);
  async function refreshOrders() {
    const result = await api<{ orders: StoreOrder[] }>('/api/storefront/orders');
    setOrders(result.orders);
    setError('');
  }
  useEffect(() => {
    if (page !== 'orders' || !ready) return;
    const refresh = () =>
      void refreshOrders().catch(() => setError('تعذر تحديث الطلبات. يمكنك إعادة المحاولة.'));
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [page, ready]);
  function change(productId: string, delta: number) {
    if (quote || busy) return;
    setCart((items) => {
      const existing = items.find((i) => i.productId === productId);
      const quantity = (existing?.quantity ?? 0) + delta;
      if (delta > 0 && quantity > available(productId)) {
        setNotice('الكمية المتاحة أقل من المطلوب. اختر كمية أخرى.');
        return items;
      }
      if (quantity > 5) {
        setNotice('الحد التجريبي خمس قطع من كل منتج');
        return items;
      }
      return quantity <= 0
        ? items.filter((i) => i.productId !== productId)
        : existing
          ? items.map((i) => (i.productId === productId ? { ...i, quantity } : i))
          : [...items, { productId, quantity }];
    });
  }
  async function getQuote(event: FormEvent) {
    event.preventDefault();
    if (address.recipientName.trim().length < 2) {
      setError('اكتب اسم المستلم من حرفين على الأقل.');
      return;
    }
    if (deliveryMode === 'home' && address.address.trim().length < 5) {
      setError('اكتب عنوانًا واضحًا من خمسة أحرف على الأقل.');
      return;
    }
    if (deliveryMode === 'pickup' && !pickupSiteId) {
      setError('اختر نقطة استلام أولًا.');
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      setQuote(
        await api<StoreCheckout>('/api/storefront/checkouts', {
          method: 'POST',
          body: JSON.stringify({
            items: cart,
            paymentMode,
            ...address,
            ...(deliveryMode === 'home' && deliveryLocation ? { location: deliveryLocation } : {}),
            ...(deliveryMode === 'pickup'
              ? {
                  pickupSiteId,
                  address: pickupSites.find((p) => p.id === pickupSiteId)?.address ?? '',
                }
              : {}),
          }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر حساب التوصيل');
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }
  async function confirm() {
    if (!quote || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<StoreOrder>('/api/storefront/orders', {
        method: 'POST',
        body: JSON.stringify({ checkoutId: quote.id }),
      });
      setLastOrder(result);
      setCart([]);
      setQuote(null);
      setPage('success');
      void refreshStock().catch(() => setStockStale(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تأكيد الطلب');
      if (
        e instanceof ApiError &&
        ['OUT_OF_STOCK', 'INVENTORY_INCONSISTENT', 'INVALID_ORIGIN', 'QUOTE_EXPIRED'].includes(
          e.code,
        )
      )
        setQuote(null);
      void refreshStock().catch(() => setStockStale(true));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }
  const categoryProducts = catalog.filter((p) => category === 'الكل' || p.category === category);
  const products = catalog.filter(
    (p) =>
      (category === 'الكل' || p.category === category) &&
      (productType === 'الكل' || p.id === productType) &&
      (!inStockOnly || available(p.id) > 0) &&
      `${p.name} ${p.subtitle}`.includes(search.trim()),
  );
  products.sort((a, b) =>
    sort === 'price-low'
      ? a.priceMinor - b.priceMinor
      : sort === 'price-high'
        ? b.priceMinor - a.priceMinor
        : 0,
  );
  const sceneProduct =
    catalog.find((p) => p.id === productType) ?? categoryProducts[0] ?? catalog[0];
  const sceneCopy =
    productType === 'الكل'
      ? {
          title:
            category === 'الكل'
              ? 'اختيارات على ذوقك.'
              : category === 'تقنية'
                ? 'تقنية بإيقاعك.'
                : category === 'للمنزل'
                  ? 'ركنك، بطريقتك.'
                  : 'رفيق كل مشوار.',
          description: 'اختر القسم ونوع المنتج، ووصل للي يناسبك.',
        }
      : productTypes.find((type) => type.id === productType)!;
  function quantity(item: CartItem) {
    return (
      <div className="shop-quantity">
        <button
          aria-label={`زيادة ${catalog.find((p) => p.id === item.productId)!.name}`}
          disabled={
            busy || !!quote || item.quantity === 5 || item.quantity >= available(item.productId)
          }
          onClick={() => change(item.productId, 1)}
        >
          <Plus size={15} />
        </button>
        <span>{item.quantity}</span>
        <button
          aria-label={`تقليل ${catalog.find((p) => p.id === item.productId)!.name}`}
          disabled={busy || !!quote}
          onClick={() => change(item.productId, -1)}
        >
          <Minus size={15} />
        </button>
      </div>
    );
  }
  const orderCard = (order: StoreOrder) => (
    <article
      className="shop-order"
      key={order.checkoutId}
      data-notification-target={order.shipment.reference}
      tabIndex={-1}
    >
      <div className="shop-order-top">
        <span>
          <Package size={20} />
          <b dir="ltr">{order.shipment.reference}</b>
        </span>
        <span className={`status status-${order.shipment.status}`}>
          <span />
          {statusLabels[order.shipment.status]}
        </span>
      </div>
      <div className="shop-order-products">
        {order.items.map((item) => (
          <span key={item.productId}>
            {catalog.find((p) => p.id === item.productId)?.name} × {item.quantity}
          </span>
        ))}
      </div>
      {order.shipment.collection && (
        <div className="shop-stock-notice">
          {order.shipment.collection.status === 'pending' &&
          ['cancelled', 'returning', 'returned'].includes(order.shipment.status)
            ? 'لم يُسجّل تحصيل نقدي؛ الطلب ملغى أو في مسار الإرجاع.'
            : order.shipment.collection.status === 'pending'
              ? `مطلوب نقدًا عند الاستلام: ${money(order.shipment.collection.totalMinor)}`
              : 'سُجّل استلام المبلغ النقدي كاملًا مع تسليم طلبك.'}
        </div>
      )}
      <div
        className="shop-progress"
        style={{
          gridTemplateColumns: `repeat(${order.shipment.pickupSiteId ? 5 : 4},minmax(0,1fr))`,
        }}
        aria-label="مراحل الطلب"
      >
        {(order.shipment.pickupSiteId
          ? ['تأكيد الطلب', 'تجهيز النقل', 'إلى النقطة', 'جاهز للاستلام', 'تم الاستلام']
          : ['تأكيد الطلب', 'تجهيز النقل', 'في الطريق', 'تم التسليم']
        ).map((label, i) => {
          const index = {
            awaiting_handover: 2,
            ready_for_pickup: 3,
            pickup_expired: -1,
            ready: 0,
            assigned: 1,
            picked_up: 1,
            in_transit: 2,
            delivered: order.shipment.pickupSiteId ? 4 : 3,
            failed: 2,
            cancelled: -1,
            returning: -1,
            returned: -1,
          }[order.shipment.status];
          return (
            <div key={label} className={i <= index ? 'done' : ''}>
              <span>{i <= index ? <Check size={14} /> : i + 1}</span>
              <small>{label}</small>
            </div>
          );
        })}
      </div>
      {order.shipment.pickupSiteId && (
        <div className="shop-pickup-info">
          <MapPin size={20} />
          <div>
            <b>{order.shipment.pickupSiteName}</b>
            <p>{order.shipment.destination}</p>
            {order.shipment.status === 'ready_for_pickup' && order.shipment.pickupExpiresAt && (
              <small>
                الطرد جاهز. استلمه قبل{' '}
                {new Date(order.shipment.pickupExpiresAt).toLocaleString('ar-SY')}
              </small>
            )}
            {order.shipment.status === 'pickup_expired' && (
              <small>انتهت مهلة الاستلام. يجري تنظيم إرجاع الطرد.</small>
            )}
          </div>
        </div>
      )}
      <div className="shop-order-bottom">
        <span>
          الإجمالي <b>{money(order.subtotalMinor + order.shipment.feeMinor)}</b>
        </span>
        {order.shipment.status !== 'cancelled' && (
          <a href={`/?tracking=${order.shipment.trackingToken}`} target="_blank" rel="noreferrer">
            تفاصيل التتبع <ArrowLeft size={16} />
          </a>
        )}
      </div>
      <CustomerReturn order={order} onChanged={refreshOrders} />
      <ServiceRatings order={order} onChanged={refreshOrders} />
      {order.shipment.status === 'in_transit' && <LocationSharing shipment={order.shipment} />}
      {((!order.shipment.pickupSiteId && order.shipment.status === 'in_transit') ||
        (order.shipment.pickupSiteId &&
          order.shipment.status === 'ready_for_pickup' &&
          order.shipment.pickupExpiresAt &&
          new Date(order.shipment.pickupExpiresAt).getTime() > Date.now())) && (
        <div className="shop-delivery-proof">
          <ShieldCheck size={21} />
          <div>
            <b>رمز استلام طلبك</b>
            <p>شارك الرمز مع مسؤول التسليم عند استلام الطرد فقط. لا يظهر في رابط التتبع العام.</p>
            {proofs[order.shipment.id] && (
              <>
                <strong dir="ltr" data-testid="delivery-code">
                  {proofs[order.shipment.id].code}
                </strong>
                <small>
                  صالح حتى{' '}
                  {new Date(proofs[order.shipment.id].expiresAt).toLocaleTimeString('ar-SY')}
                </small>
              </>
            )}
            <button
              className="shop-secondary"
              disabled={issuing !== null}
              onClick={() => void getProof(order.shipment.id)}
            >
              {issuing === order.shipment.id
                ? 'جارٍ الإصدار…'
                : proofs[order.shipment.id]
                  ? 'إصدار رمز جديد'
                  : 'إظهار رمز الاستلام'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
  return (
    <div className="shop">
      <div className="shop-ribbon">
        <span dir="ltr">THE EVERYDAY EDIT</span> مساحة عرض تجريبية · دون دفع فعلي
      </div>
      <header className="shop-header">
        <a href="/shop" className="shop-brand" aria-label="تريند سي — الصفحة الرئيسية">
          <BrandLogo />
        </a>
        <nav aria-label="تنقل المتجر">
          <button
            className={page === 'browse' ? 'selected' : ''}
            onClick={() => {
              setQuote(null);
              setPage('browse');
            }}
            disabled={busy}
          >
            اكتشف
          </button>
          <button
            className={page === 'orders' ? 'selected' : ''}
            onClick={() => {
              setQuote(null);
              setPage('orders');
            }}
            disabled={!ready || busy}
          >
            طلباتي
          </button>
        </nav>
        {ready && (
          <Notifications
            identity="customer"
            customer
            onOpen={(item) => {
              focusNotificationTarget(item.reference);
              setQuote(null);
              setPage('orders');
              void refreshOrders().catch(() => {});
            }}
          />
        )}
        <button
          className="shop-bag"
          aria-label={`السلة، ${count} منتجات`}
          disabled={busy}
          onClick={() => {
            setQuote(null);
            setPage('cart');
          }}
        >
          <ShoppingBag size={21} />
          <span>السلة</span>
          <b>{count}</b>
        </button>
      </header>
      <main className="shop-main">
        <div className="shop-location">
          <MapPin size={15} /> التوصيل داخل دمشق <span>متجر بيت الشام</span>
        </div>
        {error && (
          <div role="alert" className="shop-error">
            {error}
            {page === 'orders' && (
              <button
                onClick={() =>
                  void refreshOrders()
                    .then(() => setError(''))
                    .catch(() => setError('تعذر الاتصال؛ حاول مجددًا'))
                }
              >
                إعادة المحاولة
              </button>
            )}
          </div>
        )}
        {stockStale && (
          <p className="shop-stock-notice" role="status">
            تعذر تحديث التوفر. سنعيد المحاولة؛ يُتحقق من الكمية مجددًا عند تأكيد الطلب.
          </p>
        )}
        {page === 'browse' && (
          <>
            <section className="shop-hero immersive-hero">
              <span className="hero-watermark" aria-hidden="true" dir="ltr">
                TREND
              </span>
              <div className="shop-hero-copy">
                <span className="shop-eyebrow">
                  <span className="edition-dot" /> مو بس أشياء. أسلوب حياة.
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  على ذوقك.
                  <br />
                  <em>على كيفك.</em>
                </h1>
                <p>
                  أشياء تحبّها، وتفاصيل تشبهك. اختيارات للبيت، للعمل، ولكل يوم يستحق شيئًا مختلفًا.
                </p>
                <div className="hero-actions">
                  <a className="shop-primary" href="#shop-products">
                    اكتشف اختياراتك <ArrowUpLeft size={21} />
                  </a>
                  <a className="hero-text-link" href="#shop-collections">
                    خذ جولة في تريند سي <ArrowLeft size={17} />
                  </a>
                </div>
                <div className="hero-note">
                  <span /> من دمشق، ليومك. <small dir="ltr">SELECTED WITH CHARACTER</small>
                </div>
              </div>
              <div className="hero-collage">
                <div className="collage-main">
                  <img
                    src="/images/headphones.jpg"
                    alt="سماعات سوداء في تصوير استديو بخلفية صفراء"
                    fetchPriority="high"
                  />
                  <span dir="ltr">TURN UP YOUR EVERYDAY.</span>
                </div>
                <div className="collage-secondary">
                  <img src="/images/watch.jpg" alt="ساعة ذكية بتفاصيل واضحة" />
                  <span>وقت لشيء جديد.</span>
                </div>
                <div className="collage-note">
                  <span className="note-star">✳</span>
                  <span>
                    تفاصيل صغيرة.
                    <br />
                    <b>فرق كبير.</b>
                  </span>
                </div>
                <div className="ambient-jewel" aria-hidden="true">
                  <Suspense fallback={<span className="ambient-fallback" />}>
                    <AmbientScene />
                  </Suspense>
                </div>
                <span className="collage-caption" dir="ltr">
                  THE TREND SY EDIT — 2026 / VOL. 01
                </span>
              </div>
            </section>
            <div className="brand-ticker" aria-hidden="true">
              <span>تفاصيل تشبهك</span>
              <b>✳</b>
              <span dir="ltr">GOOD THINGS. GREAT DAYS.</span>
              <b>✳</b>
              <span>اختيارات بذوق</span>
              <b>✳</b>
              <span dir="ltr">TREND SY</span>
            </div>
            <section
              className="shop-collections"
              id="shop-collections"
              aria-label="اكتشف المجموعات"
            >
              <a
                href="#shop-products"
                className="collection-tile collection-tech"
                onClick={() => selectCategory('تقنية')}
              >
                <img src="/images/headphones.jpg" alt="" loading="lazy" />
                <div>
                  <span dir="ltr">01 / TUNE IN</span>
                  <h2>تقنية بإيقاعك.</h2>
                  <p>مساحة للهدوء. وطاقة لكل يوم.</p>
                </div>
                <ArrowUpLeft />
              </a>
              <a
                href="#shop-products"
                className="collection-tile collection-home"
                onClick={() => selectCategory('للمنزل')}
              >
                <img src="/images/cup.jpg" alt="" loading="lazy" />
                <div>
                  <span dir="ltr">02 / SLOW DOWN</span>
                  <h2>ركنك، بطريقتك.</h2>
                  <p>تفاصيل تجعل البيت أقرب إليك.</p>
                </div>
                <ArrowUpLeft />
              </a>
              <a
                href="#shop-products"
                className="collection-tile collection-style"
                onClick={() => selectCategory('إكسسوارات')}
              >
                <img src="/images/wallet.jpg" alt="" loading="lazy" />
                <div>
                  <span dir="ltr">03 / GO YOUR WAY</span>
                  <h2>رفيق كل مشوار.</h2>
                  <p>اختيارات تكمّل أسلوبك.</p>
                </div>
                <ArrowUpLeft />
              </a>
            </section>
            <div className="shop-benefits">
              <span>
                <Truck />{' '}
                <span>
                  <b>من اختيارك إلى بابك</b>
                  <small>توصيل محلي داخل دمشق</small>
                </span>
              </span>
              <span>
                <ShieldCheck />{' '}
                <span>
                  <b>كل التفاصيل أمامك</b>
                  <small>راجع المنتجات والتكلفة قبل التأكيد</small>
                </span>
              </span>
              <span>
                <Package />{' '}
                <span>
                  <b>طلبك، خطوة بخطوة</b>
                  <small>تتبع رحلة التوصيل من مكان واحد</small>
                </span>
              </span>
            </div>
            <section id="shop-products" className="shop-products">
              <div className="catalog-stage">
                <div className="catalog-stage-copy">
                  <span className="shop-eyebrow">
                    اكتشف مجموعتك ·{' '}
                    {productType === 'الكل'
                      ? category === 'الكل'
                        ? 'جميع المنتجات'
                        : category
                      : productTypes.find((type) => type.id === productType)?.label}
                  </span>
                  <h2>{sceneCopy.title}</h2>
                  <p>{sceneCopy.description}</p>
                </div>
                <div className="catalog-background-model" aria-hidden="true" key={sceneProduct.id}>
                  <Suspense fallback={null}>
                    <ProductScene
                      product={sceneProduct}
                      decorative
                      color={category === 'للمنزل' ? '#b3c796' : '#caabb9'}
                    />
                  </Suspense>
                </div>
                <span className="catalog-stage-word" dir="ltr" aria-hidden="true">
                  YOUR EDIT.
                </span>
              </div>
              <div className="catalog-filter-panel">
                <div className="catalog-filter-group">
                  <h3>تسوّق حسب القسم</h3>
                  <div className="shop-categories" aria-label="أقسام المتجر">
                    {['الكل', 'للمنزل', 'تقنية', 'إكسسوارات'].map((c) => (
                      <button
                        key={c}
                        aria-pressed={category === c}
                        className={category === c ? 'selected' : ''}
                        onClick={() => selectCategory(c)}
                      >
                        {c === 'الكل' ? 'جميع الأقسام' : c}
                        <span>
                          {catalog.filter((p) => c === 'الكل' || p.category === c).length}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="catalog-filter-group">
                  <h3>نوع المنتج</h3>
                  <div className="product-type-filters" aria-label="أنواع المنتجات">
                    <button
                      aria-pressed={productType === 'الكل'}
                      className={productType === 'الكل' ? 'selected' : ''}
                      onClick={() => setProductType('الكل')}
                    >
                      كل الأنواع
                    </button>
                    {productTypes
                      .filter((type) => categoryProducts.some((p) => p.id === type.id))
                      .map((type) => {
                        const Icon = icons[type.id];
                        return (
                          <button
                            key={type.id}
                            aria-pressed={productType === type.id}
                            className={productType === type.id ? 'selected' : ''}
                            onClick={() => setProductType(type.id)}
                          >
                            <Icon size={17} />
                            {type.label}
                          </button>
                        );
                      })}
                  </div>
                </div>
                <div className="catalog-tools">
                  <label className="shop-search">
                    <Search size={18} />
                    <input
                      aria-label="ابحث عن منتج"
                      placeholder="اسم المنتج أو كلمة تصفه…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label className="catalog-sort">
                    ترتيب حسب
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                      <option value="featured">اختيارات المتجر</option>
                      <option value="price-low">السعر: الأقل أولًا</option>
                      <option value="price-high">السعر: الأعلى أولًا</option>
                    </select>
                  </label>
                  <label className="catalog-stock-filter">
                    <input
                      type="checkbox"
                      checked={inStockOnly}
                      onChange={(e) => setInStockOnly(e.target.checked)}
                    />
                    المتوفر فقط
                  </label>
                </div>
              </div>
              <div className="catalog-results">
                <p role="status">
                  {productType === 'الكل'
                    ? category === 'الكل'
                      ? 'جميع المنتجات'
                      : category
                    : productTypes.find((type) => type.id === productType)?.label}{' '}
                  <span>
                    ·{' '}
                    {products.length === 1
                      ? 'منتج واحد'
                      : products.length === 2
                        ? 'منتجان'
                        : `${products.length} منتجات`}
                  </span>
                  {search && <span> · نتائج «{search}»</span>}
                </p>
                {(category !== 'الكل' ||
                  productType !== 'الكل' ||
                  search ||
                  inStockOnly ||
                  sort !== 'featured') && (
                  <button
                    onClick={() => {
                      selectCategory('الكل');
                      setSearch('');
                      setInStockOnly(false);
                      setSort('featured');
                    }}
                  >
                    <X size={14} /> مسح الفلاتر
                  </button>
                )}
              </div>
              <div className="shop-grid">
                {products.map((product) => (
                  <article className="shop-product" key={product.id}>
                    <div className="product-visual">
                      <Art product={product} />
                      <span className="product-index" dir="ltr">
                        0{catalog.indexOf(product) + 1}
                      </span>
                      <button
                        className="product-preview"
                        aria-label={`تفاصيل ${product.name}`}
                        onClick={() => {
                          setSelectedProduct(product);
                          setPage('product');
                        }}
                      >
                        <ArrowUpLeft size={18} />
                        <span>اكتشفه</span>
                      </button>
                    </div>
                    <div className="shop-product-copy">
                      <small>{product.category}</small>
                      <h3>
                        <button
                          className="shop-product-title"
                          onClick={() => {
                            setSelectedProduct(product);
                            setPage('product');
                          }}
                        >
                          {product.name}
                        </button>
                      </h3>
                      <p>{product.subtitle}</p>
                      <p className={`shop-stock ${available(product.id) === 0 ? 'empty' : ''}`}>
                        {!ready
                          ? 'جارٍ التحقق من التوفر…'
                          : available(product.id) === 0
                            ? 'نفدت الكمية'
                            : `متاح الآن · ${available(product.id)} قطعة`}
                      </p>
                      <div>
                        <strong>{money(product.priceMinor)}</strong>
                        <button
                          aria-label={`أضف ${product.name} إلى السلة`}
                          disabled={
                            !ready ||
                            available(product.id) <=
                              (cart.find((i) => i.productId === product.id)?.quantity ?? 0) ||
                            cart.some((i) => i.productId === product.id && i.quantity >= 5)
                          }
                          onClick={() => {
                            change(product.id, 1);
                            setNotice(`أضيف ${product.name} إلى سلتك`);
                          }}
                        >
                          <Plus size={19} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              {!products.length && (
                <div className="shop-empty">
                  <Search />
                  <h3>لم نجد منتجًا بهذا الاسم</h3>
                  <p>جرّب كلمة أخرى أو اختر جميع المنتجات.</p>
                  <button
                    onClick={() => {
                      setSearch('');
                      selectCategory('الكل');
                      setInStockOnly(false);
                    }}
                  >
                    عرض الجميع
                  </button>
                </div>
              )}
            </section>
          </>
        )}
        {page === 'product' && (
          <>
            <button className="shop-back" onClick={() => setPage('browse')}>
              <ArrowLeft size={16} /> العودة للمجموعة
            </button>
            <section className="shop-detail">
              <div className="detail-visual">
                <Art product={selectedProduct} large interactive />
              </div>
              <div>
                <span className="shop-eyebrow">{selectedProduct.category} · متجر بيت الشام</span>
                <h1 ref={heading} tabIndex={-1}>
                  {selectedProduct.name}
                </h1>
                <p>{selectedProduct.subtitle}</p>
                <strong>{money(selectedProduct.priceMinor)}</strong>
                <div className="shop-detail-facts">
                  <span>
                    <Truck size={18} /> التوصيل داخل دمشق
                  </span>
                  <span>
                    <Package size={18} /> الوزن التجريبي: {selectedProduct.weightKg} كغ
                  </span>
                  <span>
                    <ShieldCheck size={18} /> رسوم التوصيل تُحسب قبل التأكيد
                  </span>
                </div>
                <button
                  className="shop-primary"
                  disabled={
                    !ready ||
                    available(selectedProduct.id) <=
                      (cart.find((i) => i.productId === selectedProduct.id)?.quantity ?? 0) ||
                    cart.some((i) => i.productId === selectedProduct.id && i.quantity >= 5)
                  }
                  onClick={() => {
                    change(selectedProduct.id, 1);
                    setNotice(`أضيف ${selectedProduct.name} إلى سلتك`);
                  }}
                >
                  <Plus size={19} />{' '}
                  {available(selectedProduct.id) ? 'أضف إلى السلة' : 'نفدت الكمية'}
                </button>
                <button className="shop-edit" onClick={() => setPage('cart')}>
                  عرض السلة ({count})
                </button>
                <small>
                  صورة توضيحية ومنتج اصطناعي لاختبار تجربة الطلب؛ لا يمثل مخزونًا للبيع.
                </small>
              </div>
            </section>
          </>
        )}
        {(page === 'cart' || page === 'checkout') && (
          <>
            <button
              className="shop-back"
              disabled={busy}
              onClick={() => {
                setQuote(null);
                setPage(page === 'checkout' ? 'cart' : 'browse');
              }}
            >
              <ArrowLeft size={16} /> {page === 'checkout' ? 'العودة إلى السلة' : 'متابعة التسوق'}
            </button>
            <h1 ref={heading} tabIndex={-1} className="shop-page-title">
              {page === 'cart'
                ? 'سلتك، على ذوقك.'
                : quote
                  ? 'كل شيء واضح، قبل التأكيد.'
                  : 'إلى أين نوصّل طلبك؟'}
            </h1>
            <p className="shop-subtitle">
              {page === 'cart'
                ? 'راجع اختياراتك، ثم نرتب خطوة التوصيل.'
                : '١ السلة · ٢ عنوان التوصيل · ٣ المراجعة والتأكيد'}
            </p>
            {!cart.length ? (
              <div className="shop-empty">
                <ShoppingBag />
                <h2>سلتك تنتظر أول اختيار</h2>
                <p>تصفّح المجموعة وأضف ما يعجبك.</p>
                <button className="shop-primary" onClick={() => setPage('browse')}>
                  اكتشف المنتجات <ArrowLeft size={18} />
                </button>
              </div>
            ) : (
              <div className="shop-checkout-layout">
                <section className="shop-panel">
                  {page === 'cart' ? (
                    cart.map((item) => {
                      const p = catalog.find((p) => p.id === item.productId)!;
                      return (
                        <div className="shop-cart-row" key={p.id}>
                          <Art product={p} />
                          <div>
                            <h3>{p.name}</h3>
                            <small>{money(p.priceMinor)} للقطعة</small>
                            {quantity(item)}
                          </div>
                          <div>
                            <b>{money(p.priceMinor * item.quantity)}</b>
                            <button
                              className="shop-remove"
                              aria-label={`حذف ${p.name}`}
                              onClick={() =>
                                setCart((items) => items.filter((i) => i.productId !== p.id))
                              }
                            >
                              <X size={15} /> إزالة
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : quote ? (
                    <>
                      <h2>
                        <MapPin size={21} /> عنوان التوصيل
                      </h2>
                      <div className="shop-address">
                        <b>{address.recipientName}</b>
                        <p>
                          {deliveryMode === 'pickup'
                            ? pickupSites.find((p) => p.id === pickupSiteId)?.name +
                              ' · ' +
                              pickupSites.find((p) => p.id === pickupSiteId)?.address
                            : address.district + '، ' + address.address + '، دمشق'}
                        </p>
                      </div>
                      <h2>
                        <Package size={21} /> اختياراتك
                      </h2>
                      <div className="shop-review-items">
                        {cart.map((i) => (
                          <p key={i.productId}>
                            <span>
                              {catalog.find((p) => p.id === i.productId)!.name} × {i.quantity}
                            </span>
                            <b>
                              {money(
                                catalog.find((p) => p.id === i.productId)!.priceMinor * i.quantity,
                              )}
                            </b>
                          </p>
                        ))}
                      </div>
                      <div className="shop-help">
                        <ShieldCheck size={20} />
                        <span>
                          التأكيد ينشئ شحنة حقيقية داخل النظام التجريبي. لن يتم خصم أموال أو إرسال
                          رسائل.
                        </span>
                      </div>
                    </>
                  ) : (
                    <form id="shop-address-form" onSubmit={getQuote} noValidate>
                      <h2>
                        <MapPin size={22} /> بيانات المستلم
                      </h2>
                      <label>
                        اسم المستلم
                        <input
                          autoComplete="name"
                          required
                          minLength={2}
                          maxLength={80}
                          value={address.recipientName}
                          onChange={(e) =>
                            setAddress({ ...address, recipientName: e.target.value })
                          }
                          placeholder="الاسم الكامل"
                        />
                      </label>
                      <fieldset className="shop-delivery-choice">
                        <legend>كيف تود استلام الطلب؟</legend>
                        <label className={deliveryMode === 'home' ? 'selected' : ''}>
                          <input
                            type="radio"
                            name="delivery-mode"
                            checked={deliveryMode === 'home'}
                            onChange={() => setDeliveryMode('home')}
                          />
                          <span>
                            <b>توصيل إلى العنوان</b>
                            <small>يصلك الطرد مع المندوب</small>
                          </span>
                        </label>
                        <label className={deliveryMode === 'pickup' ? 'selected' : ''}>
                          <input
                            type="radio"
                            name="delivery-mode"
                            checked={deliveryMode === 'pickup'}
                            disabled={!pickupSites.length}
                            onChange={() => setDeliveryMode('pickup')}
                          />
                          <span>
                            <b>الاستلام من نقطة قريبة</b>
                            <small>مهلة 72 ساعة بعد وصول الطرد</small>
                          </span>
                        </label>
                      </fieldset>
                      <CustomerLocations
                        key={deliveryMode}
                        pickup={deliveryMode === 'pickup'}
                        points={pickupSites}
                        selectedPoint={pickupSiteId}
                        initial={
                          deliveryMode === 'home'
                            ? {
                                district: address.district,
                                details: address.address,
                                point: deliveryLocation,
                              }
                            : undefined
                        }
                        onPoint={setPickupSiteId}
                        onAddress={(district, details, point) => {
                          setAddress((current) => ({ ...current, district, address: details }));
                          setDeliveryLocation(point);
                          setQuote(null);
                        }}
                      />
                      <p className="shop-field-note">
                        التجربة الحالية للتوصيل داخل دمشق. استخدم بيانات اصطناعية للعرض.
                      </p>
                      <label>
                        طريقة الدفع في التجربة
                        <select
                          aria-label="طريقة الدفع في التجربة"
                          value={paymentMode}
                          onChange={(e) => {
                            setPaymentMode(e.target.value as 'none' | 'cod');
                            setQuote(null);
                          }}
                        >
                          <option value="none">عرض تجريبي دون تحصيل أموال</option>
                          <option value="cod">نقدًا عند الاستلام — محاكاة مالية</option>
                        </select>
                      </label>
                      <p className="shop-field-note">
                        اختيار النقد يسجل عهدة مالية تجريبية عند الاستلام. لا تُجرِ دفعًا حقيقيًا
                        خلال العرض.
                      </p>
                    </form>
                  )}
                </section>
                <aside className="shop-summary">
                  <h2>ملخص الطلب</h2>
                  <p>
                    <span>المنتجات ({count})</span>
                    <b>{money(subtotal)}</b>
                  </p>
                  <p>
                    <span>التوصيل</span>
                    <b>{quote ? money(quote.quote.feeMinor) : 'يُحسب بعد العنوان'}</b>
                  </p>
                  <div className="shop-total">
                    <span>{quote ? 'الإجمالي النهائي' : 'إجمالي المنتجات'}</span>
                    <b>{money(subtotal + (quote?.quote.feeMinor ?? 0))}</b>
                  </div>
                  {quote && (
                    <div className="shop-stock-notice">
                      تجهيز كامل الطلب من <strong>{quote.fulfillmentOrigin.name}</strong>. يُثبت
                      توفر الكميات عند تأكيد الطلب.
                    </div>
                  )}
                  {quote && (
                    <div className="shop-stock-notice">
                      {quote.paymentMode === 'cod'
                        ? 'الدفع نقدًا عند الاستلام: كامل الإجمالي الظاهر أعلاه.'
                        : 'هذا الطلب تجريبي دون تحصيل نقدي.'}
                    </div>
                  )}
                  {quote && (
                    <p className="shop-estimate">
                      <ClockIcon />
                      {quote.quote.estimateLabel}
                    </p>
                  )}
                  {page === 'cart' ? (
                    <button
                      className="shop-primary"
                      disabled={!ready}
                      onClick={() => setPage('checkout')}
                      key="continue-to-checkout"
                      type="button"
                    >
                      المتابعة إلى التوصيل <ArrowLeft size={18} />
                    </button>
                  ) : quote ? (
                    <>
                      <button
                        className="shop-primary"
                        disabled={busy}
                        onClick={() => void confirm()}
                      >
                        {busy ? <LoaderCircle className="spin" /> : <CheckCircle2 size={19} />}{' '}
                        تأكيد الطلب التجريبي
                      </button>
                      <p className="shop-stock-notice">
                        تُحجز الكميات عند التأكيد لمدة 24 ساعة حتى التجهيز. إضافة المنتجات للسلة
                        وحساب التوصيل لا يحجزانها.
                      </p>
                      <button className="shop-edit" disabled={busy} onClick={() => setQuote(null)}>
                        تعديل البيانات / تحديث العرض
                      </button>
                      <small>
                        العرض صالح حتى{' '}
                        {new Date(quote.quote.expiresAt).toLocaleTimeString('ar-SY', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </small>
                    </>
                  ) : (
                    <button
                      className="shop-primary"
                      type="submit"
                      form="shop-address-form"
                      key="request-shipping-quote"
                      disabled={busy || !ready}
                    >
                      {busy ? <LoaderCircle className="spin" /> : <Truck size={19} />} حساب التوصيل
                      ومراجعة الطلب
                    </button>
                  )}
                  <div className="shop-summary-note">
                    <ShieldCheck size={17} /> دون دفع فعلي في هذه التجربة
                  </div>
                </aside>
              </div>
            )}
          </>
        )}
        {page === 'success' && lastOrder && (
          <section className="shop-success">
            <div className="shop-success-icon">
              <CheckCircle2 size={40} />
            </div>
            <span className="shop-eyebrow">خطوتك اكتملت</span>
            <h1 ref={heading} tabIndex={-1}>
              طلبك وصل إلينا.
            </h1>
            <p>
              تم إنشاء الشحنة في المنصة اللوجستية. يمكنك متابعة حالتها هنا بينما ينفذ فريق العمليات
              والمندوب الرحلة.
            </p>
            {orderCard(lastOrder)}
            <div className="shop-success-actions">
              <button className="shop-primary" onClick={() => setPage('orders')}>
                متابعة طلباتي <ArrowLeft size={18} />
              </button>
              <button className="shop-secondary" onClick={() => setPage('browse')}>
                العودة للمتجر
              </button>
            </div>
          </section>
        )}
        {page === 'orders' && (
          <>
            <div className="shop-section-heading">
              <div>
                <h1 ref={heading} tabIndex={-1}>
                  طلباتي
                </h1>
                <p className="shop-subtitle">
                  كل خطوة في مكان واحد. تُحدّث الحالات تلقائيًا كل خمس ثوانٍ.
                </p>
              </div>
              <button
                className="shop-secondary"
                onClick={() => void refreshOrders().catch(() => setError('تعذر تحديث الطلبات'))}
              >
                تحديث الحالة
              </button>
            </div>
            {orders.length ? (
              <div className="shop-orders">{orders.map(orderCard)}</div>
            ) : (
              <div className="shop-empty">
                <Package />
                <h2>بداية جديدة، واختيارات كثيرة</h2>
                <p>ستظهر طلبات جلسة المتصفح هذه هنا بعد التأكيد.</p>
                <button className="shop-primary" onClick={() => setPage('browse')}>
                  ابدأ التسوق <ArrowLeft size={18} />
                </button>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="shop-footer">
        <div>
          <BrandLogo />
          <p>اختيارات تشبهك، وتفاصيل تجعل يومك أجمل.</p>
        </div>
        <a href="/" target="_blank" rel="noreferrer">
          افتح لوحة العمليات <ArrowLeft size={17} />
        </a>
        <small>محاكاة متجر · صور عرض فوتوغرافية · مخزون تجريبي · دون دفع فعلي</small>
      </footer>
      {notice && (
        <div className="shop-toast" role="status">
          <CheckCircle2 size={19} />
          {notice}
          <button aria-label="إغلاق الإشعار" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function ClockIcon() {
  return <Truck size={15} />;
}
