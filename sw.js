/* ═══════════════════════════════════════════════════════════════════
   RiskMapper Nepal — Service Worker (sw.js)
   ─────────────────────────────────────────────────────────────────
   This file MUST live at the root of the site (next to index.html)
   so its scope covers the entire app.

   WHAT IT DOES:
   1. Listens for 'push' events from the server (via Web Push)
   2. Shows an OS-level notification with earthquake details
   3. When user clicks the notification, opens/focuses the app
      with ?action=evacuate so it auto-triggers evacuation routing

   STUDENT NOTES:
   - Service workers run in the background, even when the tab is closed
   - They can receive push messages and show notifications
   - They CANNOT access the DOM directly (no document.*)
   - They communicate with the page via postMessage or URL params
   ═══════════════════════════════════════════════════════════════════ */

// ── PUSH EVENT ───────────────────────────────────────────────────────
// Fired when the server sends a push notification via web-push library.
// The event.data contains the JSON payload from our server.
self.addEventListener('push', (event) => {
  console.log('[SW] Push received');

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error('[SW] Failed to parse push data:', e);
    data = {
      title: '⚠️ EARTHQUAKE ALERT',
      body: 'Seismic activity detected near Kathmandu. Open RiskMapper for evacuation routes.',
    };
  }

  // Build notification options
  const title = data.title || '⚠️ EARTHQUAKE ALERT';
  const options = {
    body: data.body || 'Earthquake detected near your area. Open app for evacuation route.',
    icon: '/notification-icon.png',          // App icon shown in notification
    badge: '/notification-icon.png',         // Small icon for Android status bar
    vibrate: [300, 100, 300, 100, 300],      // SOS-style vibration pattern
    requireInteraction: true,                // Don't auto-dismiss — user must tap
    urgency: 'high',                         // Tell push service this is urgent
    tag: 'earthquake-alert',                 // Group notifications — new replaces old
    renotify: true,                          // Vibrate again even if tag is same

    // Store earthquake data so notificationclick can use it
    data: {
      type: data.type || 'earthquake',
      magnitude: data.magnitude || 0,
      lat: data.lat || 27.71,
      lng: data.lng || 85.33,
      place: data.place || 'Near Kathmandu',
      distance: data.distance || 0,
      time: data.time || Date.now(),
      url: data.url || '',
      isDemo: data.isDemo || false,
    },

    // Action buttons shown on the notification (Android/Desktop)
    actions: [
      {
        action: 'evacuate',
        title: '🏃 EVACUATE NOW',
      },
      {
        action: 'dismiss',
        title: 'Dismiss',
      },
    ],
  };

  // Show the notification — waitUntil keeps the SW alive until done
  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      // Also notify any open app tabs so they can show the in-app overlay immediately
      // (Without this, the user only sees the OS notification and nothing happens in-app)
      return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        windowClients.forEach(client => {
          client.postMessage({
            type: 'EARTHQUAKE_PUSH',
            earthquake: options.data,
            title: title,
            body: options.body,
          });
        });
      });
    })
  );
});


// ── NOTIFICATION CLICK ───────────────────────────────────────────────
// Fired when the user clicks the notification or one of its action buttons.
// We open/focus the app with URL params that trigger evacuation routing.
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked, action:', event.action);

  // Close the notification
  event.notification.close();

  // If user clicked "dismiss", do nothing
  if (event.action === 'dismiss') return;

  // Build the URL with earthquake data as query parameters
  // app.js will read these on load and auto-trigger showEvacRoutes()
  const eqData = event.notification.data || {};
  const params = new URLSearchParams({
    action: 'evacuate',
    lat: eqData.lat || 27.71,
    lng: eqData.lng || 85.33,
    mag: eqData.magnitude || 0,
    place: eqData.place || 'earthquake',
  });

  // Use the service worker's scope (which points to the app root)
  // to correctly resolve the URL even if hosted without index.html explicitly in the path.
  const targetUrl = new URL('?' + params.toString(), self.registration.scope).href;

  // Try to find an existing RiskMapper tab and focus it,
  // otherwise open a new tab
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Check if the app is already open in a tab
        for (const client of windowClients) {
          const clientUrl = client.url || '';
          if (clientUrl.includes('index.html') || clientUrl.includes('localhost') || clientUrl.endsWith('/')) {
            // Navigate existing tab to the evacuation URL, then focus it
            if (typeof client.navigate === 'function') {
              return client.navigate(targetUrl).then(() => client.focus());
            }
            // Fallback: focus and let the page pick up the params via postMessage
            return client.focus();
          }
        }
        // No existing tab — open a new one
        return clients.openWindow(targetUrl);
      })
      .catch((err) => {
        console.error('[SW] notificationclick error:', err);
        // Last resort: just open a new window
        return clients.openWindow(targetUrl);
      })
  );
});


// ── INSTALL & ACTIVATE ───────────────────────────────────────────────
// These lifecycle events ensure the SW activates immediately.
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  // Skip waiting — activate immediately (don't wait for old SW to die)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activated');
  // Claim all open tabs immediately (don't wait for page reload)
  event.waitUntil(clients.claim());
});
