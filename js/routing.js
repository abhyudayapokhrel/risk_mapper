/* ═══════════════════════════════════════════════
   RiskMapper Nepal — routing.js
   Safe Evacuation Routing to Nearest Open Space

   ALGORITHM: TWO-PHASE SAFE ROUTING
   ───────────────────────────────────
   Phase 1 — Find candidate open spaces (Overpass API)
     Query OSM for parks, grounds, gardens within 3km.
     Score each by:  dist_km + safety_penalty
     where safety_penalty = sum of risk scores of wards
     the straight-line path crosses. This ranks open
     spaces by both proximity AND safety of the path.

   Phase 2 — Road-network routing (OSRM)
     For the top 2 candidates we ask OSRM (free, no key)
     for the actual road route. OSRM returns real
     GeoJSON road geometry — the blue line you see.

     We also request the "alternatives=true" route so
     we can show TWO options:
       • SHORTEST  — pure distance (green line)
       • SAFEST    — shortest passing through
                     lowest-risk wards (blue line)

     To bias OSRM toward safe wards we use its
     "exclude" feature indirectly: we request both
     routes and then score each returned route by
     summing the risk scores of every ward whose
     polygon the route passes through. The lower-
     scoring route is labelled SAFEST.

   SAFETY SCORE OF A ROUTE
   ────────────────────────
     For each coordinate in the OSRM polyline we find
     the nearest ward centroid (haversine) and add its
     risk score to a running total. Divide by number of
     samples → average ward-risk along the route.
     Lower = safer.

   DISPLAY
   ────────
     • Blue  line = safest route  (lower avg ward risk)
     • Green line = shortest route (raw distance)
     • Animated dashes flow in direction of travel
     • Turn-by-turn steps shown in sidebar panel
     • Distance + ETA shown for each route
═══════════════════════════════════════════════ */

let routeMode = false;
let routeLayers = [];
let routeUserMarker = null;

// ── CONSTANTS ──
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const OVERPASS  = 'https://overpass-api.de/api/interpreter';

// ── HAVERSINE (km) ──
function routeHaversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── FIND NEAREST WARD to a point ──
function nearestWardToPoint(lat, lng) {
  let best = null, bestD = Infinity;
  RISK_DATA.wards.forEach(w => {
    const d = routeHaversine(lat, lng, w.lat, w.lng);
    if (d < bestD) { bestD = d; best = w; }
  });
  return best;
}

// ── SAFETY SCORE OF A ROUTE (lower = safer) ──
// Sample every Nth coordinate, find nearest ward, average risk score
function routeSafetyScore(coords) {
  if (!coords || coords.length === 0) return 0;
  const step = Math.max(1, Math.floor(coords.length / 30));
  let total = 0, count = 0;
  for (let i = 0; i < coords.length; i += step) {
    const [lng, lat] = coords[i]; // OSRM returns [lng, lat]
    const w = nearestWardToPoint(lat, lng);
    if (w) { total += w.score; count++; }
  }
  return count > 0 ? total / count : 0;
}

// ── FETCH OPEN SPACES (Overpass) ──
async function fetchOpenSpaces(lat, lng, radius = 3000) {
  const q = `
    [out:json][timeout:12];
    (
      nwr["leisure"="park"](around:${radius},${lat},${lng});
      nwr["leisure"="garden"](around:${radius},${lat},${lng});
      nwr["landuse"="recreation_ground"](around:${radius},${lat},${lng});
      nwr["leisure"="playground"](around:${radius},${lat},${lng});
      nwr["landuse"="grass"](around:${radius},${lat},${lng});
      nwr["landuse"="meadow"](around:${radius},${lat},${lng});
      nwr["leisure"="pitch"](around:${radius},${lat},${lng});
      nwr["leisure"="sports_centre"](around:${radius},${lat},${lng});
    );
    out center;
  `;
  const resp = await fetch(OVERPASS + '?data=' + encodeURIComponent(q));
  if (!resp.ok) throw new Error('Overpass API failed');
  const data = await resp.json();
  return data.elements
    .map(el => ({
      id: el.id,
      name: el.tags?.name || 'Open Space',
      lat: el.lat ?? el.center?.lat,
      lng: el.lon ?? el.center?.lon,
      type: el.tags?.leisure || el.tags?.landuse || 'park',
    }))
    .filter(p => p.lat && p.lng);
}

