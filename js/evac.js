/* ═══════════════════════════════════════════════
   RiskMapper Nepal — evac.js
   Smart Route Finder: Shortest + Safest Road Path
   to Nearest Open Space

   ALGORITHM
   ─────────────────────────────────────────────
   1. Get user GPS position (fallback: Ward 10 centroid)
   2. Query Overpass API for open spaces within 3 km
   3. Sort by straight-line distance, keep top 5
   4. For each candidate, request a walking route
      from OSRM (Open Source Routing Machine) —
      returns actual road geometry, no API key needed
   5. Sample ward risk every ~50 m along each route:
        avgRisk = mean(wardMap[nearestWard(pt)].score)
   6. Composite score (lower = better):
        composite = 0.85 × norm(distKm)
                  + 0.15 × norm(avgRisk)
      where norm() rescales each metric to 0–1
      across all candidates so the two terms are
      on the same scale before weighting.
   7. Pick route with lowest composite = shortest
      road path that avoids high-risk ward corridors
   8. Draw on map:
        • White border polyline (contrast layer)
        • Blue filled polyline (Google-Maps style)
        • Green destination pin with permanent label
        • Grey pins for rejected alternatives
   9. Populate panel:
        • Distance / ETA / Safety% summary grid
        • Corridor risk badge (color-coded)
        • Turn-by-turn direction steps from OSRM
        • Alternative options list

   OSRM public API (walking mode, no key required):
     https://router.project-osrm.org/route/v1/foot/
     Coordinates in lng,lat order (not lat,lng).
     Falls back to straight-line if OSRM unreachable.
═══════════════════════════════════════════════ */

let parkMode = false;
let parkMarkers = [];        // all Leaflet layers added in this mode
let userLocationMarker = null;

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const OSRM_TIMEOUT_MS = 9000;
let nearbyBuildingsCache = [];

// ─── Timeout wrapper (AbortSignal.timeout not universal) ───────────────────
function timedFetch(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ─── Haversine great-circle distance (km) ──────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Nearest ward to a point ───────────────────────────────────────────────
function nearestWard(lat, lng) {
  let best = null, bestDist = Infinity;
  RISK_DATA.wards.forEach(w => {
    const d = haversine(lat, lng, w.lat, w.lng);
    if (d < bestDist) { bestDist = d; best = w; }
  });
  return best;
}

// ─── Sample average ward risk score along OSRM route geometry ──────────────
// OSRM returns coordinates as [lng, lat]. We sample ~20 evenly-spaced points.
// A higher score means the road passes through more vulnerable neighborhoods.
function sampleRouteRisk(coordinates) {
  const step = Math.max(1, Math.floor(coordinates.length / 25));

  let total = 0;
  let count = 0;

  for (let i = 0; i < coordinates.length; i += step) {
    const [lng, lat] = coordinates[i];

    const w = nearestWard(lat, lng);
    const wardRisk = w ? w.score : 5.0;

    const densityPenalty = buildingDensityPenalty(lat, lng, 35);

    total += wardRisk + densityPenalty;
    count++;
  }

  return count > 0 ? total / count : 5.0;
}

// ─── Overpass API — fetch open spaces within radius ────────────────────────
async function fetchNearbyParks(lat, lng, radiusMeters = 3000) {
  const q = `
    [out:json][timeout:15];
    (
      nwr["leisure"="park"](around:${radiusMeters},${lat},${lng});
      nwr["landuse"="recreation_ground"](around:${radiusMeters},${lat},${lng});
      nwr["leisure"="pitch"](around:${radiusMeters},${lat},${lng});
      nwr["leisure"="playground"](around:${radiusMeters},${lat},${lng});
      nwr["landuse"="grass"](around:${radiusMeters},${lat},${lng});
      nwr["landuse"="meadow"](around:${radiusMeters},${lat},${lng});
      nwr["leisure"="sports_centre"](around:${radiusMeters},${lat},${lng});
    );
    out tags center geom;
  `;

  const resp = await timedFetch(
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q),
    15000
  );

  if (!resp.ok) throw new Error('Overpass API failed');

  const data = await resp.json();

  return data.elements
    .map(el => ({
      id: el.id,
      name: el.tags?.name || 'Open Space',
      lat: el.lat ?? el.center?.lat,
      lng: el.lon ?? el.center?.lon,
      type: el.tags?.leisure || el.tags?.landuse || 'open_space',
      tags: el.tags || {},
      geometry: el.geometry || null
    }))
    .filter(p => p.lat && p.lng)
    .filter(isSafeOpenSpaceCandidate)
    .filter(p => isLargeEnough(p));
}

