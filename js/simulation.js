/* ═══════════════════════════════════════════════
   RiskMapper Nepal — simulation.js

   CASCADE — HOW IT WORKS
   ──────────────────────
   All 32 cascade scenarios are PRE-COMPUTED in
   generate_data.py and stored in risk_data.json.
   No BFS runs in the browser — instant lookup.

   When you click a ward:
   1. Load scenario[wardId] from RISK_DATA
   2. Sort wards by probability (highest first)
   3. Animate them appearing 100ms apart:
      - Polygon color flashes red (via highlightWardPolygon)
      - Circle overlay drawn (size/opacity ∝ probability)
      - Lines drawn from source to direct neighbors
   4. Panel shows top 8 affected wards + probabilities

   Probability formula (computed in Python):
     P(neighbor) = P(current) × (neighbor_score/10) × 0.6
   Source ward always = 1.0 (100%).
   Stops below 0.05 (5%).

   DIJKSTRA EVAC — HOW IT WORKS
   ─────────────────────────────
   Graph = 32 ward nodes. Edge weight = neighbor risk score.
   Higher risk score = more dangerous to pass through.
   So Dijkstra finds path that avoids high-risk wards.
   Drawn as dashed polyline through ward centroids.
═══════════════════════════════════════════════ */

let cascadeMode = false;
let evacuMode = false;

// ── CASCADE SIMULATION ──
function simulateCascade(sourceWardId) {
  clearCascade();
  cascadeMode = true;

  const wardId = sourceWardId || (activeWard ? activeWard : RISK_DATA.wards[0].ward);
  const sourceWard = wardMap[wardId];

  // Load precomputed scenario — O(1) lookup, with on-the-fly BFS fallback
  let scenario = RISK_DATA.cascade_scenarios[String(wardId)];
  if (!scenario) {
    console.warn('No precomputed scenario for ward', wardId, '— computing on-the-fly');
    scenario = computeCascadeBFS(wardId);
  }

  // Show panel
  document.getElementById('cascade-info').classList.add('visible');
  const sourceEl = document.getElementById('ci-source');
  if (sourceEl) sourceEl.textContent = `SOURCE: ${sourceWard.name.toUpperCase()} (${sourceWard.score}/10)`;

  // Sort by probability
  const entries = Object.entries(scenario).sort((a, b) => b[1] - a[1]);

  // Staggered animation — 100ms per ward
  entries.forEach(([wardStr, prob], idx) => {
    const wId = parseInt(wardStr);
    const w = wardMap[wId];
    if (!w) return;

    setTimeout(() => {
      const r = 6 + prob * 18;
      const alpha = 0.15 + prob * 0.7;
      const color = wId === wardId ? '#e02020' : '#e02020';

      // Flash polygon color
      if (wId === wardId) {
        highlightWardPolygon(wId, '#e02020', 0.85);
      } else if (prob > 0.05) {
        highlightWardPolygon(wId, '#e02020', Math.min(alpha * 0.7, 0.7));
      }

      // Overlay circle marker
      const cm = L.circleMarker([w.lat, w.lng], {
        radius: wId === wardId ? 16 : r,
        fillColor: color,
        color: color,
        weight: wId === wardId ? 2 : 1,
        opacity: wId === wardId ? 1 : alpha,
        fillOpacity: wId === wardId ? 0.9 : alpha * 0.4,
      }).addTo(map);

      const pct = Math.round(prob * 100);
      cm.bindTooltip(
        `<span style="font-family:Space Mono;font-size:10px">${w.name}<br>${wId === wardId ? 'EPICENTRE — 100%' : `Cascade risk: <b>${pct}%</b>`}</span>`,
        { direction: 'top' }
      );
      cascadeMarkers.push(cm);

      // Pulsing ring for high-probability wards
      if (prob > 0.4 || wId === wardId) {
        const ring = L.circleMarker([w.lat, w.lng], {
          radius: (wId === wardId ? 16 : r) + 9,
          fillColor: 'transparent',
          color: '#e02020',
          weight: 1.5,
          opacity: 0.2,
          fillOpacity: 0,
        }).addTo(map);
        cascadeMarkers.push(ring);
      }

      // Draw adjacency lines: source → direct neighbors only
      const directNeighbors = RISK_DATA.adjacency[String(wardId)] || [];
      if (directNeighbors.includes(wId) && prob > 0.25) {
        const line = L.polyline(
          [[sourceWard.lat, sourceWard.lng], [w.lat, w.lng]],
          { color: '#e02020', weight: 1.5, opacity: 0.25, dashArray: '4,5' }
        ).addTo(map);
        cascadeMarkers.push(line);
      }
    }, idx * 100);
  });

  // Build info panel — top 8 excluding source
  const rowsEl = document.getElementById('cascade-rows');
  rowsEl.innerHTML = entries
    .filter(([wStr]) => parseInt(wStr) !== wardId)
    .slice(0, 8)
    .map(([wardStr, prob]) => {
      const w = wardMap[parseInt(wardStr)];
      const pct = Math.round(prob * 100);
      const color = pct > 80 ? '#e02020' : pct > 40 ? '#f47a1f' : '#f0b429';
      return `<div class="ci-row">
        <span class="ci-ward-name">${w ? w.name : 'Ward '+wardStr}</span>
        <span class="ci-prob" style="color:${color}">${pct}%</span>
      </div>`;
    }).join('');

  document.getElementById('cascade-btn').classList.add('active-sim');
  document.getElementById('cascade-btn').textContent = '✕ CLEAR CASCADE';
}

