export interface InventoryView {
  totals: { stockTotal: number; available: number; reserved: number; quarantine: number };
  displayLimit: number;
  stocks: {
    merchantId: string;
    merchantName: string;
    siteId: string;
    siteName: string;
    productId: string;
    onHand: number;
    reserved: number;
    quarantine: number;
    available: number;
    prepared: number;
    inTransit: number;
    version: number;
  }[];
  movements: {
    siteId: string;
    siteName: string | null;
    merchantName: string | null;
    id: string;
    productId: string;
    shipmentId: string | null;
    kind: string;
    quantity: number;
    actorName: string;
    reason: string;
    createdAt: string;
  }[];
  returns: {
    id: string;
    reference: string;
    version: number;
    items: {
      productId: string;
      quantity: number;
      originalQuantity: number;
      restocked: number;
      discarded: number;
    }[];
  }[];
}
export interface InventorySitesView {
  merchants: { id: string; name: string }[];
  sites: {
    id: string;
    name: string;
    address: string;
    city: string;
    kind: string;
    version: number;
    merchantId: string;
    merchantName: string;
    products: string[];
  }[];
  audit: {
    id: string;
    siteId: string;
    siteName: string;
    action: string;
    actorName: string;
    reason: string;
    createdAt: string;
  }[];
}
