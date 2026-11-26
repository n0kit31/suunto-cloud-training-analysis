# Private workout route preview

The web app now opens an OpenStreetMap basemap above the charts, with a
local route fallback when map geometry cannot be loaded. The embedded chart
cursor highlights the corresponding position on the route. The following
assessment records the implementation options considered before that change.

**Start with a local route preview in workout detail.** A standalone SVG polyline can show the route shape, direction, and start and finish without depending on an internet connection. Project the GPS points with a consistent scale, fit the view to the route, and keep separate track segments separate. This is enough to recognize a loop or an out-and-back. Street names and trail context would require a basemap. [W3C SVG polyline specification](https://www.w3.org/TR/SVG/shapes.html#PolylineElement)

## Leaflet with a basemap

Leaflet can draw the same segmented route in the browser, fit the viewport to it, and add a separately configured tile layer for geographic context and pan and zoom. With a client-rendered overlay, the tile request carries the tile coordinates and zoom. A provider could infer the area of the workout from the tiles requested when the app fits the viewport to the route. OSMF also says it collects request metadata such as IP address, referring page, and request time. [Leaflet polyline and tile layer reference](https://leafletjs.com/reference#polyline) · [OSMF privacy policy](https://osmfoundation.org/wiki/Privacy_Policy#Personal_data_we_receive_automatically)

OSM's public raster service is best-effort, offers no SLA, and can block access without notice. It requires the published HTTPS endpoint, visible OpenStreetMap attribution, compliant client identification and a valid web referrer, and caching that honors server headers (or at least seven days when the cache cannot read them). Bulk downloads, prefetching, and offline tile downloads are prohibited. The app currently sends `Referrer-Policy: no-referrer` and its page policy restricts images to same-origin and data URLs, so direct OSM tile loading would require changes to both policies. If geographic context becomes important, evaluate an opt-in basemap with explicit disclosure of the requested area and keep the route visible when tiles fail. [OSMF raster tile policy](https://operations.osmfoundation.org/policies/tiles/) · [Web server policies](../web/server/main.ts)

## Fit with the current app

The worker already retains the source FIT for analyzed workouts. The GPX exporter demonstrates validation of decoded latitude and longitude and segmentation on timer resumes. Workout detail currently receives metrics, laps, and chart availability. Reuse the FIT decoding path to derive minimal route geometry locally and deliver it through the app's existing local access and no-store policies. Use retained FITs for older workouts where available, and show a route-unavailable state for indoor workouts or activities without enough valid GPS points. Keep the geometry out of AI requests and public examples. [FIT analysis bridge](../suunto_cloud/web_bridge.mjs) · [GPX exporter](../suunto_cloud/fit/export_gpx.cjs) · [Workout detail](../web/client/src/WorkoutDetail.tsx) · [Web app data handling](web.md)

## Estimated effort and operating costs

- **Local route preview:** 0.5–1 development day, with no map service fee.
- **Interactive map with an optional hosted basemap:** 1–2 development days in total, including older workouts, missing GPS, and a fallback when tiles fail. MapTiler Cloud currently lists a free plan for personal or non-commercial use, subject to usage limits and attribution. [MapTiler pricing](https://www.maptiler.com/cloud/pricing/) · [MapTiler Cloud terms](https://www.maptiler.com/terms/cloud/)
- **Offline basemap for one region:** 2–4 development days in total. The app owner needs storage for the regional extract and a way to update it. [Protomaps regional downloads](https://docs.protomaps.com/basemaps/downloads)
