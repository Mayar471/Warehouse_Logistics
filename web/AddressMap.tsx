import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Coordinates } from '../shared/customer-locations.js';
import { tileUrl, tileOptions } from './map-config.js';
export default function AddressMap({
  point,
  onChange,
}: {
  point: Coordinates | null;
  onChange: (p: Coordinates) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    callback = useRef(onChange),
    layer = useRef<{ map: L.Map; marker: L.CircleMarker | null } | null>(null);
  const [failed, setFailed] = useState(false);
  callback.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current).setView(
      point ? [point.latitude, point.longitude] : [33.5138, 36.2765],
      14,
    );
    const tiles = L.tileLayer(tileUrl, tileOptions).addTo(map);
    tiles.on('tileerror', () => setFailed(true));
    layer.current = { map, marker: null };
    map.on('click', (e) =>
      callback.current({
        latitude: Number(e.latlng.lat.toFixed(6)),
        longitude: Number(e.latlng.lng.toFixed(6)),
      }),
    );
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      map.remove();
      layer.current = null;
    };
  }, []);
  useEffect(() => {
    const l = layer.current;
    if (!l) return;
    if (!point) {
      l.marker?.remove();
      l.marker = null;
      return;
    }
    const position: L.LatLngExpression = [point.latitude, point.longitude];
    if (l.marker) l.marker.setLatLng(position);
    else
      l.marker = L.circleMarker(position, {
        radius: 9,
        color: '#fff',
        weight: 3,
        fillColor: '#762557',
        fillOpacity: 1,
      }).addTo(l.map);
    l.map.setView(position, l.map.getZoom());
  }, [point]);
  return (
    <div className="address-map-shell">
      <div
        className="address-map"
        ref={host}
        role="region"
        aria-label="تحديد موقع العنوان على الخريطة"
      />
      <p>اضغط على مكانك لتحديد الدبوس. مركز الخريطة الافتراضي ليس موقعك.</p>
      {point && (
        <small dir="ltr">
          {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
        </small>
      )}
      {failed && (
        <p role="status">
          تعذر تحميل بعض أجزاء الخريطة. يمكنك استخدام موقعك الحالي، أو إعادة المحاولة عند توفر
          الاتصال.
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setFailed(false);
              layer.current?.map.eachLayer((l) => {
                if (l instanceof L.TileLayer) l.redraw();
              });
            }}
          >
            إعادة تحميل الخريطة
          </button>
        </p>
      )}
    </div>
  );
}