async function fetchNearbyBuildings(lat, lng, radiusMeters = 3000) {
  const q = `
    [out:json][timeout:15];
    (
      way["building"](around:${radiusMeters},${lat},${lng});
      relation["building"](around:${radiusMeters},${lat},${lng});
    );
    out center;
  `;

  const resp = await timedFetch(
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q),
    15000
  );

  if (!resp.ok) return [];

  const data = await resp.json();

  return data.elements
    .map(el => ({
      lat: el.lat ?? el.center?.lat,
      lng: el.lon ?? el.center?.lon
    }))
    .filter(b => b.lat && b.lng);
}

function isSafeOpenSpaceCandidate(space) {
  const tags = space.tags || {};
  const type = space.type;
  const isUnnamed = space.name === 'Open Space';

  // ❌ remove forests / jungle
  if (tags.natural === 'wood') return false;
  if (tags.landuse === 'forest') return false;
  if (tags.landuse === 'orchard') return false;
  if (tags.landuse === 'scrub') return false;

  // ❌ private
  if (tags.access === 'private' || tags.access === 'no') return false;

  // ✅ best
  if (type === 'pitch') return true;
  if (type === 'recreation_ground') return true;

  // ⚠️ medium
  if (type === 'grass' || type === 'meadow' || type === 'park') {
    if (!isUnnamed) return true;
    space.penalty = 0.2;
    return true;
  }

  if (type === 'sports_centre' && !tags.building) return true;

  return false;
}

function isLargeEnough(space) {
  if (!space.geometry || space.geometry.length < 3) return true;

  let area = 0;
  const pts = space.geometry;

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    area += (p1.lon * p2.lat - p2.lon * p1.lat);
  }

  area = Math.abs(area / 2);

  return area > 0.00001; // approx ~800–1000 m²
}

function getClosestBoundaryPoint(userLat, userLng, geometry) {
  if (!geometry) return null;

  let best = null;
  let bestDist = Infinity;

  geometry.forEach(pt => {
    const d =
      Math.pow(userLat - pt.lat, 2) +
      Math.pow(userLng - pt.lon, 2);

    if (d < bestDist) {
      bestDist = d;
      best = { lat: pt.lat, lng: pt.lon };
    }
  });

  return best;
}

function buildingDensityPenalty(lat, lng, radiusMeters = 35) {
  if (!nearbyBuildingsCache.length) return 0;

  let count = 0;
  const radiusKm = radiusMeters / 1000;

  nearbyBuildingsCache.forEach(b => {
    const d = haversine(lat, lng, b.lat, b.lng);
    if (d <= radiusKm) count++;
  });

  // 0 = open, 3 = very cramped
  if (count >= 12) return 3.0;
  if (count >= 8) return 2.0;
  if (count >= 4) return 1.0;
  return 0;
}

// ─── Deduplicate open spaces (same place as node+way+relation) ─────────────
// OSM can return the same physical location as a node, way, AND relation.
// We keep only unique locations (>50 m apart), preferring entries with names.
function deduplicateSpaces(spaces) {
  // Sort so named entries come first (preferred when deduplicating)
  const sorted = [...spaces].sort((a, b) => {
    const aName = a.name !== 'Open Space' ? 0 : 1;
    const bName = b.name !== 'Open Space' ? 0 : 1;
    return aName - bName;
  });
  const unique = [];
  for (const s of sorted) {
    const dominated = unique.some(u =>
      haversine(s.lat, s.lng, u.lat, u.lng) < 0.05  // within 50 m
    );
    if (!dominated) unique.push(s);
  }
  return unique;
}

