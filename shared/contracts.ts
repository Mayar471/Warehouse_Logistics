export type Role = 'operator' | 'merchant' | 'courier' | 'pickup';
export type ShipmentStatus =
  | 'awaiting_handover'
  | 'ready_for_pickup'
  | 'pickup_expired'
  | 'ready'
  | 'assigned'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'returning'
  | 'returned';
export type Action =
  | 'prepare'
  | 'handover_origin'
  | 'arrive_pickup'
  | 'receive_pickup'
  | 'release_pickup'
  | 'assign_return'
  | 'handover_return'
  | 'assign'
  | 'accept'
  | 'decline'
  | 'unassign'
  | 'pickup'
  | 'depart'
  | 'deliver'
  | 'fail'
  | 'cancel'
  | 'return'
  | 'receive_return';
export interface Account {
  id: string;
  name: string;
  role: Role;
  merchantId: string | null;
  pickupSiteId?: string | null;
  courierId: string | null;
}
export interface Courier {
  rating?: number | null;
  ratingCount?: number;
  id: string;
  name: string;
  vehicle: string;
  capacityKg: number;
  activeKg: number;
  available: boolean;
}
export interface Site {
  rating?: number | null;
  ratingCount?: number;
  latitude?: number | null;
  longitude?: number | null;
  version: number;
  pickupEnabled: boolean;
  pickupCapacityKg: number;
  reservedKg: number;
  id: string;
  name: string;
  city: string;
  address: string;
  kind: string;
  merchantId: string | null;
}
export interface Shipment {
  deliveryCourier?: { id: string; name: string } | null;
  deliveryLocation?: import('./customer-locations.js').Coordinates | null;
  collection: import('./cash.js').Collection | null;
  originHandoverRequired: boolean;
  originPrepared: boolean;
  originReleased: boolean;
  originReceived: boolean;
  pickupDueAt: string | null;
  pickupOverdue: boolean;
  id: string;
  reference: string;
  externalReference: string;
  merchantId: string;
  merchantName: string;
  recipientName: string;
  destination: string;
  originId: string;
  originName: string;
  weightKg: number;
  status: ShipmentStatus;
  courierId: string | null;
  courierName: string | null;
  assignmentAccepted: boolean;
  pickupSiteId: string | null;
  pickupSiteName: string | null;
  custodySiteId: string | null;
  pickupExpiresAt: string | null;
  deliveryProofRequired: boolean;
  assignmentExpiresAt: string | null;
  feeMinor: number;
  currency: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  trackingToken?: string;
}
export interface TimelineEvent {
  id: string;
  shipmentId: string;
  type: string;
  description: string;
  actorName: string;
  createdAt: string;
}
export interface Quote {
  id: string;
  feeMinor: number;
  currency: string;
  expiresAt: string;
  estimateLabel: string;
}
export interface ShipmentInput {
  collection?: { goodsMinor: number; currency: 'SYP' };
  pickupSiteVersion?: number;
  pickupSiteId?: string;
  externalReference: string;
  originId: string;
  recipientName: string;
  destination: string;
  weightKg: number;
}
export interface Bootstrap {
  account: Account;
  shipments: Shipment[];
  couriers: Courier[];
  sites: Site[];
  stats: { total: number; active: number; delivered: number; exceptions: number };
}
export interface OutboxEvent {
  retryCount: number;
  cycleAttempts: number;
  lastError: string | null;
  id: string;
  shipmentId: string;
  type: string;
  status: string;
  attempts: number;
  createdAt: string;
}
export interface Reconciliation {
  checkedAt: string;
  total: number;
  matched: number;
  displayLimit: number;
  differences: {
    shipmentId: string | null;
    reference: string | null;
    sourceVersion: number | null;
    sourceStatus: ShipmentStatus | null;
    receiverVersion: number | null;
    receiverStatus: ShipmentStatus | null;
    kind: 'missing' | 'behind' | 'ahead' | 'conflict' | 'orphan';
  }[];
  audit: { actorId: string; action: string; entityId: string; reason: string; createdAt: string }[];
}
export interface IntegrationState {
  paused: boolean;
  events: OutboxEvent[];
  received: { eventId: string; type: string; shipmentId: string; receivedAt: string }[];
}
export const statusLabels: Record<ShipmentStatus, string> = {
  awaiting_handover: 'بانتظار تسليم نقطة الاستلام',
  ready_for_pickup: 'جاهزة لاستلام العميل',
  pickup_expired: 'انتهت مهلة الاستلام',
  ready: 'جاهزة للإسناد',
  assigned: 'بانتظار الاستلام',
  picked_up: 'تم الاستلام',
  in_transit: 'في الطريق',
  delivered: 'تم التسليم',
  failed: 'تعذر التسليم',
  cancelled: 'ملغاة',
  returning: 'قيد الإرجاع',
  returned: 'تم الإرجاع',
};
