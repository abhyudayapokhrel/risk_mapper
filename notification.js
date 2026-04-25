/* ═══════════════════════════════════════════════════════════════════
   RiskMapper Nepal — notification.js
   ─────────────────────────────────────────────────────────────────
   Frontend push notification registration module.

   WHAT IT DOES:
   1. Registers the service worker (sw.js)
   2. Requests notification permission from the user
   3. Subscribes to Web Push using VAPID public key
   4. Sends the subscription to the backend (/register-token)
   5. Falls back to polling + basic Notification API if Web Push fails

   CALLED BY: app.js when user clicks "Enable Alerts" button

   STUDENT NOTES:
   - The PushSubscription contains an endpoint URL (unique per browser)
     and encryption keys. The server uses these to send push messages.
   - Notification permission can be: 'granted', 'denied', or 'default'.
     'denied' is permanent — user must change it in browser settings.
   - VAPID public key is fetched from the server so we don't hardcode it.
   - If Web Push subscription fails (common on some networks/browsers),
     we fall back to polling the server + showing basic Notification API alerts.
   ═══════════════════════════════════════════════════════════════════ */

// ── State tracking ──
let swRegistration = null;   // ServiceWorkerRegistration object
let isSubscribed = false;    // Whether push subscription is active
let notifInitialized = false; // Prevent double initialization
let useFallbackMode = false; // True if Web Push failed → use polling instead

// ── Server URL (auto-detect backend) ──
// If you opened the app via the Node.js backend (port 3000), same origin works.
// If you opened via VS Code Live Server (port 5500) or another dev server,
// we redirect API calls to the backend on port 3000.
const BACKEND_PORT = 3000;
const SERVER_URL = (function() {
  const origin = window.location.origin;
  // If already on the backend port, use same origin
  if (origin.includes(`:${BACKEND_PORT}`)) return origin;
  // Otherwise, redirect to backend port (keep hostname)
  try {
    const url = new URL(origin);
    url.port = BACKEND_PORT;
    return url.origin;
  } catch {
    return `http://localhost:${BACKEND_PORT}`;
  }
})();

// ── Fallback poll timer (used when Web Push fails) ──
let fallbackPollTimer = null;
let lastSeenEqId = null;

// ── Convert VAPID public key from base64 URL to Uint8Array ──
// Web Push API needs the key as a Uint8Array, but VAPID keys come as base64url strings
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}


