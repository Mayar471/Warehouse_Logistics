export interface Payout {
  id: string;
  shipmentId: string;
  shipmentReference: string;
  merchantId: string;
  merchantName: string;
  amountMinor: number;
  currency: 'SYP';
  status: 'reserved' | 'released' | 'received' | 'cancelled' | 'returned' | 'recovered';
  version: number;
  issueOpen: boolean;
  returnRequested: boolean;
  returnedAt: string | null;
  recoveryRequested: boolean;
  recoveredAt: string | null;
  createdAt: string;
  releasedAt: string | null;
  receivedAt: string | null;
}
export interface PayoutView {
  availableMinor: number;
  reservedMinor: number;
  inTransitMinor: number;
  paidMinor: number;
  recoveryPendingMinor: number;
  total: number;
  consistent: boolean;
  eligible: {
    shipmentId: string;
    shipmentReference: string;
    merchantName: string;
    amountMinor: number;
    collectionVersion: number;
  }[];
  rows: Payout[];
  history: {
    id: string;
    payoutId: string;
    action: string;
    actorName: string;
    reference: string;
    reason: string;
    createdAt: string;
    details: Record<string, unknown>;
  }[];
}
