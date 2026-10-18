import { latLngToCell, polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS } from 'h3-js';
import type { Coordinates } from '../shared/customer-locations.js';
export const dispatchResolution = 6;
export const dispatchCell = (p: Coordinates) =>
  latLngToCell(p.latitude, p.longitude, dispatchResolution);
const covers = new Map<string, string[]>();
// Cover the complete spherical-cap bounding rectangle, including intersecting cells.
// An ordinary center-based polyfill or fixed gridDisk can miss boundary candidates.
export function dispatchCover(p: Coordinates, radiusKm: number): string[] | null {
  const angular = radiusKm / 6371,
    degrees = 180 / Math.PI;
  const lat = p.latitude / degrees,
    deltaLat = angular * degrees;
  if (Math.abs(lat) + angular >= Math.PI / 2) return null;
  const deltaLon = Math.asin(Math.sin(angular) / Math.cos(lat)) * degrees;
  if (p.longitude - deltaLon <= -180 || p.longitude + deltaLon >= 180) return null;
  const key = `${p.latitude}:${p.longitude}:${radiusKm}`;
  const cached = covers.get(key);
  if (cached) return cached;
  try {
    const cells = polygonToCellsExperimental(
      [
        [p.latitude - deltaLat, p.longitude - deltaLon],
        [p.latitude - deltaLat, p.longitude + deltaLon],
        [p.latitude + deltaLat, p.longitude + deltaLon],
        [p.latitude + deltaLat, p.longitude - deltaLon],
      ],
      dispatchResolution,
      POLYGON_TO_CELLS_FLAGS.containmentOverlappingBbox,
    );
    if (!cells.length) return null;
    if (covers.size >= 128) covers.delete(covers.keys().next().value!);
    covers.set(key, cells);
    return cells;
  } catch {
    return null;
  } // Conservative exhaustive fallback, never an empty shortlist.
}
