import { useEffect, useRef, useState } from 'react';
import type { LocationView } from '../shared/location.js';
import 'leaflet/dist/leaflet.css';
import { tileUrl, tileOptions } from './map-config.js';
export default function CourierMap({ point }: { point: NonNullable<LocationView['point']> }) {
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<{
    map: import('leaflet').Map;
    marker: import('leaflet').CircleMarker;
    circle: import('leaflet').Circle;
  } | null>(null);
  const latest = useRef(point);
  latest.current = point;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import('leaflet')
      .then((L) => {
        if (disposed || !host.current) return;
        const p = latest.current;
        const center: [number, number] = [p.latitude, p.longitude];
        const map = L.map(host.current, { scrollWheelZoom: false }).setView(center, 15);
        L.tileLayer(tileUrl, tileOptions)
          .on('tileerror', () => setFailed(true))
          .addTo(map);
        const circle = L.circle(center, {
          radius: p.accuracy,
          color: '#0b8177',
          fillOpacity: 0.12,
          weight: 1,
        }).addTo(map);
        const marker = L.circleMarker(center, {
          radius: 9,
          color: '#fff',
          weight: 3,
          fillColor: '#0b8177',
          fillOpacity: 1,
        }).addTo(map);
        marker.bindTooltip('آخر موقع مشارك', { direction: 'top' });
        layer.current = { map, marker, circle };
        observer = new ResizeObserver(() => map.invalidateSize());
        observer.observe(host.current);
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      observer?.disconnect();
      layer.current?.map.remove();
      layer.current = null;
    };
  }, []);
  useEffect(() => {
    const l = layer.current;
    if (!l) return;
    const c: [number, number] = [point.latitude, point.longitude];
    l.marker.setLatLng(c);
    l.circle.setLatLng(c).setRadius(point.accuracy);
  }, [point]);
  return (
    <>
      <div ref={host} className="courier-map" role="region" aria-label="خريطة موقع المندوب" />
      <button
        className="location-link"
        type="button"
        onClick={() => layer.current?.map.setView([point.latitude, point.longitude], 15)}
      >
        إعادة توسيط موقع المندوب
      </button>
      {failed && (
        <p className="location-note">
          تعذر تحميل بعض أجزاء الخريطة. آخر تحديث ودقة الموقع يظهران أدناه.
        </p>
      )}
    </>
  );
}
