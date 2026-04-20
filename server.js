const express = require('express');
const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Security Config ───────────────────────────────────────────────────────────
// Set SETUP_TOKEN as an environment variable in Railway.
// The setup.html must send this token when connecting.
// If not set, setup panel is disabled entirely.
const SETUP_TOKEN = process.env.SETUP_TOKEN || null;

const MAX_ACTIVE_USERS  = 30;
const MAX_QUEUE_LENGTH  = 50;   // per wall – prevent queue flooding
const MAX_WALLS         = 20;   // prevent wall name spam
const MAX_MSG_BYTES     = 2048; // max incoming message size
const RATE_LIMIT_MS     = 40;   // min ms between update messages per client (~25/s)
const MAX_STRING_LEN    = 64;   // max length for userId, wallId, color strings

// ─── Input sanitization ────────────────────────────────────────────────────────
function sanitizeString(val, maxLen = MAX_STRING_LEN) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen).replace(/[<>\x00-\x1f]/g, '');
}

function sanitizeLine(line) {
  if (!line || typeof line !== 'object') return null;
  return {
    x:         Math.max(0, Math.min(1,   parseFloat(line.x)         || 0)),
    y:         Math.max(0, Math.min(1,   parseFloat(line.y)         || 0)),
    angle:     Math.max(0, Math.min(180, parseFloat(line.angle)     || 0)),
    thickness: Math.max(1, Math.min(50,  parseInt(line.thickness)   || 2)),
    color:     /^#[0-9a-fA-F]{3,8}$/.test(line.color) ? line.color : '#ffffff',
  };
}

// ─── Global Settings ───────────────────────────────────────────────────────────
const globalSettings = {
  fadeMs:        2 * 60 * 1000,
  thicknessMin:  1,
  thicknessMax:  15,
  shakeEnabled:  true,
  shakeStrength: 1.0,
  waveAmp:       0,
  waveSpeed:     1.0,
  colorRemap:    0,
};

const setupClients = new Set();
const soundClients = new Set();
const walls = {};

function getOrCreateWall(wallId) {
  if (Object.keys(walls).length >= MAX_WALLS && !walls[wallId]) return null;
  if (!walls[wallId]) {
    walls[wallId] = {
      activeUsers: new Map(),
      queue:       [],
      lines:       [],
      renderers:   new Set(),
    };
  }
  return walls[wallId];
}

// ─── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcastRenderers(wallId, message, excludeWs = null) {
  const wall = walls[wallId];
  if (!wall) return;
  const data = JSON.stringify(message);
  for (const rws of wall.renderers) {
    if (rws !== excludeWs && rws.readyState === WebSocket.OPEN) rws.send(data);
  }
}

function broadcastAllClients(message) {
  const data = JSON.stringify(message);
  for (const [, wall] of Object.entries(walls)) {
    for (const rws of wall.renderers) {
      if (rws.readyState === WebSocket.OPEN) rws.send(data);
    }
    for (const [, u] of wall.activeUsers) {
      if (u.ws.readyState === WebSocket.OPEN) u.ws.send(data);
    }
    for (const q of wall.queue) {
      if (q.ws.readyState === WebSocket.OPEN) q.ws.send(data);
    }
  }
}

