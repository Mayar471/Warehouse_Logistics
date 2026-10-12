export function parseCashAmount(value: string) {
  let text = value
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.');
  if (/[٬,]/.test(text)) {
    if (!/^\d{1,3}(?:[٬,]\d{3})+(?:\.\d{1,2})?$/.test(text)) return NaN;
    text = text.replace(/[٬,]/g, '');
  }
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return NaN;
  const [whole, part = ''] = text.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}
export interface CashConfirmation {
  amountMinor: number;
  currency: 'SYP';
  reference: string;
}
export interface Collection {
  goodsMinor: number;
  feeMinor: number;
  totalMinor: number;
  currency: 'SYP';
  status: 'pending' | 'collected' | 'received';
  version: number;
  issueOpen: boolean;
}
export interface CashRow extends Collection {
  remittanceCount: number;
  remittanceReturn: {
    id: string;
    status: 'requested' | 'released';
    issueOpen: boolean;
    lastReportedMinor: number | null;
  } | null;
  shipmentStatus: import('./contracts.js').ShipmentStatus;
  shipmentId: string;
  shipmentReference: string;
  merchantName: string;
  collectorName: string | null;
  collectedAt: string | null;
  receivedAt: string | null;
}
export interface CashView {
  refundedMinor: number;
  refundInTransitMinor: number;
  returnIssueCount: number;
  netRemittedMinor: number;
  remittanceReturnTransitMinor: number;
  operationsBalanceMinor: number;
  payoutInTransitMinor: number;
  consistent: boolean;
  total: number;
  pendingMinor: number;
  heldMinor: number;
  receivedMinor: number;
  goodsLiabilityMinor: number;
  deliveryClearingMinor: number;
  rows: CashRow[];
  history: {
    id: string;
    shipmentReference: string;
    action: string;
    actorName: string;
    reference: string;
    reason: string;
    createdAt: string;
    details: Record<string, unknown>;
  }[];
}