// ── SCORE OPEN SPACES by dist + safety ──
// Returns sorted array: best (nearest + safest path) first
function scoreOpenSpaces(userLat, userLng, spaces) {
  return spaces.map(s => {
    const dist = routeHaversine(userLat, userLng, s.lat, s.lng);
    // Simple safety: average ward risk along straight-line samples
    const steps = 8;
    let riskSum = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sLat = userLat + t * (s.lat - userLat);
      const sLng = userLng + t * (s.lng - userLng);
      const w = nearestWardToPoint(sLat, sLng);
      if (w) riskSum += w.score;
    }
    const avgRisk = riskSum / (steps + 1);
    // Combined score: normalize dist (0-1 over 3km) + normalize risk (0-1 over 0-10)
    const normDist = dist / 3.0;
    const normRisk = avgRisk / 10.0;
    const combined = 0.85 * normDist + 0.15 * normRisk;
    return { ...s, dist, avgRisk, combined };
  }).sort((a, b) => a.combined - b.combined);
}

// ── FETCH OSRM ROUTE ──
// Returns { routes: [...] } where each route has geometry.coordinates + distance + duration + legs
async function fetchOSRMRoute(fromLat, fromLng, toLat, toLng) {
  const url = `${OSRM_BASE}/${fromLng},${fromLat};${toLng},${toLat}` +
              `?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('OSRM routing failed');
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route found');
  return data.routes; // array of routes (first = shortest, others = alternatives)
}

// ── FORMAT DISTANCE ──
function fmtDist(m) {
  return m >= 1000 ? (m/1000).toFixed(1)+' km' : Math.round(m)+' m';
}

// ── FORMAT DURATION ──
function fmtTime(s) {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s/60);
  return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`;
}

// ── FORMAT OSRM STEP DIRECTION ──
function stepIcon(modifier, type) {
  if (type === 'arrive') return '⬡';
  if (type === 'depart') return '▶';
  if (!modifier) return '↑';
  const icons = {
    'left': '←', 'sharp left': '↰', 'slight left': '↖',
    'right': '→', 'sharp right': '↱', 'slight right': '↗',
    'straight': '↑', 'uturn': '↩',
  };
  return icons[modifier] || '↑';
}

// ── BUILD STEP-BY-STEP PANEL HTML ──
function buildStepsHTML(route, color, label) {
  const steps = route.legs?.[0]?.steps || [];
  const stepsHTML = steps
    .filter(s => s.name || s.maneuver?.type === 'arrive')
    .slice(0, 8)
    .map(s => {
      const icon = stepIcon(s.maneuver?.modifier, s.maneuver?.type);
      const name = s.name || (s.maneuver?.type === 'arrive' ? 'Destination' : '');
      const dist = s.distance > 10 ? fmtDist(s.distance) : '';
      return `<div class="route-step">
        <span class="route-step-icon" style="color:${color}">${icon}</span>
        <span class="route-step-name">${name}</span>
        ${dist ? `<span class="route-step-dist">${dist}</span>` : ''}
      </div>`;
    }).join('');

  return `
    <div class="route-option" style="border-left:3px solid ${color}">
      <div class="route-option-header">
        <span class="route-option-label" style="color:${color}">${label}</span>
        <span class="route-option-meta">${fmtDist(route.distance)} · ${fmtTime(route.duration)}</span>
      </div>
      <div class="route-steps-wrap">${stepsHTML || '<div class="route-step"><span class="route-step-name" style="color:var(--text-muted)">Head toward destination</span></div>'}</div>
    </div>
  `;
}