// ══════════════════════════════════════════════════════════════════════
// MAIN INITIALIZATION FUNCTION
// Called when user clicks the "Enable Alerts" button
// ══════════════════════════════════════════════════════════════════════
async function initNotifications() {
  // ── Pre-flight checks ──────────────────────────────────────────────
  if (notifInitialized && isSubscribed) {
    showNotifToast('Already enabled! You will receive earthquake alerts.', 'success');
    return true;
  }

  // Check browser support
  if (!('Notification' in window)) {
    showNotifToast('Notifications API not available in this browser.', 'error');
    return false;
  }

  try {
    // ── Step 1: Request notification permission FIRST ─────────────────
    updateAlertBtn('REQUESTING PERMISSION…', true);
    const permission = await Notification.requestPermission();

    if (permission === 'denied') {
      showNotifToast('❌ Notification permission denied. Enable it in browser settings → Site settings → Notifications.', 'error');
      updateAlertBtn('🔔 ENABLE ALERTS', false);
      return false;
    }

    if (permission !== 'granted') {
      showNotifToast('Notification permission not granted.', 'error');
      updateAlertBtn('🔔 ENABLE ALERTS', false);
      return false;
    }

    console.log('[Notif] Permission granted');

    // ── Step 2: Try to register Service Worker ─────────────────────
    let swReady = false;

    if ('serviceWorker' in navigator && 'PushManager' in window) {
      try {
        updateAlertBtn('REGISTERING…', true);
        console.log('[Notif] Registering service worker...');
        console.log('[Notif] Backend URL:', SERVER_URL);

        swRegistration = await navigator.serviceWorker.register('./sw.js');
        console.log('[Notif] Service Worker registered:', swRegistration.scope);

        // Wait for the SW to be ready
        await navigator.serviceWorker.ready;
        console.log('[Notif] Service Worker is ready');
        swReady = true;
      } catch (swErr) {
        console.warn('[Notif] Service Worker registration failed:', swErr.message);
        // Continue to try push subscription or fallback
      }
    } else {
      console.warn('[Notif] Service Workers or PushManager not available');
    }

    // ── Step 3: Try Web Push subscription ───────────────────────────
    let pushSubscribed = false;

    if (swReady) {
      try {
        updateAlertBtn('CONNECTING…', true);

        // Get VAPID public key from server (with timeout so we don't hang forever)
        const keyController = new AbortController();
        const keyTimeout = setTimeout(() => keyController.abort(), 5000);
        let keyResp;
        try {
          keyResp = await fetch(`${SERVER_URL}/api/vapid-public-key`, {
            signal: keyController.signal,
          });
        } catch (fetchErr) {
          clearTimeout(keyTimeout);
          if (fetchErr.name === 'AbortError') {
            throw new Error('Server not responding. Is the backend running on port 3000?');
          }
          throw new Error(`Cannot reach server at ${SERVER_URL}. Start it with: cd server && node server.js`);
        }
        clearTimeout(keyTimeout);
        if (!keyResp.ok) {
          const err = await keyResp.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to get VAPID key from server');
        }
        const { publicKey } = await keyResp.json();
        const applicationServerKey = urlBase64ToUint8Array(publicKey);

        updateAlertBtn('SUBSCRIBING…', true);

        // Check for existing subscription first
        let subscription = await swRegistration.pushManager.getSubscription();

        if (!subscription) {
          // Try subscribing with retry logic
          subscription = await retryPushSubscribe(swRegistration, applicationServerKey);
        }

        if (subscription) {
          console.log('[Notif] Push subscription active');

          // Send subscription to backend
          updateAlertBtn('REGISTERING…', true);
          const regResp = await fetch(`${SERVER_URL}/register-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription),
          });

          if (regResp.ok) {
            const regData = await regResp.json();
            console.log('[Notif] Server response:', regData);
            pushSubscribed = true;
          } else {
            console.warn('[Notif] Failed to register with server');
          }
        }
      } catch (pushErr) {
        console.warn('[Notif] Push subscription failed:', pushErr.message);
        // Will fall back to polling mode
      }
    }

    // ── Step 4: Set up mode (Web Push or Polling Fallback) ──────────
    if (pushSubscribed) {
      // ✅ Full Web Push mode — server pushes notifications to the SW
      useFallbackMode = false;
      isSubscribed = true;
      notifInitialized = true;
      updateAlertBtn('✅ ALERTS ENABLED', false);
      showNotifToast('🔔 Earthquake alerts enabled! You will receive OS-level push notifications.', 'success');
    } else {
      // ⚡ Fallback mode — poll the server every 5s and show basic Notification API alerts
      console.log('[Notif] Falling back to polling mode');
      useFallbackMode = true;
      isSubscribed = true;
      notifInitialized = true;
      startFallbackPolling();
      updateAlertBtn('✅ ALERTS (POLL)', false);
      showNotifToast('🔔 Alerts enabled (polling mode). Web Push unavailable — using fallback notifications.', 'info');
    }

    // Enable the demo button now
    const demoBtn = document.getElementById('demo-earthquake-btn');
    if (demoBtn) demoBtn.disabled = false;

    return true;

  } catch (err) {
    console.error('[Notif] Setup failed:', err);
    showNotifToast(`Setup failed: ${err.message}`, 'error');
    updateAlertBtn('🔔 ENABLE ALERTS', false);
    return false;
  }
}


// ── Retry push subscription (up to 2 attempts) ──────────────────────
async function retryPushSubscribe(registration, applicationServerKey) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[Notif] Push subscribe attempt ${attempt}/2...`);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      console.log('[Notif] Push subscription succeeded on attempt', attempt);
      return subscription;
    } catch (err) {
      console.warn(`[Notif] Attempt ${attempt} failed:`, err.message);
      if (attempt < 2) {
        // Wait 1 second before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  return null; // All attempts failed
}


// ══════════════════════════════════════════════════════════════════════
// SERVICE WORKER MESSAGE LISTENER
// When a Web Push arrives, the SW postMessages the earthquake data to
// the page so we can show the in-app overlay immediately (in addition
// to the OS-level notification the SW already showed).
// ══════════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'EARTHQUAKE_PUSH') return;

    console.log('[Notif] Received push data from SW:', msg.title);

    const eq = msg.earthquake || {};
    const params = new URLSearchParams({
      action: 'evacuate',
      lat: eq.lat || 27.71,
      lng: eq.lng || 85.33,
      mag: eq.magnitude || 0,
      place: eq.place || 'Near Kathmandu',
    });

    // Show in-app earthquake alert overlay
    if (typeof showEarthquakeAlertOverlay === 'function') {
      showEarthquakeAlertOverlay(params);

      // Auto-trigger evacuation routes after the overlay displays
      setTimeout(() => {
        if (typeof showEvacRoutes === 'function') {
          showEvacRoutes();
        }
      }, 3000);
    }
  });
}


// ══════════════════════════════════════════════════════════════════════
// FALLBACK POLLING MODE
// When Web Push fails, poll the server every 5 seconds for new alerts
// and use the basic Notification API to show OS-level notifications.
// ══════════════════════════════════════════════════════════════════════
function startFallbackPolling() {
  if (fallbackPollTimer) return; // Already polling

  console.log('[Notif] Starting fallback polling (every 5s)...');
  fallbackPollTimer = setInterval(pollForEarthquake, 5000);
  // First poll immediately
  pollForEarthquake();
}

function stopFallbackPolling() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

async function pollForEarthquake() {
  try {
    const resp = await fetch(`${SERVER_URL}/api/latest-earthquake`);
    if (!resp.ok) return;

    const data = await resp.json();
    if (!data.alert) return;

    const eq = data.alert;
    const eqId = eq.eqId || `${eq.time}`;

    // Skip if we already showed this one
    if (eqId === lastSeenEqId) return;
    lastSeenEqId = eqId;

    console.log('[Notif] New earthquake via polling:', eq.title);

    // Build shared params for this earthquake
    const eqParams = new URLSearchParams({
      action: 'evacuate',
      lat: eq.lat || 27.71,
      lng: eq.lng || 85.33,
      mag: eq.magnitude || 0,
      place: eq.place || 'earthquake',
    });

    // Track whether the notification click already triggered the overlay
    let triggeredViaNotifClick = false;

    // Show OS-level notification using basic Notification API
    if (Notification.permission === 'granted') {
      const notif = new Notification(eq.title || '⚠️ EARTHQUAKE ALERT', {
        body: eq.body || `M${eq.magnitude} — ${eq.place}`,
        icon: '/notification-icon.png',
        badge: '/notification-icon.png',
        tag: 'earthquake-alert',
        renotify: true,
        requireInteraction: true,
      });

      // Handle click — trigger evacuation when user taps the notification
      notif.onclick = function() {
        triggeredViaNotifClick = true;
        window.focus();
        
        if (typeof showEarthquakeAlertOverlay === 'function') {
          showEarthquakeAlertOverlay(eqParams);
          setTimeout(() => {
            if (typeof showEvacRoutes === 'function') {
              showEvacRoutes();
            }
          }, 3000);
        }
        notif.close();
      };
    }

    // Show in-app alert overlay ONLY if the page is currently focused/visible
    // This prevents double-triggering when the user also clicks the OS notification
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      // Small delay to let the notification onclick fire first if user clicks fast
      setTimeout(() => {
        if (triggeredViaNotifClick) return; // notification click already handled it
        if (typeof showEarthquakeAlertOverlay === 'function') {
          showEarthquakeAlertOverlay(eqParams);

          // Auto-trigger evacuation after 3s
          setTimeout(() => {
            if (typeof showEvacRoutes === 'function') {
              showEvacRoutes();
            }
          }, 3000);
        }
      }, 500);
    }
  } catch (err) {
    // Silently ignore poll errors
  }
}


// ══════════════════════════════════════════════════════════════════════
// TRIGGER DEMO EARTHQUAKE (calls backend /demo-earthquake)
// ══════════════════════════════════════════════════════════════════════
async function triggerDemoEarthquake() {
  const btn = document.getElementById('demo-earthquake-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '… SENDING';
  }

  try {
    const demoController = new AbortController();
    const demoTimeout = setTimeout(() => demoController.abort(), 5000);
    let resp;
    try {
      resp = await fetch(`${SERVER_URL}/demo-earthquake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnitude: 6.5,
          lat: 27.71,
          lng: 85.33,
          place: '12km SE of Kathmandu, Nepal',
        }),
        signal: demoController.signal,
      });
    } catch (fetchErr) {
      clearTimeout(demoTimeout);
      if (fetchErr.name === 'AbortError') {
        throw new Error('Server not responding. Is the backend running?');
      }
      throw new Error(`Cannot reach server at ${SERVER_URL}`);
    }
    clearTimeout(demoTimeout);

    const data = await resp.json();

    if (data.success) {
      showNotifToast(`Demo alert sent! ${data.message}`, 'success');

      // In fallback mode, trigger an immediate poll so the notification shows fast
      if (useFallbackMode) {
        setTimeout(pollForEarthquake, 500);
      }
    } else {
      showNotifToast(data.message || 'Demo trigger failed.', 'error');
    }
  } catch (err) {
    showNotifToast(`Demo failed: ${err.message}`, 'error');
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = '⚡ DEMO EARTHQUAKE';
  }
}


// ══════════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════════

// Update the "Enable Alerts" button state
function updateAlertBtn(text, disabled) {
  const btn = document.getElementById('enable-alerts-btn');
  if (btn) {
    btn.textContent = text;
    btn.disabled = disabled;
  }
}

// Show a toast notification inside the app (not OS notification)
// This gives visual feedback during the setup flow
function showNotifToast(message, type = 'info') {
  // Remove any existing toast
  const existing = document.getElementById('notif-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'notif-toast';
  toast.className = `notif-toast notif-toast-${type}`;
  toast.innerHTML = `
    <div class="notif-toast-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</div>
    <div class="notif-toast-text">${message}</div>
  `;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('visible'));

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}


// ══════════════════════════════════════════════════════════════════════
// EARTHQUAKE ALERT OVERLAY (shown when app loads via notification click)
// ══════════════════════════════════════════════════════════════════════
function showEarthquakeAlertOverlay(params) {
  const mag = params.get('mag') || '?';
  const place = params.get('place') || 'Near Kathmandu';

  // Create the full-screen earthquake alert overlay
  const overlay = document.createElement('div');
  overlay.id = 'earthquake-alert-overlay';
  overlay.className = 'eq-alert-overlay';
  overlay.innerHTML = `
    <div class="eq-alert-content">
      <div class="eq-alert-icon">⚠️</div>
      <div class="eq-alert-title">EARTHQUAKE DETECTED</div>
      <div class="eq-alert-mag">M${parseFloat(mag).toFixed(1)}</div>
      <div class="eq-alert-place">${decodeURIComponent(place)}</div>
      <div class="eq-alert-subtitle">COMPUTING EVACUATION ROUTES…</div>
      <div class="eq-alert-pulse"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Show with animation
  requestAnimationFrame(() => overlay.classList.add('visible'));

  // Auto-dismiss after evacuation routes start loading
  setTimeout(() => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 600);
  }, 3000);
}
