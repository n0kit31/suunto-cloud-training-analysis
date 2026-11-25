import React, { lazy, Suspense, useState } from 'react';
import { LoaderCircle, Route } from 'lucide-react';
import { useResource } from './api';
import { useLanguage } from './i18n';
import { routeMarkerShapes } from './route-markers';

type Point = [number, number];
const WorkoutRouteMap = lazy(() => import('./WorkoutRouteMap'));

export function WorkoutRoute({ id, analysisVersion, cursorTime }: {
  id: string; analysisVersion: number; cursorTime: number | null;
}) {
  const { t } = useLanguage();
  const [retry, setRetry] = useState(0);
  const url = `/api/workouts/${encodeURIComponent(id)}/route?revision=${analysisVersion}`;
  const route = useResource<{ segments: Point[][] | null }>(url, retry, 0);
  const segments = route.data?.segments;
  const start = segments?.[0]?.[0];
  const finish = segments?.at(-1)?.at(-1);

  return <section className="panel" aria-labelledby="route-heading">
    <div className="panel__header">
      <h2 id="route-heading"><Route size={21} aria-hidden="true" />{t('Trasa GPS')}</h2>
    </div>
    <div className="panel__body route-panel__body">
      {route.loading ? <p className="route-status muted" role="status">
        <LoaderCircle size={17} className="spinning" aria-hidden="true" />{t('Wczytywanie trasy…')}
      </p> : route.error ? <>
        <p className="text-error" role="alert">{t('Nie udało się wczytać trasy.')}</p>
        <button type="button" className="button" onClick={() => setRetry(retry + 1)}>{t('Spróbuj ponownie')}</button>
      </> : segments && start && finish ? <>
        <p className="route-map-note muted">{t('Mapa pobiera kafelki oglądanego obszaru z OpenStreetMap.')}</p>
        <Suspense fallback={<p className="muted" role="status">{t('Wczytywanie mapy…')}</p>}>
          <WorkoutRouteMap key={url} url={url + '&view=map'} cursorTime={cursorTime}>
            <svg className="workout-route" viewBox="0 0 800 360" role="img" aria-label={t('Ślad GPS z oznaczonym startem i metą')}>
              {segments.map((line, index) => <polyline key={index} points={line.map((point) => point.join(',')).join(' ')}
                vectorEffect="non-scaling-stroke" />)}
              <g className="route-start" transform={`translate(${start[0] - 12} ${start[1] - 24})`}>
                <circle className="route-marker-bg" cx="12" cy="12" r="11" />
                <path className="route-marker-glyph" d={routeMarkerShapes.start} />
              </g>
              <g className="route-finish" transform={`translate(${finish[0] - 12} ${finish[1]})`}>
                <circle className="route-marker-bg" cx="12" cy="12" r="11" />
                <path className="route-marker-glyph" d={routeMarkerShapes.finish} />
              </g>
            </svg>
          </WorkoutRouteMap>
        </Suspense>
        <ul className="route-legend">
          <li><svg className="route-start" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="route-marker-bg" cx="12" cy="12" r="11" /><path className="route-marker-glyph" d={routeMarkerShapes.start} />
          </svg>{t('Start')}</li>
          <li><svg className="route-finish" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="route-marker-bg" cx="12" cy="12" r="11" /><path className="route-marker-glyph" d={routeMarkerShapes.finish} />
          </svg>{t('Meta')}</li>
        </ul>
      </> : <p className="muted">{t('Brak danych GPS do wyświetlenia trasy.')}</p>}
    </div>
  </section>;
}
