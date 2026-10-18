export const partnerActions = {
  release: 'تسليم الأجر للمستفيد',
  confirm: 'تأكيد استلام كامل الأجر',
  cancel: 'إلغاء الحجز',
  report_issue: 'توثيق فرق بالمبلغ',
  request_return: 'إقرار إعادة النقد دون استلامه',
  receive_return: 'استلام النقد المعاد',
  request_recovery: 'إقرار رد الأجر المستلم',
  receive_recovery: 'استلام الأجر المسترد',
} as const;
export type PartnerAction = keyof typeof partnerActions;
export interface PartnerPayment {
  id: string;
  shipmentId: string;
  reference: string;
  beneficiaryName: string;
  companyId: string | null;
  courierId: string;
  amountMinor: number;
  status: 'reserved' | 'released' | 'received' | 'cancelled' | 'returned' | 'recovered';
  version: number;
  issueOpen: boolean;
  returnRequested: boolean;
  recoveryRequested: boolean;
}
export interface PartnerPaymentView {
  eligible: {
    shipmentId: string;
    reference: string;
    beneficiaryName: string;
    amountMinor: number;
  }[];
  rows: PartnerPayment[];
  history: {
    id: string;
    action: string;
    actorName: string;
    reference: string;
    reason: string;
    details: { amountMinor?: number };
  }[];
  balance: {
    treasuryMinor: number;
    reservedMinor: number;
    availableMinor: number;
    inTransitMinor: number;
    paidMinor: number;
  } | null;
  displayLimit: number;
}
