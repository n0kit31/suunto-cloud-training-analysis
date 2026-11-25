import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { circleMarker, control, divIcon, map, marker, polyline, tileLayer } from 'leaflet';
import type { CircleMarker, LatLngTuple, Map } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useResource } from './api';
import { useLanguage } from './i18n';
import { routeMarkerShapes } from './route-markers';
import { routePosition, routeSamples } from './route-position';
import type { TimedPoint } from './route-position';

function routeMarker(point: LatLngTuple, kind: keyof typeof routeMarkerShapes, label: string) {
  const isStart = kind === 'start';
  return marker(point, {
    title: label,
    icon: divIcon({
      className: `route-map-marker route-${kind}`,
      iconSize: [22, 22],
      iconAnchor: [11, isStart ? 22 : 0],
      html: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="route-marker-bg" cx="12" cy="12" r="11"/><path class="route-marker-glyph" d="${routeMarkerShapes[kind]}"/></svg>`,
    }),
  }).bindTooltip(label, { direction: isStart ? 'top' : 'bottom', offset: [0, isStart ? -22 : 22] });
}

export default function WorkoutRouteMap({ url, children, cursorTime }: {
  url: string; children: ReactNode; cursorTime: number | null;
}) {
  const { t } = useLanguage();
  const container = useRef<HTMLDivElement>(null);
  const cursor = useRef<{ map: Map; dot: CircleMarker }>(null);
  const { data, error, loading } = useResource<{ segments: TimedPoint[][] | null }>(url, 0, 0);
  const segments = data?.segments;
  const samples = useMemo(() => routeSamples(segments ?? []), [segments]);
  const [tileError, setTileError] = useState(false);
  const zoomIn = t('Powiększ');
  const zoomOut = t('Pomniejsz');
  const startLabel = t('Start');
  const finishLabel = t('Meta');

  useEffect(() => {
    const element = container.current;
    const lines = segments?.map(line => line.map(([lat, lon]): LatLngTuple => [lat, lon]));
    const start = lines?.[0]?.[0];
    const finish = lines?.at(-1)?.at(-1);
    if (!element || !lines || !start || !finish) return;

    const instance = map(element, { scrollWheelZoom: false, maxZoom: 19, zoomControl: false });
    control.zoom({ zoomInTitle: zoomIn, zoomOutTitle: zoomOut }).addTo(instance);
    const tiles = tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
      referrerPolicy: 'origin',
      maxZoom: 19,
      updateWhenIdle: true,
    });
    tiles.on('loading', () => setTileError(false));
    tiles.on('tileerror', () => setTileError(true));
    instance.attributionControl.setPrefix(false);

    const route = polyline(lines, { color: '#c31633', weight: 4, interactive: false }).addTo(instance);
    routeMarker(start, 'start', startLabel).addTo(instance);
    routeMarker(finish, 'finish', finishLabel).addTo(instance);
    instance.fitBounds(route.getBounds(), { padding: [26, 26], maxZoom: 17 });
    tiles.addTo(instance);
    const dot = circleMarker(start, {
      radius: 7, color: '#fff', weight: 3, fillColor: '#24679c', fillOpacity: 1, interactive: false,
    });
    cursor.current = { map: instance, dot };
    const resize = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    resize.observe(element);
    return () => {
      resize.disconnect();
      instance.remove();
      cursor.current = null;
    };
  }, [segments, startLabel, finishLabel, zoomIn, zoomOut]);

  useEffect(() => {
    const layer = cursor.current;
    if (!layer) return;
    const point = routePosition(samples, cursorTime);
    if (point) {
      layer.dot.setLatLng(point).addTo(layer.map).bringToFront();
    } else {
      layer.dot.remove();
    }
  }, [samples, cursorTime, startLabel, finishLabel, zoomIn, zoomOut]);

  if (loading) return <p className="muted" role="status">{t('Wczytywanie mapy…')}</p>;
  if (error || !segments) return <>
    <p className="text-error" role="alert">{t('Nie udało się wczytać mapy.')}</p>
    {children}
  </>;
  return <>
    <div className="route-map" ref={container} role="region" aria-label={t('Mapa trasy GPS')} />
    {tileError && <p className="muted" role="status">{t('Część podkładu mapy jest niedostępna.')}</p>}
  </>;
}
