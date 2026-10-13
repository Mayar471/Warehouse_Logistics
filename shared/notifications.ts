export interface UserNotification {
  id: string;
  title: string;
  reference: string;
  kind: 'shipment' | 'return' | 'transfer' | 'cash' | 'payout' | 'refund';
  targetId: string;
  page: 'shipments' | 'returns' | 'transfers' | 'cash' | 'payouts' | 'orders';
  actionRequired: boolean;
  createdAt: string;
  read: boolean;
}
export interface NotificationFeed {
  items: UserNotification[];
  unread: number;
}
