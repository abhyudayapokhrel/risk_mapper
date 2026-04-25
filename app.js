/* ═══════════════════════════════════════════════
   RiskMapper Nepal — app.js
   Application bootstrap and event bindings
   ═══════════════════════════════════════════════ */

let wardMap = {};

window.addEventListener('load', () => {
  // Build ward lookup map
  RISK_DATA.wards.forEach(w => wardMap[w.ward] = w);

  // Render UI components
  buildHeaderStats();
  buildWardList();
  buildStatsPanel();

  // Initialize Leaflet map
  initMap();

  // Bind interactive events
  bindEvents();

  // Make floating panels draggable
  makeDraggable(document.getElementById('cascade-info'), '.ci-title');
  makeDraggable(document.getElementById('park-info'), '.ci-title');
  makeDraggable(document.getElementById('stats-panel'), '.rts-header');
  makeDraggable(document.getElementById('ward-detail'), '.wd-header');

  // Hide loading screen
  setTimeout(() => {
    const loader = document.getElementById('loading');
    loader.style.opacity = '0';
    setTimeout(() => loader.style.display = 'none', 400);

    // ── EARTHQUAKE NOTIFICATION HANDLER ──────────────────────────────
    // When a push notification is clicked, the service worker opens:
    //   /index.html?action=evacuate&lat=27.71&lng=85.33&mag=6.5&place=...
    // We detect that here and auto-trigger the evacuation flow.
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'evacuate') {
      console.log('🚨 Earthquake notification triggered — auto-evacuating');

      // Show dramatic earthquake alert overlay
      if (typeof showEarthquakeAlertOverlay === 'function') {
        showEarthquakeAlertOverlay(params);
      }

      // Wait for map tiles to fully load, then trigger evacuation routing
      // Uses the EXISTING showEvacRoutes() function from simulation.js
      setTimeout(() => {
        if (typeof showEvacRoutes === 'function') {
          showEvacRoutes();
        } else if (typeof findNearestPark === 'function') {
          // Fallback to open space finder
          findNearestPark();
        }
      }, 2000);

      // Clean URL params so refresh doesn't re-trigger
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, 900);
});

function bindEvents() {
  // Cascade button — uses activeWard if one is selected, else top ward
  document.getElementById('cascade-btn').addEventListener('click', () => {
    if (cascadeMode) clearCascade();
    else simulateCascade(activeWard || RISK_DATA.wards[0].ward);
  });

  // Evac routes button
  document.getElementById('evac-btn').addEventListener('click', () => {
    if (evacuMode) clearEvac();
    else showEvacRoutes();
  });

  // Park / nearest open space button
  document.getElementById('park-btn').addEventListener('click', () => {
    if (parkMode) clearPark();
    else findNearestPark();
  });

  // Ward search filter
  document.getElementById('ward-search').addEventListener('input', e => {
    buildWardList(e.target.value);
  });

  // Ward detail close button
  document.getElementById('wd-close').addEventListener('click', () => {
    document.getElementById('ward-detail').classList.add('hidden');
    activeWard = null;
    buildWardList(document.getElementById('ward-search').value);
  });
}

/* ── DRAGGABLE PANELS ──
   Click-and-drag on the handle element to reposition floating panels.
   Uses pointer events for smooth cross-browser dragging. */
function makeDraggable(panel, handleSelector) {
  if (!panel) return;
  const handle = panel.querySelector(handleSelector);
  if (!handle) return;

  handle.style.cursor = 'grab';
  handle.style.userSelect = 'none';

  let isDragging = false;
  let startX, startY, startLeft, startTop;

  handle.addEventListener('pointerdown', e => {
    // Don't drag on buttons inside the handle
    if (e.target.tagName === 'BUTTON') return;

    isDragging = true;
    handle.style.cursor = 'grabbing';
    handle.setPointerCapture(e.pointerId);

    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent.getBoundingClientRect();

    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left - parentRect.left;
    startTop = rect.top - parentRect.top;

    // Switch from auto positioning to explicit positioning
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = '600';

    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = (startLeft + dx) + 'px';
    panel.style.top = (startTop + dy) + 'px';
    e.preventDefault();
  });

  handle.addEventListener('pointerup', () => {
    isDragging = false;
    handle.style.cursor = 'grab';
  });

  handle.addEventListener('lostpointercapture', () => {
    isDragging = false;
    handle.style.cursor = 'grab';
  });
}

/* ── MOBILE SIDEBAR TOGGLE ──
   Hamburger button opens/closes the sidebar as a drawer on mobile.
   The overlay backdrop closes it when tapped. */
function toggleSidebar() {
  const aside = document.querySelector('aside');
  const btn = document.getElementById('hamburger-btn');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = aside.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  overlay.classList.toggle('visible', isOpen);
}

// Auto-close sidebar when any action button is clicked (mobile UX)
document.addEventListener('click', (e) => {
  if (e.target.closest('.sidebar-actions .btn')) {
    const aside = document.querySelector('aside');
    if (aside.classList.contains('open')) {
      toggleSidebar();
    }
  }
});
