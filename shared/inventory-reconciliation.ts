export interface InventoryReconciliationRow {
  merchantId: string;
  siteId: string;
  productId: string;
  merchantName: string;
  siteName: string;
  onHand: number | null;
  reserved: number | null;
  quarantine: number | null;
  version: number | null;
  ledgerOnHand: number;
  ledgerReserved: number;
  ledgerQuarantine: number;
  reservedFromOrders: number;
  reservedForTransfers: number;
  quarantineFromReturns: number;
  quarantineFromTransfers: number;
  unknownMovements: number;
  matched: boolean;
  differences: string[];
}
export interface InventoryReconciliation {
  checkedAt: string;
  total: number;
  matched: number;
  exceptions: number;
  displayLimit: number;
  rows: InventoryReconciliationRow[];
}
export interface InventoryCount {
  id: string;
  merchantId: string;
  siteId: string;
  productId: string;
  before: number;
  counted: number;
  delta: number;
  reserved: number;
  quarantine: number;
  actorName: string;
  reason: string;
  createdAt: string;
}
