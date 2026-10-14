import type { Shipment } from './contracts.js';

export const activeShipmentStatuses = [
  'ready',
  'assigned',
  'picked_up',
  'in_transit',
  'awaiting_handover',
  'ready_for_pickup',
  'returning',
];
export function matchesShipmentFilter(s: Shipment, filter: string): boolean {
  if (filter === 'all' || filter === 'shipments') return true;
  if (filter === 'active') return activeShipmentStatuses.includes(s.status);
  if (filter === 'attention')
    return ['failed', 'pickup_expired'].includes(s.status) || s.pickupOverdue;
  return s.status === filter;
}