// ── DRAW ROUTE POLYLINE on map ──
function drawRouteLine(coords, color, weight, opacity, dash, animated) {
  // coords = [[lng,lat], ...] from OSRM — convert to [[lat,lng]] for Leaflet
  const latlngs = coords.map(([lng, lat]) => [lat, lng]);

  // Base line
  const line = L.polyline(latlngs, {
    color,
    weight,
    opacity,
    dashArray: dash || null,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(map);
  routeLayers.push(line);

  // Animated flow overlay for the active (safest) route
  if (animated) {
    const flow = L.polyline(latlngs, {
      color,
      weight: weight - 1,
      opacity: 0.5,
      dashArray: '12, 18',
      dashOffset: '0',
      className: 'route-animated',
    }).addTo(map);
    routeLayers.push(flow);
  }

  return line;
}

// ── MAIN ENTRY POINT ──
async function findAndRouteToOpenSpace() {
  if (routeMode) { clearRoute(); return; }

  const panelEl  = document.getElementById('route-panel');
  const bodyEl   = document.getElementById('route-body');
  const titleEl  = document.getElementById('route-title');

  panelEl.classList.add('visible');
  bodyEl.innerHTML = buildRouteStatus('Locating you…');

  const btn = document.getElementById('route-btn');
  btn.textContent = '… ROUTING';
  btn.disabled = true;

  // ── Step 1: Get user location ──
  let userLat, userLng, usingFallback = false;
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
        : rej(new Error('no geolocation'))
    );
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;
  } catch {
    // Fallback: Ward 10 (Baneshwor) — highest risk, most useful demo
    userLat = wardMap[10].lat;
    userLng = wardMap[10].lng;
    usingFallback = true;
  }

  // Show user pin
  if (routeUserMarker) routeUserMarker.remove();
  routeUserMarker = L.marker([userLat, userLng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#3b82f6;border:3px solid #fff;
        box-shadow:0 2px 8px rgba(59,130,246,0.6);
      "></div>`,
      iconAnchor: [8, 8],
    }),
  }).addTo(map);
  routeUserMarker.bindTooltip(
    `<span style="font-family:Space Mono;font-size:10px">
      ${usingFallback ? '📍 DEMO: Ward 10 (Baneshwor)' : '📍 YOUR LOCATION'}
    </span>`,
    { permanent: false }
  );
  routeLayers.push(routeUserMarker);

  const userWard = nearestWardToPoint(userLat, userLng);
  titleEl.textContent = `FROM: ${userWard ? userWard.name.toUpperCase() : 'YOUR LOCATION'}`;

  if (usingFallback) {
    bodyEl.innerHTML = buildRouteStatus('GPS unavailable — using Ward 10 (Baneshwor) as demo origin.', true);
  }

  // ── Step 2: Fetch open spaces ──
  bodyEl.innerHTML += buildRouteStatus('Searching for open spaces within 3 km…');
  let spaces = [];
  try {
    spaces = await fetchOpenSpaces(userLat, userLng, 3000);
  } catch (e) {
    bodyEl.innerHTML = buildRouteStatus('Could not reach Overpass API. Check your connection.', false, true);
    finishRoute(false); return;
  }

  if (spaces.length === 0) {
    bodyEl.innerHTML = buildRouteStatus('No open spaces found within 3 km.', false, true);
    finishRoute(false); return;
  }

  // ── Step 3: Score & rank spaces ──
  const ranked = scoreOpenSpaces(userLat, userLng, spaces);
  const destination = ranked[0];

  bodyEl.innerHTML += buildRouteStatus(`Found ${spaces.length} open spaces. Best: ${destination.name}`);

  // Mark destination
  const destMarker = L.marker([destination.lat, destination.lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:20px;height:20px;border-radius:50%;
        background:#00b87a;border:3px solid #fff;
        box-shadow:0 2px 10px rgba(0,184,122,0.7);
        display:flex;align-items:center;justify-content:center;
        font-size:10px;color:#fff;font-weight:700;
      ">⬡</div>`,
      iconAnchor: [10, 10],
    }),
  }).addTo(map);
  destMarker.bindTooltip(
    `<span style="font-family:Space Mono;font-size:10px;color:#00b87a">
      <b>${destination.name}</b><br>
      ${destination.dist.toFixed(2)} km away · Open Space
    </span>`,
    { permanent: true, direction: 'top', offset: [0, -14] }
  );
  routeLayers.push(destMarker);

  // ── Step 4: Get OSRM routes ──
  bodyEl.innerHTML += buildRouteStatus('Calculating road routes…');
  let osrmRoutes = [];
  try {
    osrmRoutes = await fetchOSRMRoute(userLat, userLng, destination.lat, destination.lng);
  } catch (e) {
    // OSRM failed — draw straight line fallback
    bodyEl.innerHTML += buildRouteStatus('Road router unavailable — showing direct path.', true);
    drawRouteLine(
      [[userLng, userLat], [destination.lng, destination.lat]],
      '#3b82f6', 4, 0.8, '10, 8', false
    );
    finishRoute(true);
    buildFallbackPanel(bodyEl, destination, userLat, userLng);
    map.fitBounds([[userLat, userLng], [destination.lat, destination.lng]], { padding: [60, 60] });
    return;
  }

  // ── Step 5: Score routes by safety ──
  const scoredRoutes = osrmRoutes.map(r => ({
    ...r,
    safetyScore: routeSafetyScore(r.geometry.coordinates),
  }));

  // Sort: safest = lowest avg ward risk score
  scoredRoutes.sort((a, b) => a.safetyScore - b.safetyScore);

  const safestRoute  = scoredRoutes[0];
  const shortestRoute = [...scoredRoutes].sort((a, b) => a.distance - b.distance)[0];
  const isSame = safestRoute === shortestRoute;

  // ── Step 6: Draw routes ──
  // Draw shortest first (behind) if different from safest
  if (!isSame) {
    drawRouteLine(
      shortestRoute.geometry.coordinates,
      '#94a3b8',   // muted grey-blue
      4, 0.55, '8, 10', false
    ).bindTooltip(
      `<span style="font-family:Space Mono;font-size:10px">
        SHORTEST: ${fmtDist(shortestRoute.distance)} · ${fmtTime(shortestRoute.duration)}
        <br><span style="color:#e02020">Avg ward risk: ${shortestRoute.safetyScore.toFixed(1)}/10</span>
      </span>`,
      { sticky: true }
    );
  }

  // Draw safest route (on top, animated)
  const safeColor = '#3b82f6';
  const safeLineBase = drawRouteLine(
    safestRoute.geometry.coordinates,
    safeColor, 6, 0.9, null, true
  );
  safeLineBase.bindTooltip(
    `<span style="font-family:Space Mono;font-size:10px">
      SAFEST ROUTE: ${fmtDist(safestRoute.distance)} · ${fmtTime(safestRoute.duration)}
      <br><span style="color:#00b87a">Avg ward risk: ${safestRoute.safetyScore.toFixed(1)}/10</span>
    </span>`,
    { sticky: true }
  );

  // Fit map to show full route
  const allCoords = safestRoute.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  if (allCoords.length > 0) {
    map.fitBounds(allCoords, { padding: [60, 80] });
  }

  // ── Step 7: Build panel ──
  const destWard = nearestWardToPoint(destination.lat, destination.lng);
  bodyEl.innerHTML = `
    <div class="route-dest-row">
      <span class="route-dest-icon">⬡</span>
      <div class="route-dest-info">
        <div class="route-dest-name">${destination.name}</div>
        <div class="route-dest-sub">${destination.dist.toFixed(2)} km away · ${destination.type}</div>
      </div>
    </div>
    <div class="route-safety-bar">
      <div class="route-safety-fill" style="width:${Math.round((1 - safestRoute.safetyScore/10)*100)}%"></div>
    </div>
    <div class="route-safety-label">Route safety: ${Math.round((1 - safestRoute.safetyScore/10)*100)}% safe corridor</div>

    ${buildStepsHTML(safestRoute, safeColor, isSame ? '⬡ SAFEST + SHORTEST' : '⬡ SAFEST ROUTE')}
    ${!isSame ? buildStepsHTML(shortestRoute, '#94a3b8', '↘ SHORTEST ROUTE') : ''}
  `;

  finishRoute(true);
}

