export const tileUrl =
  import.meta.env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const tileOptions = {
  maxZoom: 19,
  minZoom: 3,
  keepBuffer: 0,
  referrerPolicy: 'origin' as const,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' +
    (import.meta.env.VITE_MAP_ATTRIBUTION ? ' | ' + import.meta.env.VITE_MAP_ATTRIBUTION : ''),
};
