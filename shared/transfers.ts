export type TransferStatus =
  | 'reserved'
  | 'assigned'
  | 'accepted'
  | 'released'
  | 'in_transit'
  | 'received'
  | 'resolved'
  | 'cancelled';
export interface InventoryTransfer {
  id: string;
  merchantId: string;
  merchantName: string;
  sourceId: string;
  sourceName: string;
  destinationId: string;
  destinationName: string;
  status: TransferStatus;
  version: number;
  issueOpen: boolean;
  weightKg: number;
  courierId: string | null;
  courierName: string | null;
  holdExpiresAt: string;
  assignmentExpiresAt: string | null;
  createdAt: string;
  lines: {
    productId: string;
    quantity: number;
    received: number;
    lost: number;
    damaged: number;
    restocked: number;
    discarded: number;
  }[];
}
export interface TransferView {
  total: number;
  active: number;
  pendingInspection: number;
  rows: InventoryTransfer[];
}
export interface TransferEvent {
  id: string;
  action: string;
  actorName: string;
  reason: string;
  createdAt: string;
  details: Record<string, unknown>;
}