function broadcastSetup(message) {
  const data = JSON.stringify(message);
  for (const ws of setupClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastSound(message) {
  const data = JSON.stringify(message);
  for (const ws of soundClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendQueuePositions(wallId) {
  const wall = walls[wallId];
  if (!wall) return;
  wall.queue.forEach((entry, index) => {
    if (entry.ws.readyState === WebSocket.OPEN)
      entry.ws.send(JSON.stringify({ type: 'queue_position', position: index + 1 }));
  });
}

function promoteFromQueue(wallId) {
  const wall = getOrCreateWall(wallId);
  if (!wall || wall.queue.length === 0 || wall.activeUsers.size >= MAX_ACTIVE_USERS) return;
  const next = wall.queue.shift();
  const sessionId = uuidv4();
  wall.activeUsers.set(next.userId, { ws: next.ws, lineData: null, sessionId, isRenderer: false });
  if (next.ws.readyState === WebSocket.OPEN) {
    next.ws.send(JSON.stringify({
      type: 'active', sessionId,
      activeCount: wall.activeUsers.size,
      settings: globalSettings,
    }));
  }
  broadcastRenderers(wallId, { type: 'user_joined', userId: next.userId, activeCount: wall.activeUsers.size });
  sendQueuePositions(wallId);
  broadcastSound({ type: 'user_joined', userId: wallId + '_' + next.userId });
}

function getStatusSnapshot() {
  const wallsInfo = {};
  for (const [wid, w] of Object.entries(walls)) {
    wallsInfo[wid] = {
      rendererCount: w.renderers.size,
      activeUsers:   w.activeUsers.size,
      queueLength:   w.queue.length,
      savedLines:    w.lines.length,
    };
  }
  return { type: 'status', walls: wallsInfo, settings: globalSettings };
}

setInterval(() => {
  if (setupClients.size > 0) broadcastSetup(getStatusSnapshot());
}, 2000);

// ─── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let assignedWallId = null;
  let assignedUserId = null;
  let isRenderer     = false;
  let isSetup        = false;
  let lastUpdateTime = 0; // for rate limiting

  ws.on('message', (raw) => {
    // ── Max message size guard ──
    if (raw.length > MAX_MSG_BYTES) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    // ── Setup client (requires token) ──
    if (msg.type === 'setup_join') {
      if (SETUP_TOKEN && msg.token !== SETUP_TOKEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close();
        return;
      }
      isSetup = true;
      setupClients.add(ws);
      ws.send(JSON.stringify(getStatusSnapshot()));
      return;
    }

    if (msg.type === 'sound_join') {
      isSetup = true;
      soundClients.add(ws);
      const allActive = [], allSaved = [];
      for (const [wid, wall] of Object.entries(walls)) {
        for (const [uid, u] of wall.activeUsers) {
          if (!u.isRenderer && u.lineData) allActive.push({ userId: wid + '_' + uid, line: u.lineData });
        }
        for (const line of wall.lines) allSaved.push(line);
      }
      ws.send(JSON.stringify({ type: 'full_state', activeUsers: allActive, savedLines: allSaved }));
      return;
    }

    // ── Setup-only commands (require authenticated setup connection) ──
    if (msg.type === 'setup_settings' || msg.type === 'setup_broadcast' || msg.type === 'setup_clear_all') {
      if (!isSetup || !setupClients.has(ws)) return; // silently ignore from non-setup clients

      if (msg.type === 'setup_settings') {
        // Validate ranges to prevent nonsense values
        if (msg.fadeMs        !== undefined) globalSettings.fadeMs        = Math.max(30000, Math.min(999999999, +msg.fadeMs || 120000));
        if (msg.thicknessMin  !== undefined) globalSettings.thicknessMin  = Math.max(1, Math.min(50, +msg.thicknessMin || 1));
        if (msg.thicknessMax  !== undefined) globalSettings.thicknessMax  = Math.max(1, Math.min(50, +msg.thicknessMax || 15));
        if (msg.shakeEnabled  !== undefined) globalSettings.shakeEnabled  = Boolean(msg.shakeEnabled);
        if (msg.shakeStrength !== undefined) globalSettings.shakeStrength = Math.max(0, Math.min(10, +msg.shakeStrength || 1));
        if (msg.waveAmp       !== undefined) globalSettings.waveAmp       = Math.max(0, Math.min(100, +msg.waveAmp || 0));
        if (msg.waveSpeed     !== undefined) globalSettings.waveSpeed     = Math.max(0, Math.min(50, +msg.waveSpeed || 1));
        if (msg.colorRemap    !== undefined) globalSettings.colorRemap    = Math.max(0, Math.min(1,  +msg.colorRemap || 0));
        broadcastAllClients({ type: 'settings_update', settings: globalSettings });
        broadcastSetup(getStatusSnapshot());
        return;
      }

      if (msg.type === 'setup_broadcast') {
        // Only allow known safe message types to be broadcast
        const allowed = ['recording_start', 'recording_stop'];
        if (msg.message && allowed.includes(msg.message.type)) {
          for (const [wid] of Object.entries(walls)) broadcastRenderers(wid, msg.message);
        }
        return;
      }

      if (msg.type === 'setup_clear_all') {
        for (const [wid, wall] of Object.entries(walls)) {
          wall.lines = [];
          broadcastRenderers(wid, { type: 'clear_all' });
        }
        broadcastSound({ type: 'clear_all' });
        broadcastSetup(getStatusSnapshot());
        return;
      }
    }

    // ── Renderer ──
    if (msg.type === 'renderer_join') {
      const wallId = sanitizeString(msg.wallId, 32);
      if (!wallId) return;
      const wall = getOrCreateWall(wallId);
      if (!wall) return;
      assignedWallId = wallId;
      isRenderer = true;
      wall.renderers.add(ws);
      const activeArr = [];
      for (const [uid, u] of wall.activeUsers) {
        if (!u.isRenderer && u.lineData) activeArr.push({ userId: uid, line: u.lineData });
      }
      ws.send(JSON.stringify({ type: 'full_state', activeUsers: activeArr, savedLines: wall.lines, settings: globalSettings }));
      broadcastSetup(getStatusSnapshot());
      return;
    }

    // ── Mobile app ──
    if (msg.type === 'join') {
      const wallId = sanitizeString(msg.wallId, 32);
      const userId = sanitizeString(msg.userId, 64);
      if (!wallId || !userId) return;
      const wall = getOrCreateWall(wallId);
      if (!wall) { ws.send(JSON.stringify({ type: 'error', message: 'Server full' })); return; }
      assignedWallId = wallId;
      assignedUserId = userId;

      if (wall.activeUsers.size < MAX_ACTIVE_USERS) {
        const sessionId = uuidv4();
        wall.activeUsers.set(userId, { ws, lineData: null, sessionId, isRenderer: false });
        ws.send(JSON.stringify({ type: 'active', sessionId, activeCount: wall.activeUsers.size, settings: globalSettings }));
        broadcastRenderers(wallId, { type: 'user_joined', userId, activeCount: wall.activeUsers.size });
      } else if (wall.queue.length < MAX_QUEUE_LENGTH) {
        wall.queue.push({ userId, ws });
        ws.send(JSON.stringify({ type: 'queued', position: wall.queue.length }));
      } else {
        // Queue full – reject politely
        ws.send(JSON.stringify({ type: 'queue_full' }));
      }
      broadcastSetup(getStatusSnapshot());
      return;
    }

    if (msg.type === 'update') {
      // Rate limiting: ignore updates faster than RATE_LIMIT_MS
      const now = Date.now();
      if (now - lastUpdateTime < RATE_LIMIT_MS) return;
      lastUpdateTime = now;

      const wallId = sanitizeString(msg.wallId, 32);
      const userId = sanitizeString(msg.userId, 64);
      if (!wallId || !userId) return;
      const wall = walls[wallId];
      if (!wall) return;
      const user = wall.activeUsers.get(userId);
      if (!user) return; // must be registered first
      const line = sanitizeLine(msg.line);
      if (!line) return;
      user.lineData = line;
      broadcastRenderers(wallId, { type: 'user_update', userId, line });
      broadcastSound({ type: 'user_update', userId: wallId + '_' + userId, line });
      return;
    }

    if (msg.type === 'save') {
      const wallId = sanitizeString(msg.wallId, 32);
      const userId = sanitizeString(msg.userId, 64);
      if (!wallId || !userId) return;
      const wall = walls[wallId];
      if (!wall) return;
      if (!wall.activeUsers.has(userId)) return; // must be active user
      const line = sanitizeLine(msg.line);
      if (!line) return;
      const savedLine = { ...line, id: uuidv4(), savedAt: Date.now() };
      wall.lines.push(savedLine);
      if (wall.lines.length > 200) wall.lines = wall.lines.slice(-200);
      broadcastRenderers(wallId, { type: 'user_saved', userId, line: savedLine });
      broadcastSound({ type: 'user_saved', userId: wallId + '_' + userId, line: savedLine });
      wall.activeUsers.delete(userId);
      ws.send(JSON.stringify({ type: 'saved_ack' }));
      promoteFromQueue(wallId);
      broadcastRenderers(wallId, { type: 'user_left', userId, activeCount: wall.activeUsers.size });
      broadcastSound({ type: 'user_left', userId: wallId + '_' + userId });
      broadcastSetup(getStatusSnapshot());
      return;
    }
  });

  ws.on('close', () => {
    if (isSetup) { setupClients.delete(ws); soundClients.delete(ws); return; }
    if (!assignedWallId) return;
    const wall = walls[assignedWallId];
    if (!wall) return;
    if (isRenderer) { wall.renderers.delete(ws); broadcastSetup(getStatusSnapshot()); return; }
    if (assignedUserId) {
      const wasActive = wall.activeUsers.has(assignedUserId);
      wall.activeUsers.delete(assignedUserId);
      wall.queue = wall.queue.filter(e => e.userId !== assignedUserId);
      if (wasActive) {
        broadcastRenderers(assignedWallId, { type: 'user_left', userId: assignedUserId, activeCount: wall.activeUsers.size });
        broadcastSound({ type: 'user_left', userId: assignedWallId + '_' + assignedUserId });
        promoteFromQueue(assignedWallId);
      }
      sendQueuePositions(assignedWallId);
      broadcastSetup(getStatusSnapshot());
    }
  });
});

// ─── REST ──────────────────────────────────────────────────────────────────────
app.get('/api/walls', (req, res) => {
  const result = {};
  for (const [wid, w] of Object.entries(walls)) {
    result[wid] = { activeCount: w.activeUsers.size, queueLength: w.queue.length, renderers: w.renderers.size };
  }
  res.json(result);
});
app.get('/api/settings', (req, res) => res.json(globalSettings));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨 Facade Projection Server running on port ${PORT}`);
  if (!SETUP_TOKEN) console.warn('  ⚠️  SETUP_TOKEN not set – setup panel is open to anyone!');
  else              console.log('  🔒 Setup panel protected by token');
  console.log(`   Setup:    http://localhost:${PORT}/setup.html`);
  console.log(`   Renderer: http://localhost:${PORT}/renderer.html?wall=WALL_ID`);
  console.log(`   Mobile:   http://localhost:${PORT}/app.html?wall=WALL_ID\n`);
});
