export const districts = [
  'الروضة',
  'المزة',
  'المالكي',
  'الصالحية',
  'كفرسوسة',
  'أبو رمانة',
] as const;
export interface Coordinates {
  latitude: number;
  longitude: number;
}
export interface CustomerAddress extends Coordinates {
  id: string;
  label: 'home' | 'work' | 'custom';
  name: string;
  district: string;
  details: string;
  version: number;
}
export interface PickupOption {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  ratingCount: number;
  distanceKm?: number;
}
export interface ServiceRating {
  kind: 'courier' | 'pickup';
  score: number;
  comment: string;
}
export function distanceKm(a: Coordinates, b: Coordinates) {
  const rad = (n: number) => (n * Math.PI) / 180,
    dLat = rad(b.latitude - a.latitude),
    dLon = rad(b.longitude - a.longitude);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}
