export const catalog = [
  {
    id: 'bag',
    name: 'حقيبة يومية',
    subtitle: 'خفيفة، عملية، وترافق كل مشوار',
    category: 'إكسسوارات',
    priceMinor: 18500000,
    weightKg: 0.6,
    color: 'sand',
    icon: 'bag',
  },
  {
    id: 'headphones',
    name: 'سماعات لاسلكية',
    subtitle: 'مساحتك الخاصة من الهدوء',
    category: 'تقنية',
    priceMinor: 24500000,
    weightKg: 0.4,
    color: 'lilac',
    icon: 'headphones',
  },
  {
    id: 'cup',
    name: 'كوب سيراميك',
    subtitle: 'بداية ألطف لقهوة الصباح',
    category: 'للمنزل',
    priceMinor: 6500000,
    weightKg: 0.5,
    color: 'peach',
    icon: 'cup',
  },
  {
    id: 'lamp',
    name: 'مصباح مكتبي',
    subtitle: 'إضاءة دافئة لركنك المفضل',
    category: 'للمنزل',
    priceMinor: 13500000,
    weightKg: 1.2,
    color: 'sage',
    icon: 'lamp',
  },
  {
    id: 'watch',
    name: 'ساعة ذكية',
    subtitle: 'تفاصيل صغيرة ليوم أكثر ترتيبًا',
    category: 'تقنية',
    priceMinor: 29500000,
    weightKg: 0.2,
    color: 'blue',
    icon: 'watch',
  },
  {
    id: 'wallet',
    name: 'محفظة بسيطة',
    subtitle: 'كل ما تحتاجه في مكان واحد',
    category: 'إكسسوارات',
    priceMinor: 8500000,
    weightKg: 0.15,
    color: 'rose',
    icon: 'wallet',
  },
] as const;
export type Product = (typeof catalog)[number];
export interface CartItem {
  productId: string;
  quantity: number;
}
export interface StoreCheckout {
  paymentMode: 'none' | 'cod';
  id: string;
  fulfillmentOrigin: { id: string; name: string };
  quote: {
    priority: 'normal' | 'urgent';
    feeMinor: number;
    expiresAt: string;
    estimateLabel: string;
  };
  subtotalMinor: number;
  items: CartItem[];
}
export interface StoreOrder {
  ratings?: import('./customer-locations.js').ServiceRating[];
  commercialReturn?: import('./commercial-returns.js').CommercialReturn | null;
  checkoutId: string;
  items: CartItem[];
  subtotalMinor: number;
  shipment: import('./contracts.js').Shipment;
}