function clearCascade() {
  cascadeMarkers.forEach(m => m.remove());
  cascadeMarkers = [];
  cascadeMode = false;
  resetPolygonStyles();
  document.getElementById('cascade-info').classList.remove('visible');
  document.getElementById('cascade-btn').classList.remove('active-sim');
  document.getElementById('cascade-btn').textContent = '⚡ Simulate Cascade';
}

// ── DIJKSTRA EVACUATION (ward-level, for finding safest destination ward) ──
function dijkstraEvac(startWardId) {
  const adj = RISK_DATA.adjacency;
  const dist = {}, prev = {}, visited = new Set();
  RISK_DATA.wards.forEach(w => dist[w.ward] = Infinity);
  dist[startWardId] = 0;
  const queue = [{ wardId: startWardId, cost: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { wardId } = queue.shift();
    if (visited.has(wardId)) continue;
    visited.add(wardId);
    (adj[String(wardId)] || []).forEach(nId => {
      const n = wardMap[nId];
      if (!n) return;
      const newCost = dist[wardId] + n.score; // edge weight = neighbor risk score
      if (newCost < dist[nId]) {
        dist[nId] = newCost;
        prev[nId] = wardId;
        queue.push({ wardId: nId, cost: newCost });
      }
    });
  }
  return { dist, prev };
}

function getPath(prev, targetId) {
  const path = [];
  let cur = targetId;
  while (cur !== undefined) { path.unshift(cur); cur = prev[cur]; }
  return path;
}

/* ═══════════════════════════════════════════════
   SMART EVACUATION — OSRM Road-Level Routing
   ─────────────────────────────────────────────
   Upgrades the old ward-centroid Dijkstra to use
   actual OSRM walking routes to real open spaces.

   ALGORITHM
   ─────────
   1. Pick source wards (activeWard or top critical)
   2. For each source, find nearby open spaces via
      Overpass API (parks, grounds, playgrounds)
   3. Get OSRM walking routes to top candidates
   4. Sample ward risk along each route geometry
   5. Composite score:
        score = 0.40 × norm(distance)
              + 0.60 × norm(corridor_risk)
      Lower = better (shortest + safest)
   6. Draw the best route per source ward:
      - White border polyline (contrast)
      - Blue filled polyline (Google Maps style)
      - Pulsing red pin at source (DANGER)
      - Green pin at destination (SAFE ZONE)
   7. Show route panel with distance/ETA/safety
═══════════════════════════════════════════════ */

let evacInfoPanel = null;   // reference to the floating route info panel

async function showEvacRoutes() {
  clearEvac();
  evacuMode = true;

  const btn = document.getElementById('evac-btn');
  btn.textContent = '… ROUTING';
  btn.disabled = true;

  // Pick source wards: activeWard or top 3 critical/high
  let srcWards;
  if (activeWard) {
    srcWards = [wardMap[activeWard]];
  } else {
    srcWards = RISK_DATA.wards
      .filter(w => w.level === 'critical' || w.level === 'high')
      .slice(0, 3);
  }

  const ROUTE_COLORS = ['#1d6ef5', '#8b5cf6', '#06b6d4'];

  // Show the route info panel
  showEvacPanel(srcWards);

  let allBounds = [];
  let routeResults = [];

  for (let idx = 0; idx < srcWards.length; idx++) {
    const src = srcWards[idx];
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];

    updateEvacStatus(idx, 'SCANNING OPEN SPACES…');

    try {
      // 1. Fetch nearby open spaces via Overpass (reuses evac.js global)
      const parks = await fetchNearbyParks(src.lat, src.lng, 3000);

      if (!parks.length) {
        updateEvacStatus(idx, 'NO OPEN SPACES WITHIN 3 KM', 'var(--brand)');
        continue;
      }

      // Pre-sort by straight-line distance
      parks.sort((a, b) =>
        haversine(src.lat, src.lng, a.lat, a.lng) -
        haversine(src.lat, src.lng, b.lat, b.lng)
      );

      // 2. Get OSRM routes to top 5 nearest spaces
      updateEvacStatus(idx, `ROUTING TO ${Math.min(parks.length, 5)} SPACES…`);
      const candidates = [];
      const pool = parks.slice(0, 5);

      for (const park of pool) {
        try {
          let target = { lat: park.lat, lng: park.lng };

          if (park.geometry) {
           const edge = getClosestBoundaryPoint(src.lat, src.lng, park.geometry);
           if (edge) target = edge;
          }

          const route = await fetchOSRMRoute(src.lat, src.lng, target.lat, target.lng);
          const distKm = route.distance / 1000;
          const avgRisk = sampleRouteRisk(route.geometry.coordinates);

          candidates.push({ park, route, distKm, avgRisk, osrmOk: true, target });
        } catch {
          const distKm = haversine(src.lat, src.lng, park.lat, park.lng);
          candidates.push({ park, route: null, distKm, avgRisk: 5.5, osrmOk: false });
        }
      }

      if (!candidates.length) {
        updateEvacStatus(idx, 'ROUTING FAILED', 'var(--brand)');
        continue;
      }

      // 3. Composite scoring: normalize, then weight
      const dists = candidates.map(r => r.distKm);
      const risks = candidates.map(r => r.avgRisk);
      const [minD, maxD] = [Math.min(...dists), Math.max(...dists)];
      const [minR, maxR] = [Math.min(...risks), Math.max(...risks)];

      candidates.forEach(r => {
        const nd = maxD > minD ? (r.distKm - minD) / (maxD - minD) : 0;
        const nr = maxR > minR ? (r.avgRisk - minR) / (maxR - minR) : 0;
        r.composite = 0.40 * nd + 0.60 * nr;  // lower = better
        r.safetyScore = Math.round((1 - r.composite) * 100);
      });

      candidates.sort((a, b) => a.composite - b.composite);
      const best = candidates[0];

      // 4. Draw the route on map
      if (best.route) {
        const latlngs = best.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

        // White border for contrast (thick for visibility)
        const border = L.polyline(latlngs, {
          color: '#ffffff', weight: 12, opacity: 0.7,
          lineCap: 'round', lineJoin: 'round',
        }).addTo(map);
        border.bringToFront();
        evacuLines.push(border);

        // Main colored route (Google Maps style — bold and vivid)
        const line = L.polyline(latlngs, {
          color: color, weight: 7, opacity: 0.95,
          lineCap: 'round', lineJoin: 'round',
        }).addTo(map);
        line.bringToFront();

        const etaMins = Math.ceil(best.route.duration / 60);
        const riskLabel = corridorRiskLabel(best.avgRisk);
        line.bindTooltip(
          `<div style="font-family:Space Mono;font-size:10px;min-width:160px;padding:4px;">
             <div style="font-weight:700;color:${color};margin-bottom:4px;">
               ROUTE ${String.fromCharCode(65 + idx)}: ${src.name}
             </div>
             <div style="color:#1a1f2e;margin-bottom:2px;">
               → ${best.park.name}
             </div>
             <div style="color:#9ba3af;font-size:9px;margin-bottom:6px;">
               ${best.distKm.toFixed(2)} km · ~${etaMins} min walk
             </div>
             <div style="color:${riskLabel.color};font-size:9px;font-weight:700;">
               ${riskLabel.text} · Safety ${best.safetyScore}%
             </div>
             <div style="color:#9ba3af;font-size:8px;margin-top:4px;border-top:1px solid #eee;padding-top:4px;">
               composite = 0.60×distance + 0.40×risk+density
             </div>
           </div>`,
          { sticky: true }
        );
        evacuLines.push(line);
        allBounds.push(line.getBounds());
      } else {
        // Fallback: straight dashed line
        const line = L.polyline(
          [[src.lat, src.lng], [best.park.lat, best.park.lng]],
          { color: color, weight: 4, opacity: 0.72, dashArray: '10,6', lineCap: 'round' }
        ).addTo(map);
        evacuLines.push(line);
      }

      // 5. Source pin (pulsing red danger marker)
      const srcPin = L.circleMarker([src.lat, src.lng], {
        radius: 12, fillColor: '#e02020', color: '#ffffff',
        weight: 3, fillOpacity: 0.95,
      }).addTo(map);
      srcPin.bindTooltip(
        `<span style="font-family:Space Mono;font-size:10px;color:#e02020;font-weight:700;">
           ⚠ DANGER ZONE<br>
           <span style="color:#1a1f2e">${src.name} · Risk ${src.score}/10</span>
         </span>`,
        { direction: 'left' }
      );
      evacuLines.push(srcPin);

      // Pulsing ring around source
      const srcRing = L.circleMarker([src.lat, src.lng], {
        radius: 20, fillColor: 'transparent', color: '#e02020',
        weight: 2, opacity: 0.3, fillOpacity: 0,
        className: 'evac-pulse-ring',
      }).addTo(map);
      evacuLines.push(srcRing);

      // 6. Destination pin (green safe zone)
      const destLat = best.target?.lat ?? best.park.lat;
      const destLng = best.target?.lng ?? best.park.lng;

      const destPin = L.circleMarker([destLat, destLng], {
        radius: 12, fillColor: '#16a34a', color: '#ffffff',
        weight: 3, fillOpacity: 0.95,
      }).addTo(map);
      const etaStr = best.route
        ? `~${Math.ceil(best.route.duration / 60)} min walk`
        : `~${Math.ceil(best.distKm / 4.5 * 60)} min walk`;
      destPin.bindTooltip(
        `<span style="font-family:Space Mono;font-size:10px;color:#16a34a;font-weight:700;">
           ✓ SAFE ZONE<br>
           <span style="color:#1a1f2e">${best.park.name}</span><br>
           <span style="color:#9ba3af;font-size:9px">${best.distKm.toFixed(2)} km · ${etaStr}</span>
         </span>`,
        { permanent: true, direction: 'top', className: 'evac-dest-label' }
      );
      evacuLines.push(destPin);

      // 7. Alternative destinations (smaller, dimmed pins)
      candidates.slice(1, 3).forEach(r => {
        const altLat = r.target?.lat ?? r.park.lat;
        const altLng = r.target?.lng ?? r.park.lng;

        const m = L.circleMarker([altLat, altLng], {
          radius: 5, fillColor: '#4ade80', color: '#ffffff',
          weight: 1.5, fillOpacity: 0.4,
        }).addTo(map);
        m.bindTooltip(
          `<span style="font-family:Space Mono;font-size:9px">${r.park.name} · ${r.distKm.toFixed(2)} km</span>`
        );
        evacuLines.push(m);
      });

      // Build result for the panel
      const riskLabel = corridorRiskLabel(best.avgRisk);
      const etaMins = best.route
        ? Math.ceil(best.route.duration / 60)
        : Math.ceil(best.distKm / 4.5 * 60);
      const steps = best.route?.legs?.[0]?.steps || [];

      routeResults.push({
        idx, src, best, riskLabel, etaMins, steps, color,
        alternatives: candidates.slice(1, 3),
      });

      updateEvacStatus(idx, null); // clear status, show result

    } catch (err) {
      updateEvacStatus(idx, `⚠ ${err.message}`, 'var(--brand)');
    }
  }

  // Fit map to show all routes
  if (allBounds.length) {
    const combined = allBounds[0];
    allBounds.slice(1).forEach(b => combined.extend(b));
    map.fitBounds(combined, { padding: [60, 60] });
  }

  // Update the panel with final results
  populateEvacPanel(routeResults);
  finishEvacSearch(btn);
}

