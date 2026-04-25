/* ═══════════════════════════════════════════════════════════════════
   RiskMapper Nepal — Earthquake Alert Server
   ─────────────────────────────────────────────────────────────────
   Node.js + Express backend that:
   1. Serves the frontend static files
   2. Manages Web Push subscriptions (in-memory)
   3. Polls USGS real-time earthquake feed every 60s
   4. Sends push notifications for significant earthquakes near Nepal
   5. Provides a manual demo trigger for hackathon presentations

   ENDPOINTS:
     GET  /health           → { status: "ok", ... }
     POST /register-token   → Register a push subscription
     POST /demo-earthquake  → Trigger a fake M6.5 earthquake alert
     GET  /api/stats        → Show server stats (subscriptions, etc.)

   HOW TO RUN:
     cd server
     npm install
     npx web-push generate-vapid-keys    (copy the keys into .env)
     node server.js

   STUDENT NOTES:
     - VAPID = Voluntary Application Server Identification
       It's how the browser trusts your push server without Firebase.
     - Web Push works on localhost for development.
     - In production, you'd need HTTPS.
   ═══════════════════════════════════════════════════════════════════ */

const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ── VAPID CONFIGURATION ──────────────────────────────────────────────
// These keys authenticate YOUR server to the push service (Chrome, Firefox, etc.)
// Generate with: npx web-push generate-vapid-keys

// Try to load from .env file (simple parser, no dotenv dependency needed)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...rest] = line.split('=');
        env[key.trim()] = rest.join('=').trim();
      }
    });
  }
  return env;
}

const envVars = loadEnv();
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || envVars.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || envVars.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || envVars.VAPID_SUBJECT     || 'mailto:riskmapper@example.com';
const PORT              = parseInt(process.env.PORT     || envVars.PORT              || '3000', 10);
const USGS_POLL_MS      = parseInt(process.env.USGS_POLL_INTERVAL || envVars.USGS_POLL_INTERVAL || '60000', 10);

// Check if VAPID keys are configured
let vapidConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY &&
    VAPID_PUBLIC_KEY !== 'your_public_key_here' &&
    VAPID_PRIVATE_KEY !== 'your_private_key_here') {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  console.log('✅ VAPID keys configured');
} else {
  console.warn('⚠️  VAPID keys not configured!');
  console.warn('   Run: npx web-push generate-vapid-keys');
  console.warn('   Then paste keys into server/.env');
  console.warn('   Push notifications will NOT work until keys are set.');
}


// ── IN-MEMORY SUBSCRIPTION STORE ─────────────────────────────────────
// In production, use a database. For hackathon, memory is fine.
// We also persist to a JSON file so subscriptions survive server restarts.
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let subscriptions = [];

// Load saved subscriptions
try {
  if (fs.existsSync(SUBS_FILE)) {
    subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    console.log(`📋 Loaded ${subscriptions.length} saved subscription(s)`);
  }
} catch { /* ignore corrupt file */ }

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch { /* ignore write errors */ }
}


// ── USGS EARTHQUAKE TRACKING ─────────────────────────────────────────
// Kathmandu coordinates (used for distance filtering)
const KTM_LAT = 27.7172;
const KTM_LNG = 85.3240;

// Safety thresholds — only alert for earthquakes that matter
const MAG_THRESHOLD = 4.5;           // Ignore anything below M4.5
const DISTANCE_THRESHOLD_KM = 500;   // Ignore earthquakes > 500km from Kathmandu

// Track seen earthquake IDs to avoid duplicate notifications
const seenEarthquakeIds = new Set();

// Haversine formula — great-circle distance in kilometers
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// ── MOBILE ALERT STORE (used by sendPushToAll and GET /api/latest-earthquake) ──
let latestAlert = null;
let alertTimestamp = 0;

// ── SEND PUSH NOTIFICATION TO ALL SUBSCRIBERS ────────────────────────
async function sendPushToAll(payload) {
  // Store alert for mobile app polling
  latestAlert = payload;
  alertTimestamp = Date.now();

  if (!vapidConfigured) {
    console.warn('⚠️  Cannot send push — VAPID keys not configured');
    return { sent: 0, failed: 0 };
  }

  const payloadStr = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const validSubs = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payloadStr);
      validSubs.push(sub);
      sent++;
    } catch (err) {
      console.error(`Push failed for endpoint: ${err.statusCode || err.message}`);
      // 404 or 410 means subscription expired — remove it
      if (err.statusCode === 404 || err.statusCode === 410) {
        failed++;
      } else {
        validSubs.push(sub); // keep it, might be temporary error
        failed++;
      }
    }
  }

  // Clean up expired subscriptions
  subscriptions = validSubs;
  saveSubscriptions();

  console.log(`📤 Push sent: ${sent} success, ${failed} failed`);
  return { sent, failed };
}


