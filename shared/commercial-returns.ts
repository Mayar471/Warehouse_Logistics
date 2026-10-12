export interface CommercialReturn {
  id: string;
  shipmentId: string;
  shipmentReference: string;
  merchantId: string;
  merchantName: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
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
  approved: 'مقبول — بانتظار تنظيم استلام البضاعة',
  rejected: 'لم يقبل المتجر طلب الإرجاع',
  cancelled: 'سُحب طلب الإرجاع',
};