// ─── OSRM — fetch actual walking route (road geometry) ─────────────────────
// Returns: { distance (m), duration (s), geometry: { coordinates: [[lng,lat]…] }, legs }
async function fetchOSRMRoute(fromLat, fromLng, toLat, toLng) {
  const url =
    `${OSRM_BASE}/${fromLng},${fromLat};${toLng},${toLat}` +
    `?overview=full&geometries=geojson&steps=true&annotations=false`;
  const resp = await timedFetch(url, OSRM_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('OSRM: no route found');
  return data.routes[0];
}

// ─── Score candidates and rank by composite ────────────────────────────────
// For each of the top 5 nearest parks (by straight-line) fetch an OSRM route,
// compute avgRisk along the actual road geometry, then apply:
//   composite = 0.85 × norm(distKm) + 0.15 × norm(avgRisk)
// Normalize both metrics across candidates so they're on the same 0–1 scale.
async function rankCandidates(userLat, userLng, parks) {
  const pool = parks.slice(0, 8);
  const results = [];

  for (const park of pool) {
      try {
        let target = { lat: park.lat, lng: park.lng };

  if (park.geometry) {
    const edge = getClosestBoundaryPoint(userLat, userLng, park.geometry);
    if (edge) target = edge;
  }

const route = await fetchOSRMRoute(userLat, userLng, target.lat, target.lng);
      const distKm = route.distance / 1000;
      const avgRisk = sampleRouteRisk(route.geometry.coordinates);
      results.push({ park, route, distKm, avgRisk, osrmOk: true, target });
    } catch {
      // OSRM unavailable for this leg — use straight-line, neutral risk estimate
      const distKm = haversine(userLat, userLng, park.lat, park.lng);
      results.push({ park, route: null, distKm, avgRisk: 5.5, osrmOk: false });
    }
  }

  if (!results.length) return results;

  // Normalize metrics across candidates
  const dists = results.map(r => r.distKm);
  const risks  = results.map(r => r.avgRisk);
  const [minD, maxD] = [Math.min(...dists), Math.max(...dists)];
  const [minR, maxR] = [Math.min(...risks),  Math.max(...risks)];

  results.forEach(r => {
    const nd = maxD > minD ? (r.distKm - minD) / (maxD - minD) : 0;
    const nr = maxR > minR ? (r.avgRisk - minR) / (maxR - minR) : 0;
    r.composite = 0.90 * nd + 0.10 * nr + (r.park.penalty || 0);   // lower = better
    r.safetyScore  = Math.round((1 - r.composite) * 100);
  });

  return results.sort((a, b) => a.composite - b.composite);
}

// ─── Draw best route on map ────────────────────────────────────────────────
function drawRouteOnMap(userLat, userLng, result) {
  if (result.route) {
    // OSRM geometry: [lng,lat] → Leaflet needs [lat,lng]
    const latlngs = result.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

    // White border polyline for legibility on any basemap
    const border = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 9,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    parkMarkers.push(border);

    // Blue road route (Google Maps style)
    const line = L.polyline(latlngs, {
      color: '#1d6ef5',
      weight: 5,
      opacity: 0.92,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    parkMarkers.push(line);

    const distKm  = result.distKm.toFixed(2);
    const etaMins = Math.ceil(result.route.duration / 60);
    line.bindTooltip(
      `<span style="font-family:Space Mono;font-size:10px;">
         <b>${result.park.name}</b><br>
         ${distKm} km · ~${etaMins} min walk
       </span>`,
      { sticky: true }
    );

    map.fitBounds(line.getBounds(), { padding: [70, 70] });
  } else {
    // Fallback straight line when OSRM was unreachable
    const line = L.polyline(
      [[userLat, userLng], [result.park.lat, result.park.lng]],
      { color: '#1d6ef5', weight: 4, opacity: 0.72, dashArray: '10,6', lineCap: 'round' }
    ).addTo(map);
    parkMarkers.push(line);
    map.fitBounds(line.getBounds(), { padding: [70, 70] });
  }
}

// ─── Corridor risk label (color + text) ────────────────────────────────────
function corridorRiskLabel(avgRisk) {
  if (avgRisk >= 7.5) return { text: 'HIGH-RISK CORRIDOR',   color: '#dc2626' };
  if (avgRisk >= 6.0) return { text: 'MODERATE-RISK ROUTE',  color: '#f97316' };
  if (avgRisk >= 4.5) return { text: 'LOW-RISK ROUTE',       color: '#ca8a04' };
  return                    { text: 'SAFE CORRIDOR',          color: '#16a34a' };
}

// ─── Turn-by-turn direction steps ──────────────────────────────────────────
const MANEUVER_ICONS = {
  depart:           '📍',
  arrive:           '🏁',
  straight:         '↑',
  continue:         '↑',
  'turn-right':     '→',
  'turn-left':      '←',
  'turn-slight-right': '↗',
  'turn-slight-left':  '↖',
  'turn-sharp-right':  '↳',
  'turn-sharp-left':   '↲',
  roundabout:       '↻',
  rotary:           '↻',
  'fork-right':     '↱',
  'fork-left':      '↰',
  'on-ramp-right':  '↱',
  'on-ramp-left':   '↰',
};

function stepIcon(step) {
  const type = step.maneuver?.type || 'straight';
  const mod  = step.maneuver?.modifier || '';
  const key  = mod ? `${type}-${mod}`.replace(/ /g, '-') : type;
  return MANEUVER_ICONS[key] || MANEUVER_ICONS[type] || '↑';
}

function buildDirectionsHTML(steps) {
  if (!steps?.length) return '';
  const usable = steps.filter(s => s.distance > 5).slice(0, 7);
  if (!usable.length) return '';
  return `
    <div class="route-section-label">DIRECTIONS</div>
    <div class="route-steps">
      ${usable.map(s => {
        const dist = s.distance >= 1000
          ? `${(s.distance / 1000).toFixed(1)} km`
          : `${Math.round(s.distance)} m`;
        const name = s.name || 'Continue';
        return `<div class="route-step">
          <span class="step-icon">${stepIcon(s)}</span>
          <span class="step-text">${name}</span>
          <span class="step-dist">${dist}</span>
        </div>`;
      }).join('')}
    </div>`;
}

function buildAlternativesHTML(others) {
  if (!others.length) return '';
  return `
    <div class="route-section-label" style="margin-top:12px;">ALTERNATIVES</div>
    ${others.map(r => {
      const rl = corridorRiskLabel(r.avgRisk);
      return `<div class="route-alt">
        <div class="route-alt-name">${r.park.name}</div>
        <div class="route-alt-meta">
          <span>${r.distKm.toFixed(2)} km</span>
          <span style="color:${rl.color}">${rl.text}</span>
        </div>
      </div>`;
    }).join('')}`;
}

// ─── STATUS HELPER ─────────────────────────────────────────────────────────
function setStatus(msg, color = 'var(--text-muted)') {
  const el = document.getElementById('park-rows');
  if (el) el.innerHTML += `<div class="route-status" style="color:${color}">${msg}</div>`;
}
//helper
async function getAccuratePosition({
  desiredAccuracy = 80,
  maxWait = 15000
} = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported"));
      return;
    }

    let best = null;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy;

        if (!best || acc < best.coords.accuracy) {
          best = pos;
          setStatus(`Improving GPS… ±${Math.round(acc)}m`);
        }

        if (acc <= desiredAccuracy) {
          navigator.geolocation.clearWatch(watchId);
          resolve(pos);
        }
      },
      (err) => {
        navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );

    setTimeout(() => {
      navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else reject(new Error("Unable to get location"));
    }, maxWait);
  });
}
// ─── MAIN ENTRY POINT ──────────────────────────────────────────────────────
async function findNearestPark() {
  if (parkMode) { clearPark(); return; }

  const parkInfoEl = document.getElementById('park-info');
  const parkRowsEl = document.getElementById('park-rows');
  const btn        = document.getElementById('park-btn');

  parkInfoEl.classList.add('visible');
  parkRowsEl.innerHTML = '';
  setStatus('LOCATING YOU…');

  btn.textContent = '… ROUTING';
  btn.disabled = true;

  // ── 1. Acquire user position ──────────────────────────────────────────────
  let userLat, userLng;

  let pos;

  try {
    pos = await getAccuratePosition({
      desiredAccuracy: 80,
      maxWait: 15000
    });
  } catch (err) {
    alert("Unable to access your location. Please allow permission.");
    setStatus("Location access failed", 'var(--high)');
    finishParkSearch(btn);
    return;
  }

  userLat = pos.coords.latitude;
  userLng = pos.coords.longitude;

  // Optional: show accuracy circle immediately
  const accuracy = pos.coords.accuracy;


  // Smart zoom (based on accuracy but without circle)
  const zoom =
    accuracy < 30 ? 18 :
    accuracy < 100 ? 17 :
    accuracy < 300 ? 15 : 13;

  map.setView([userLat, userLng], zoom);

     setStatus('Checking nearby building density…');

     try {
       nearbyBuildingsCache = await fetchNearbyBuildings(userLat, userLng, 3000);
       setStatus(`Building density loaded (${nearbyBuildingsCache.length} buildings)`);
     } catch {
       nearbyBuildingsCache = [];
       setStatus('Building density unavailable — using ward risk only', 'var(--high)');
     }

  // User location pin (blue dot)
  if (userLocationMarker) userLocationMarker.remove();
  userLocationMarker = L.circleMarker([userLat, userLng], {
    radius: 10, fillColor: '#1d6ef5', color: '#ffffff', weight: 3, fillOpacity: 0.95,
  }).addTo(map);
  userLocationMarker.bindTooltip(
    `<span style="font-family:Space Mono;font-size:10px;">
       📍 Your Location
     </span>`
  );
  parkMarkers.push(userLocationMarker);

  try {
    // ── 2. Fetch nearby open spaces ────────────────────────────────────────
    setStatus('SCANNING OPEN SPACES (3 km)…');
    const parks = deduplicateSpaces(await fetchNearbyParks(userLat, userLng, 3000));

    if (!parks.length) {
      parkRowsEl.innerHTML = `<div class="route-status">No open spaces found within 3 km.</div>`;
      finishParkSearch(btn);
      return;
    }

    // Pre-sort by straight-line so OSRM pool is the geographically nearest
    parks.sort((a, b) =>
      haversine(userLat, userLng, a.lat, a.lng) -
      haversine(userLat, userLng, b.lat, b.lng)
    );

    // ── 3. Rank by composite score ─────────────────────────────────────────
    parkRowsEl.innerHTML = `<div class="route-status">COMPUTING SAFEST ROUTE (${parks.length} spaces)…</div>`;
    const ranked = await rankCandidates(userLat, userLng, parks);
    if (!ranked.length) throw new Error('Could not compute any routes.');

    const best = ranked[0];

    // ── 4. Draw route on map ───────────────────────────────────────────────
    drawRouteOnMap(userLat, userLng, best);

    // Destination pin (green)
    const destLat = best.target?.lat ?? best.park.lat;
    const destLng = best.target?.lng ?? best.park.lng;

    const destPin = L.circleMarker([destLat, destLng], {
      radius: 13, fillColor: '#16a34a', color: '#ffffff', weight: 3, fillOpacity: 0.95,
    }).addTo(map);
    destPin.bindTooltip(
      `<span style="font-family:Space Mono;font-size:10px;color:#16a34a;">
         <b>${best.park.name}</b><br>Open Space · ${best.distKm.toFixed(2)} km
       </span>`,
      { permanent: true, direction: 'top' }
    );
    parkMarkers.push(destPin);

    // Rejected alternatives (smaller, dimmed green pins)
    ranked.slice(1, 6).forEach(r => {
      const m = L.circleMarker([r.park.lat, r.park.lng], {
        radius: 6, fillColor: '#4ade80', color: '#ffffff', weight: 1.5, fillOpacity: 0.4,
      }).addTo(map);
      m.bindTooltip(
        `<span style="font-family:Space Mono;font-size:10px;">${r.park.name} · ${r.distKm.toFixed(2)} km</span>`
      );
      parkMarkers.push(m);
    });

    // ── 5. Build info panel ────────────────────────────────────────────────
    const rl      = corridorRiskLabel(best.avgRisk);
    const etaMins = best.route
      ? Math.ceil(best.route.duration / 60)
      : Math.ceil(best.distKm / 4.5 * 60); // ~4.5 km/h walking
    const steps = best.route?.legs?.[0]?.steps || [];
    const routedCount = ranked.filter(r => r.osrmOk).length;

    parkRowsEl.innerHTML = `
      <div class="route-dest">
        <div class="route-dest-name">${best.park.name}</div>
        <div class="route-dest-type">${best.park.type.toUpperCase().replace(/_/g, ' ')}</div>
      </div>

      <div class="route-meta-grid">
        <div class="route-meta-cell">
          <div class="rmc-val">${best.distKm.toFixed(2)}<span class="rmc-unit">km</span></div>
          <div class="rmc-label">DISTANCE</div>
        </div>
        <div class="route-meta-cell">
          <div class="rmc-val">~${etaMins}<span class="rmc-unit">min</span></div>
          <div class="rmc-label">ON FOOT</div>
        </div>
        <div class="route-meta-cell">
          <div class="rmc-val" style="color:${rl.color}">${best.safetyScore}<span class="rmc-unit">%</span></div>
          <div class="rmc-label">SAFETY</div>
        </div>
      </div>

      <div class="route-risk-pill" style="--pill-color:${rl.color};">
        <span class="pill-dot" style="background:${rl.color};"></span>
        ${rl.text} &nbsp;·&nbsp; avg corridor risk ${best.avgRisk.toFixed(1)}/10
      </div>

      <div class="route-algo-note">
        ⚙ composite = 0.90×distance + 0.10×risk
        &nbsp;·&nbsp; ${parks.length} spaces &nbsp;·&nbsp; ${routedCount} road-routed
      </div>

      ${buildDirectionsHTML(steps)}
      ${buildAlternativesHTML(ranked.slice(1, 5))}
    `;

  } catch (err) {
    parkRowsEl.innerHTML = `<div class="route-status" style="color:var(--brand);">⚠ ${err.message}</div>`;
  }

  finishParkSearch(btn);
}

function finishParkSearch(btn) {
  parkMode = true;
  btn = btn || document.getElementById('park-btn');
  btn.textContent  = '✕ CLEAR ROUTE';
  btn.disabled     = false;
  btn.style.borderColor = '#1d6ef5';
  btn.style.color       = '#1d6ef5';
}

function clearPark() {
  parkMarkers.forEach(m => { try { m.remove(); } catch {} });
  parkMarkers = [];
  if (userLocationMarker) { try { userLocationMarker.remove(); } catch {} userLocationMarker = null; }
  parkMode = false;
  document.getElementById('park-info').classList.remove('visible');
  const btn = document.getElementById('park-btn');
  btn.textContent  = '⬡ Nearest Open Space';
  btn.style.borderColor = '';
  btn.style.color       = '';
}