// ── EVAC PANEL — Shows route info in the cascade-info panel area ──
function showEvacPanel(srcWards) {
  const panel = document.getElementById('cascade-info');
  panel.classList.add('visible');
  panel.classList.add('evac-mode');

  const sourceEl = document.getElementById('ci-source');
  if (sourceEl) sourceEl.textContent = `ROUTING FROM ${srcWards.length} DANGER ZONE${srcWards.length > 1 ? 'S' : ''}`;

  const titleEl = panel.querySelector('.ci-title');
  if (titleEl) titleEl.innerHTML = '<span style="color:#1d6ef5; animation:pulse-icon 1s infinite;">●</span> EVACUATION ROUTES';

  const waveEl = document.getElementById('cascade-wave');
  if (waveEl) waveEl.style.background = 'linear-gradient(to right, #1d6ef5, transparent)';

  document.getElementById('cascade-rows').innerHTML = srcWards.map((w, i) =>
    `<div class="evac-route-status" id="evac-status-${i}" style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted);padding:6px 0;border-bottom:1px solid var(--border);letter-spacing:0.06em;animation:blink 1.4s infinite;">
       ROUTE ${String.fromCharCode(65 + i)}: ${w.name} — INITIALIZING…
     </div>`
  ).join('');
}

function updateEvacStatus(idx, msg, color) {
  const el = document.getElementById(`evac-status-${idx}`);
  if (!el) return;
  if (msg === null) {
    el.style.animation = 'none';
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.textContent = msg;
  if (color) { el.style.color = color; el.style.animation = 'none'; }
}

function populateEvacPanel(results) {
  const rowsEl = document.getElementById('cascade-rows');
  if (!results.length) {
    rowsEl.innerHTML = `<div style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted);padding:8px 0;">No routes found.</div>`;
    return;
  }

  rowsEl.innerHTML = results.map(r => {
    const directionSteps = r.steps
      .filter(s => s.distance > 10)
      .slice(0, 4)
      .map(s => {
        const dist = s.distance >= 1000
          ? `${(s.distance / 1000).toFixed(1)}km`
          : `${Math.round(s.distance)}m`;
        const name = s.name || 'Continue';
        return `<div style="display:flex;gap:6px;font-size:9px;color:var(--text-dim);padding:2px 0;">
          <span style="color:var(--text);width:14px;">↑</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
          <span style="color:var(--text-muted);flex-shrink:0;">${dist}</span>
        </div>`;
      }).join('');

    return `
      <div class="evac-route-card" style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:${r.color};">
            ROUTE ${String.fromCharCode(65 + r.idx)}
          </div>
          <div style="font-family:var(--font-mono);font-size:10px;font-weight:700;color:${r.riskLabel.color};">
            ${r.best.safetyScore}% SAFE
          </div>
        </div>

        <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:2px;">
          ${r.src.name} → ${r.best.park.name}
        </div>

        <div style="display:flex;gap:10px;font-family:var(--font-mono);font-size:9px;color:var(--text-muted);margin-bottom:6px;">
          <span>${r.best.distKm.toFixed(2)} km</span>
          <span>~${r.etaMins} min</span>
          <span style="color:${r.riskLabel.color}">${r.riskLabel.text}</span>
        </div>

        ${directionSteps ? `
          <div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);letter-spacing:0.08em;margin-bottom:4px;">DIRECTIONS</div>
          ${directionSteps}
        ` : ''}

        ${r.alternatives.length ? `
          <div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);letter-spacing:0.08em;margin-top:6px;">ALTERNATIVES</div>
          ${r.alternatives.map(a =>
            `<div style="font-size:9px;color:var(--text-dim);padding:2px 0;display:flex;justify-content:space-between;">
               <span>${a.park.name}</span>
               <span style="font-family:var(--font-mono);color:var(--text-muted)">${a.distKm.toFixed(2)}km</span>
             </div>`
          ).join('')}
        ` : ''}
      </div>`;
  }).join('');

  // Add algorithm note at bottom
  rowsEl.innerHTML += `
    <div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);letter-spacing:0.04em;background:var(--surface2);border-radius:var(--radius);padding:5px 8px;line-height:1.5;">
      ⚙ composite = 0.40×distance + 0.60×corridor-risk<br>
      OSRM walking routes · Overpass API open spaces
    </div>`;
}