// ── POLL USGS EARTHQUAKE FEED ────────────────────────────────────────
// USGS provides free GeoJSON feeds updated every minute:
// https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson
//
// Each feature has:
//   properties.mag      — magnitude
//   properties.place    — human-readable location string
//   properties.time     — Unix timestamp (ms)
//   properties.url      — USGS detail page
//   geometry.coordinates — [longitude, latitude, depth]

async function pollUSGS() {
  try {
    // Dynamic import for node-fetch (works with both CommonJS and ESM)
    const fetch = globalThis.fetch || (await import('node-fetch')).default;

    const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) {
      console.warn(`USGS feed returned HTTP ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const features = data.features || [];
    let alertCount = 0;

    for (const feature of features) {
      const props = feature.properties;
      const coords = feature.geometry.coordinates; // [lng, lat, depth]
      const eqId = feature.id;

      // ── FILTER 1: Skip already-seen earthquakes ──
      if (seenEarthquakeIds.has(eqId)) continue;
      seenEarthquakeIds.add(eqId);

      // ── FILTER 2: Magnitude threshold ──
      if (props.mag < MAG_THRESHOLD) continue;

      // ── FILTER 3: Distance from Kathmandu ──
      const eqLat = coords[1];
      const eqLng = coords[0];
      const distKm = haversineKm(KTM_LAT, KTM_LNG, eqLat, eqLng);
      if (distKm > DISTANCE_THRESHOLD_KM) continue;

      // 🚨 This earthquake passes all filters — ALERT!
      console.log(`🚨 EARTHQUAKE DETECTED: M${props.mag} — ${props.place} (${distKm.toFixed(0)} km from KTM)`);

      const payload = {
        type: 'earthquake',
        title: `⚠️ EARTHQUAKE M${props.mag.toFixed(1)}`,
        body: `${props.place}\n${distKm.toFixed(0)} km from Kathmandu — EVACUATE NOW`,
        magnitude: props.mag,
        lat: eqLat,
        lng: eqLng,
        distance: Math.round(distKm),
        place: props.place,
        time: props.time,
        url: props.url,
        eqId: eqId,
      };

      await sendPushToAll(payload);
      alertCount++;
    }

    if (alertCount === 0 && features.length > 0) {
      // Normal — earthquakes exist but none pass our filters
    }
  } catch (err) {
    console.error('USGS poll error:', err.message);
  }
}


// ════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ════════════════════════════════════════════════════════════════════

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RiskMapper Earthquake Alert Server',
    vapidConfigured,
    subscriptions: subscriptions.length,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Get VAPID public key (frontend needs this to subscribe) ──
app.get('/api/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY === 'your_public_key_here') {
    return res.status(500).json({ error: 'VAPID keys not configured on server' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ── Register push subscription ──
// The browser sends its PushSubscription object here after subscribing.
app.post('/register-token', (req, res) => {
  const subscription = req.body;

  // Validate subscription has required fields
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription: missing endpoint' });
  }

  // Check for duplicate (same endpoint = same browser)
  const exists = subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (exists) {
    console.log('📋 Subscription already registered (updated)');
    // Update existing subscription (keys might have changed)
    subscriptions = subscriptions.map(s =>
      s.endpoint === subscription.endpoint ? subscription : s
    );
  } else {
    subscriptions.push(subscription);
    console.log(`✅ New subscription registered (total: ${subscriptions.length})`);
  }

  saveSubscriptions();
  res.json({
    success: true,
    message: exists ? 'Subscription updated' : 'Subscription registered',
    totalSubscriptions: subscriptions.length,
  });
});

// ── Demo earthquake trigger ──
// Sends a fake M6.5 earthquake notification to all subscribers.
// Use this during hackathon presentation!
app.post('/demo-earthquake', async (req, res) => {
  // Allow custom magnitude/location from request body
  const mag = req.body.magnitude || 6.5;
  const lat = req.body.lat || 27.71;
  const lng = req.body.lng || 85.33;
  const place = req.body.place || '12km SE of Kathmandu, Nepal';

  console.log(`\n🎯 DEMO EARTHQUAKE TRIGGERED: M${mag} at ${place}`);

  if (subscriptions.length === 0) {
    return res.json({
      success: false,
      message: 'No subscriptions registered. Click "Enable Alerts" in the app first!',
    });
  }

  const payload = {
    type: 'earthquake',
    title: `⚠️ EARTHQUAKE M${mag.toFixed(1)}`,
    body: `${place}\nEVACUATE TO NEAREST SAFE ZONE NOW`,
    magnitude: mag,
    lat,
    lng,
    distance: 12,
    place,
    time: Date.now(),
    url: 'https://earthquake.usgs.gov/',
    eqId: `demo-${Date.now()}`,
    isDemo: true,
  };

  const result = await sendPushToAll(payload);

  res.json({
    success: true,
    message: `Demo alert sent to ${result.sent} device(s)`,
    ...result,
    earthquake: { magnitude: mag, place, lat, lng },
  });
});

// ── Server stats ──
app.get('/api/stats', (req, res) => {
  res.json({
    subscriptions: subscriptions.length,
    seenEarthquakes: seenEarthquakeIds.size,
    vapidConfigured,
    pollingIntervalMs: USGS_POLL_MS,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ════════════════════════════════════════════════════════════════════
// MOBILE APP ENDPOINTS
// ════════════════════════════════════════════════════════════════════

// ── Latest earthquake alert (for mobile polling) ──
// The Flutter app polls this every 5 seconds. Returns the most recent
// alert, or { alert: null } if no earthquake is active.
// (latestAlert and alertTimestamp are declared at module top, before sendPushToAll)

app.get('/api/latest-earthquake', (req, res) => {
  // Only return alerts less than 5 minutes old
  const AGE_LIMIT_MS = 5 * 60 * 1000;
  if (latestAlert && (Date.now() - alertTimestamp) < AGE_LIMIT_MS) {
    res.json({ alert: latestAlert, timestamp: alertTimestamp });
  } else {
    res.json({ alert: null });
  }
});

// ── Clear alert (mobile can dismiss it) ──
app.post('/api/clear-alert', (req, res) => {
  latestAlert = null;
  alertTimestamp = 0;
  res.json({ success: true, message: 'Alert cleared' });
});

// ── Ward risk data (so mobile doesn't need to bundle the full dataset) ──
app.get('/api/ward-data', (req, res) => {
  // Read from parent directory's data.js, extract the JSON
  try {
    const dataPath = path.join(__dirname, '..', 'data.js');
    const content = fs.readFileSync(dataPath, 'utf8');
    // Extract the JSON object from the JS file
    const match = content.match(/const RISK_DATA = ({[\s\S]*?});/);
    if (match) {
      res.json(JSON.parse(match[1]));
    } else {
      res.status(500).json({ error: 'Could not parse ward data' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── SERVE STATIC FRONTEND FILES ──────────────────────────────────────
// Serve from parent directory (where index.html, app.js, etc. live)
const frontendPath = path.join(__dirname, '..');
app.use(express.static(frontendPath));

// Fallback: serve index.html for any unmatched routes (SPA behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});


// ── START SERVER ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🌍  RiskMapper Nepal — Earthquake Alert Server     ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  🌐  App:    http://localhost:${PORT}                  ║
║  💊  Health: http://localhost:${PORT}/health            ║
║  📋  Stats:  http://localhost:${PORT}/api/stats         ║
║                                                      ║
║  VAPID Keys: ${vapidConfigured ? '✅ Configured' : '❌ NOT SET — run setup!'}                  ║
║  Subscribers: ${String(subscriptions.length).padEnd(3)}                                ║
║  USGS Poll: Every ${USGS_POLL_MS / 1000}s                             ║
║                                                      ║
${!vapidConfigured ? `║  ⚠️  To enable push notifications:                  ║
║     1. npx web-push generate-vapid-keys              ║
║     2. Paste keys into server/.env                   ║
║     3. Restart server                                ║
║                                                      ║` : `║  ✅  Push notifications ready!                        ║
║  Open http://localhost:${PORT} and click Enable Alerts ║
║                                                      ║`}
╚══════════════════════════════════════════════════════╝
  `);

  // Start USGS polling (disabled for demo purposes)
  if (vapidConfigured) {
    console.log(`🔄 USGS earthquake polling is DISABLED (Demo mode only)`);
    // pollUSGS();
    // setInterval(pollUSGS, USGS_POLL_MS);
  }
});