// ── HELPER: status line during loading ──
function buildRouteStatus(msg, warn = false, err = false) {
  const color = err ? 'var(--brand)' : warn ? 'var(--moderate)' : 'var(--text-muted)';
  return `<div style="font-family:var(--font-mono);font-size:9px;color:${color};padding:3px 0;letter-spacing:0.05em;">${msg}</div>`;
}

// ── FALLBACK panel when OSRM unavailable ──
function buildFallbackPanel(el, dest, uLat, uLng) {
  const dist = routeHaversine(uLat, uLng, dest.lat, dest.lng);
  el.innerHTML = `
    <div class="route-dest-row">
      <span class="route-dest-icon">⬡</span>
      <div class="route-dest-info">
        <div class="route-dest-name">${dest.name}</div>
        <div class="route-dest-sub">${dist.toFixed(2)} km · Direct line (road router offline)</div>
      </div>
    </div>
  `;
}

function finishRoute(success) {
  routeMode = success;
  const btn = document.getElementById('route-btn');
  btn.disabled = false;
  if (success) {
    btn.textContent = '✕ CLEAR ROUTE';
    btn.style.borderColor = '#3b82f6';
    btn.style.color = '#3b82f6';
  } else {
    btn.textContent = '⟿ Safe Route to Open Space';
    btn.style.borderColor = '';
    btn.style.color = '';
  }
}

function clearRoute() {
  routeLayers.forEach(l => { try { l.remove(); } catch(e){} });
  routeLayers = [];
  if (routeUserMarker) { routeUserMarker.remove(); routeUserMarker = null; }
  routeMode = false;

  const panelEl = document.getElementById('route-panel');
  if (panelEl) panelEl.classList.remove('visible');

  const btn = document.getElementById('route-btn');
  btn.textContent = '⟿ Safe Route to Open Space';
  btn.style.borderColor = '';
  btn.style.color = '';
}