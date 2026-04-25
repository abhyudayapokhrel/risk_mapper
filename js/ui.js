/* ═══════════════════════════════════════════════
   RiskMapper Nepal — ui.js
   Sidebar, ward list, stats panel rendering
   ═══════════════════════════════════════════════ */

let activeWard = null;

function buildHeaderStats() {
  const s = RISK_DATA.stats;
  const el = document.getElementById('header-stats');
  el.innerHTML = `
    <div class="hstat critical">${s.critical_count} CRITICAL</div>
    <div class="hstat high">${s.high_count} HIGH</div>
    <div class="hstat moderate">${s.moderate_count} MOD</div>
    <div class="hstat low">${s.low_count} LOW</div>
  `;
}

function buildWardList(filter = '') {
  const el = document.getElementById('ward-list');
  const wards = RISK_DATA.wards.filter(w =>
    w.name.toLowerCase().includes(filter.toLowerCase()) ||
    String(w.ward).includes(filter)
  );
  el.innerHTML = wards.map((w, i) => {
    // Subtle background tint matching risk level for visual sync
    const LEVEL_BG = {
      critical: 'rgba(224,32,32,0.06)',
      high: 'rgba(244,122,31,0.05)',
      moderate: 'rgba(240,180,41,0.04)',
      low: 'rgba(42,185,110,0.04)',
    };
    const bgTint = LEVEL_BG[w.level] || 'transparent';
    const isActive = activeWard === w.ward;
    return `
    <div class="ward-item ${isActive ? 'active' : ''}" data-ward="${w.ward}" style="${!isActive ? 'background:' + bgTint : ''}">
      <span class="ward-rank">${filter ? '' : i + 1}</span>
      <span class="ward-dot" style="background:${LEVEL_COLORS[w.level]}"></span>
      <div class="ward-info">
        <div class="ward-name">${w.name}</div>
        <div class="ward-num">WARD ${w.ward} · ${LEVEL_LABELS[w.level]}</div>
      </div>
      <span class="ward-score-badge" style="color:${LEVEL_COLORS[w.level]}">${w.score}</span>
    </div>
  `;}).join('');

  el.querySelectorAll('.ward-item').forEach(item => {
    item.addEventListener('click', () => {
      selectWard(parseInt(item.dataset.ward));
    });
  });
}

function buildStatsPanel() {
  const s = RISK_DATA.stats;
  const total = s.total_wards;
  // Dynamically compute active threats (critical + high)
  const threats = s.critical_count + s.high_count;
  const threatPct = Math.round((threats / total) * 100);
  // Shelter capacity from low + moderate wards
  const safe = s.moderate_count + s.low_count;
  const shelterPct = Math.round((safe / total) * 100);

  // Update the hardcoded values in the panel
  const panel = document.getElementById('stats-panel');
  const rtsVals = panel.querySelectorAll('.rts-val');
  const rtsBars = panel.querySelectorAll('.rts-bar');
  if (rtsVals[0]) rtsVals[0].textContent = threats;
  if (rtsVals[1]) rtsVals[1].textContent = shelterPct + '%';
  if (rtsBars[0]) rtsBars[0].style.width = threatPct + '%';
  if (rtsBars[1]) rtsBars[1].style.width = shelterPct + '%';

  document.getElementById('stats-rows').innerHTML = [
    ['critical', s.critical_count],
    ['high', s.high_count],
    ['moderate', s.moderate_count],
    ['low', s.low_count],
  ].map(([level, count]) => `
    <div class="sp-row">
      <div class="sp-color" style="background:${LEVEL_COLORS[level]}"></div>
      <div class="sp-label">${level.toUpperCase()}</div>
      <div class="sp-count" style="color:${LEVEL_COLORS[level]}">${count}</div>
    </div>
  `).join('');
}

function selectWard(wardId) {
  activeWard = wardId;
  const w = wardMap[wardId];
  buildWardList(document.getElementById('ward-search').value);

  const detail = document.getElementById('ward-detail');
  const color = LEVEL_COLORS[w.level];
  document.getElementById('wd-name').textContent = w.name;
  document.getElementById('wd-sub').textContent = `Ward ${w.ward} · ${w.level.toUpperCase()}`;
  document.getElementById('wd-score').textContent = w.score;
  document.getElementById('wd-score').style.color = color;

  const f = w.factors;
  document.getElementById('wd-body').innerHTML = [
    ['Building Age', f.age_score],
    ['Material Type', f.material_score],
    ['Fault/PGA', f.fault_distance_score],
    ['Soil (Vs30)', f.soil_score],
  ].map(([label, val]) => `
    <div class="wd-factor">
      <div class="wd-factor-label">${label}</div>
      <div class="wd-bar-wrap">
        <div class="wd-bar" style="width:${val * 10}%; background:${color};"></div>
      </div>
      <div class="wd-factor-val">${val}</div>
    </div>
  `).join('') + (w.real_data ? `
    <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-family:var(--font-mono);font-size:8px;color:var(--text-muted);letter-spacing:0.04em;line-height:1.7;">
      DATA SOURCE: ${w.real_data.source_buildings} BUILDINGS<br>
      AVG DAMAGE: ${w.real_data.avg_damage_grade}/3 · AGE: ${w.real_data.avg_building_age}yr · FLOORS: ${w.real_data.avg_floors}
    </div>
  ` : '');

  detail.classList.remove('hidden');
  map.setView([w.lat, w.lng], 14);
}
