export interface CommercialReturn {
  refund: CustomerRefund | null;
  inspectionComplete: boolean;
  id: string;
  shipmentId: string;
  shipmentReference: string;
  recipientName: string;
  updatedAt: string;
  merchantId: string;
  merchantName: string;
  status:
    | 'requested'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'assigned'
    | 'accepted'
    | 'released'
    | 'in_transit'
    | 'received';
  courierId: string | null;
  courierName: string | null;
  collectionAddress: string | null;
  originName: string;
  assignmentExpiresAt: string | null;
  issueOpen: boolean;
  acceptedAt: string | null;
  releasedAt: string | null;
  pickedUpAt: string | null;
  receivedAt: string | null;
  version: number;
  items: { productId: string; quantity: number }[];
  goodsMinor: number;
  currency: 'SYP';
  reason: string;
  decisionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  cancelledAt: string | null;
}
export interface CommercialReturnView {
  total: number;
  active: number;
  received: number;
  couriers: import('./contracts.js').Courier[];
  requested: number;
  approved: number;
  rows: CommercialReturn[];
  history: {
    id: string;
    returnId: string;
    action: string;
    actorName: string;
    reference: string;
    reason: string;
    createdAt: string;
  }[];
}
export const commercialReturnLabels = {
  requested: 'بانتظار مراجعة المتجر',
  approved: 'مقبول — بانتظار إسناد الاستلام',
  assigned: 'بانتظار قبول مندوب الإرجاع',
  accepted: 'قبل المندوب — بانتظار تسليم العميل',
  released: 'تسليم العميل مسجل — بانتظار إقرار المندوب',
  in_transit: 'مع المندوب — في طريق الإرجاع',
  received: 'وصل للمنشأ — البضاعة في مسار الفحص',
  rejected: 'لم يقبل المتجر طلب الإرجاع',
  cancelled: 'سُحب طلب الإرجاع',
};

export interface CustomerRefund {
  lastReportedMinor: number | null;
  id: string;
  status: 'requested' | 'reserved' | 'released' | 'confirmed' | 'cancelled';
  version: number;
  amountMinor: number;
  currency: 'SYP';
  issueOpen: boolean;
  releasedAt: string | null;
  confirmedAt: string | null;
}
export const refundLabels = {
  requested: 'اعتمد المتجر رد قيمة البضائع',
  reserved: 'حُجز التمويل — بانتظار تسليم النقد',
  released: 'خرج النقد — بانتظار تأكيد العميل',
  confirmed: 'أكد العميل استلام كامل الرد',
  cancelled: 'أُلغي قرار الرد قبل خروج النقد',
};
