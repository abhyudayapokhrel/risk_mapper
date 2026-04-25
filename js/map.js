/* ═══════════════════════════════════════════════
   RiskMapper Nepal — map.js
   Leaflet map with real ward polygon GeoJSON.

   HOW GEOJSON IS PROCESSED
   ────────────────────────
   ktm_wards_mapped.geojson has 59 VDC polygons,
   each tagged with ward_no (1–32) by matching its
   centroid to the nearest modern KMC ward centroid.
   Multiple VDCs with same ward_no = same risk color.
   Clicking any polygon runs cascade from that ward.
═══════════════════════════════════════════════ */

let map, markers = {}, cascadeMarkers = [], evacuLines = [];
let wardLayers = {};
let geoJsonLayer = null;

function initMap() {
  map = L.map('map', {
    center: [27.715, 85.335],
    zoom: 13,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OSM contributors',
    maxZoom: 19,
  }).addTo(map);

  fetch('data/ktm_wards_mapped.geojson')
    .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(geojson => renderGeoJSON(geojson))
    .catch(() => { console.warn('GeoJSON missing — circle markers'); renderCircleMarkers(); });
}

function renderGeoJSON(geojson) {
  geoJsonLayer = L.geoJSON(geojson, {
    style: feature => {
      const wardNo = feature.properties.ward_no;
      const w = wardMap[wardNo];
      const color = w ? LEVEL_COLORS[w.level] : '#ccc';
      // Critical wards get bold opacity so they're unmistakably red
      let fillOp = 0.2;
      if (w) {
        if (w.level === 'critical') fillOp = 0.72 + (w.score / 10) * 0.15;
        else if (w.level === 'high') fillOp = 0.45 + (w.score / 10) * 0.25;
        else fillOp = 0.35 + (w.score / 10) * 0.25;
      }
      return {
        fillColor: color,
        color: w && w.level === 'critical' ? color : '#fff',
        weight: w && w.level === 'critical' ? 2.5 : 1.5,
        fillOpacity: fillOp,
        opacity: 0.9,
      };
    },
    onEachFeature: (feature, layer) => {
      const wardNo = feature.properties.ward_no;
      const w = wardMap[wardNo];
      if (!w) return;

      if (!wardLayers[wardNo]) wardLayers[wardNo] = [];
      wardLayers[wardNo].push(layer);

      layer.bindPopup(buildPopupHTML(w));

      layer.on('mouseover', function() {
        this.setStyle({ weight: 2.5, color: '#1a1f2e', fillOpacity: 0.75 });
        this.bringToFront();
      });
      layer.on('mouseout', function() {
        if (activeWard !== wardNo) {
          let fillOp = w.level === 'critical' ? 0.72 + (w.score/10)*0.15
            : w.level === 'high' ? 0.45 + (w.score/10)*0.25
            : 0.35 + (w.score/10)*0.25;
          this.setStyle({
            weight: w.level === 'critical' ? 2.5 : 1.5,
            color: w.level === 'critical' ? LEVEL_COLORS[w.level] : '#fff',
            fillOpacity: fillOp
          });
        }
      });
      layer.on('click', () => {
        selectWard(wardNo);
        if (cascadeMode) clearCascade();
        simulateCascade(wardNo);
      });
    }
  }).addTo(map);

  // Invisible centroid markers for flyTo + ward number labels
  RISK_DATA.wards.forEach(w => {
    const marker = L.circleMarker([w.lat, w.lng], { radius: 0, fillOpacity: 0, opacity: 0 }).addTo(map);
    marker.bindPopup(buildPopupHTML(w));
    markers[w.ward] = marker;

    L.marker([w.lat, w.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="font-family:'Space Mono',monospace;font-size:9px;font-weight:700;color:#1a1f2e;text-shadow:0 0 3px #fff,0 0 3px #fff;pointer-events:none;">${w.ward}</div>`,
        iconAnchor: [6, 6],
      }),
      interactive: false,
    }).addTo(map);
  });
}

function renderCircleMarkers() {
  RISK_DATA.wards.forEach(w => {
    const radius = 8 + (w.score / 10) * 14;
    const color = LEVEL_COLORS[w.level];
    const marker = L.circleMarker([w.lat, w.lng], {
      radius, fillColor: color, color: '#fff', weight: 2, opacity: 0.9, fillOpacity: 0.55,
    }).addTo(map);
    if (w.level === 'critical') {
      L.circleMarker([w.lat, w.lng], {
        radius: radius+7, fillColor: 'transparent', color, weight:1.5, opacity:0.25, fillOpacity:0,
      }).addTo(map);
    }
    marker.bindPopup(buildPopupHTML(w));
    marker.on('click', () => { selectWard(w.ward); if(cascadeMode) clearCascade(); simulateCascade(w.ward); });
    markers[w.ward] = marker;
  });
}

// Called by simulation.js to flash ward polygons during cascade
function highlightWardPolygon(wardNo, color, opacity) {
  if (wardLayers[wardNo]) {
    wardLayers[wardNo].forEach(layer => {
      layer.setStyle({ fillColor: color, fillOpacity: opacity, color: color, weight: 2 });
      layer.bringToFront();
    });
  }
}

function resetPolygonStyles() {
  if (!geoJsonLayer) return;
  geoJsonLayer.eachLayer(layer => {
    const wardNo = layer.feature?.properties?.ward_no;
    const w = wardMap[wardNo];
    if (w) {
      let fillOp = w.level === 'critical' ? 0.72 + (w.score/10)*0.15
        : w.level === 'high' ? 0.45 + (w.score/10)*0.25
        : 0.35 + (w.score/10)*0.25;
      layer.setStyle({
        fillColor: LEVEL_COLORS[w.level],
        color: w.level === 'critical' ? LEVEL_COLORS[w.level] : '#fff',
        weight: w.level === 'critical' ? 2.5 : 1.5,
        fillOpacity: fillOp
      });
    }
  });
}

function buildPopupHTML(w) {
  const color = LEVEL_COLORS[w.level];
  return `
    <div style="font-family:'Space Mono',monospace;min-width:170px;padding:6px;">
      <div style="font-size:13px;font-weight:700;color:${color};margin-bottom:4px;">${w.name}</div>
      <div style="font-size:9px;color:#9ba3af;margin-bottom:10px;letter-spacing:0.06em;">WARD ${w.ward} · CLICK TO SIMULATE CASCADE</div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#1a1f2e;margin-bottom:5px;">
        <span>Risk Score</span><span style="font-weight:700;color:${color}">${w.score}/10</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#1a1f2e;margin-bottom:5px;">
        <span>Level</span><span style="font-weight:700;color:${color}">${w.level.toUpperCase()}</span>
      </div>
      <div style="font-size:9px;color:#9ba3af;margin-top:6px;padding-top:6px;border-top:1px solid #eee;">
        Age: ${w.factors.age_score} · Material: ${w.factors.material_score}<br>
        Fault: ${w.factors.fault_distance_score} · Soil: ${w.factors.soil_score}
      </div>
    </div>`;
}