function finishEvacSearch(btn) {
  btn = btn || document.getElementById('evac-btn');
  btn.textContent = '✕ CLEAR ROUTES';
  btn.disabled = false;
  btn.style.borderColor = '#1d6ef5';
  btn.style.color = '#1d6ef5';
}

function clearEvac() {
  evacuLines.forEach(l => { try { l.remove(); } catch {} });
  evacuLines = [];
  evacuMode = false;

  // Reset the cascade panel back to cascade mode
  const panel = document.getElementById('cascade-info');
  panel.classList.remove('visible', 'evac-mode');
  const titleEl = panel.querySelector('.ci-title');
  if (titleEl) titleEl.innerHTML = '<span style="color:var(--brand); animation:pulse-icon 1s infinite;">●</span> CASCADE SIMULATION';
  const waveEl = document.getElementById('cascade-wave');
  if (waveEl) waveEl.style.background = '';

  const btn = document.getElementById('evac-btn');
  btn.textContent = '⟶ Evacuate to Safe Zone';
  btn.style.borderColor = '';
  btn.style.color = '';
  btn.disabled = false;
}

// ── CORRIDOR RISK LABEL (used by evacuation routing) ──
// Redefine here in case evac.js loads after simulation.js
function corridorRiskLabel(avgRisk) {
  if (avgRisk >= 7.5) return { text: 'HIGH-RISK CORRIDOR',   color: '#dc2626' };
  if (avgRisk >= 6.0) return { text: 'MODERATE-RISK ROUTE',  color: '#f97316' };
  if (avgRisk >= 4.5) return { text: 'LOW-RISK ROUTE',       color: '#ca8a04' };
  return                    { text: 'SAFE CORRIDOR',          color: '#16a34a' };
}

// ── ON-THE-FLY BFS CASCADE (fallback when precomputed scenario missing) ──
function computeCascadeBFS(startWard) {
  const results = {};
  const visited = new Set();
  const queue = [[startWard, 1.0]];
  while (queue.length > 0) {
    const [current, prob] = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    results[current] = Math.round(prob * 1000) / 1000;
    if (prob < 0.05) continue;
    const neighbors = RISK_DATA.adjacency[String(current)] || [];
    for (const nId of neighbors) {
      if (!visited.has(nId)) {
        const n = wardMap[nId];
        if (n) {
          const cascadeProb = prob * (n.score / 10) * 0.6;
          queue.push([nId, cascadeProb]);
        }
      }
    }
  }
  return results;
}
