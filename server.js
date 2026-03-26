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

// ─── Global Settings ───────────────────────────────────────────────────────────
const globalSettings = {
  fadeMs:        2 * 60 * 1000,
  thicknessMin:  1,
  thicknessMax:  15,
  shakeEnabled:  true,
  shakeStrength: 1.0,
  waveAmp:       0,             // wave amplitude in px (0 = off)
  waveSpeed:     1.0,           // wave speed multiplier
  colorRemap:    0,             // 0 = normal, 1 = blue/yellow, 0..1 blend
};

// Setup connections (admin clients)
const setupClients = new Set();
// Sound renderer connections (global, all walls)
const soundClients = new Set();

// ─── Wall State ────────────────────────────────────────────────────────────────
const MAX_ACTIVE_USERS = 30;
const walls = {};

function getOrCreateWall(wallId) {
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
  if (wall.queue.length === 0 || wall.activeUsers.size >= MAX_ACTIVE_USERS) return;
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

// Broadcast status to setup clients every 2 seconds
setInterval(() => {
  if (setupClients.size > 0) broadcastSetup(getStatusSnapshot());
}, 2000);

// ─── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let assignedWallId = null;
  let assignedUserId = null;
  let isRenderer     = false;
  let isSetup        = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    // ── Setup client ──
    if (msg.type === 'setup_join') {
      isSetup = true;
      setupClients.add(ws);
      ws.send(JSON.stringify(getStatusSnapshot()));
      return;
    }

    if (msg.type === 'sound_join') {
      // Sound renderer subscribes to ALL walls
      isSetup = true; // reuse isSetup flag for cleanup
      soundClients.add(ws);
      // Send full state: all active lines + saved lines across all walls
      const allActive = [];
      const allSaved  = [];
      for (const [wid, wall] of Object.entries(walls)) {
        for (const [uid, u] of wall.activeUsers) {
          if (!u.isRenderer && u.lineData) {
            allActive.push({ userId: wid + '_' + uid, line: u.lineData });
          }
        }
        for (const line of wall.lines) allSaved.push(line);
      }
      ws.send(JSON.stringify({ type: 'full_state', activeUsers: allActive, savedLines: allSaved }));
      return;
    }

    if (msg.type === 'setup_settings') {
      // Update global settings
      if (msg.fadeMs        !== undefined) globalSettings.fadeMs        = msg.fadeMs;
      if (msg.thicknessMin  !== undefined) globalSettings.thicknessMin  = msg.thicknessMin;
      if (msg.thicknessMax  !== undefined) globalSettings.thicknessMax  = msg.thicknessMax;
      if (msg.shakeEnabled  !== undefined) globalSettings.shakeEnabled  = msg.shakeEnabled;
      if (msg.shakeStrength !== undefined) globalSettings.shakeStrength = msg.shakeStrength;
      if (msg.waveAmp       !== undefined) globalSettings.waveAmp       = msg.waveAmp;
      if (msg.waveSpeed     !== undefined) globalSettings.waveSpeed     = msg.waveSpeed;
      if (msg.colorRemap    !== undefined) globalSettings.colorRemap    = msg.colorRemap;
      // Push to all clients
      broadcastAllClients({ type: 'settings_update', settings: globalSettings });
      broadcastSetup(getStatusSnapshot());
      return;
    }

    if (msg.type === 'setup_broadcast') {
      // Forward arbitrary message to all renderers on all walls
      for (const [wid] of Object.entries(walls)) {
        broadcastRenderers(wid, msg.message);
      }
      return;
    }

    if (msg.type === 'setup_clear_all') {
      // Clear all lines on all walls with a fade-out signal
      for (const [wid, wall] of Object.entries(walls)) {
        wall.lines = [];
        broadcastRenderers(wid, { type: 'clear_all' });
      }
      broadcastSound({ type: 'clear_all' });
      broadcastSetup(getStatusSnapshot());
      return;
    }

    // ── Renderer ──
    if (msg.type === 'renderer_join') {
      const wallId = msg.wallId;
      const wall = getOrCreateWall(wallId);
      assignedWallId = wallId;
      isRenderer = true;
      wall.renderers.add(ws);

      const activeArr = [];
      for (const [uid, u] of wall.activeUsers) {
        if (!u.isRenderer && u.lineData) activeArr.push({ userId: uid, line: u.lineData });
      }
      ws.send(JSON.stringify({
        type: 'full_state',
        activeUsers: activeArr,
        savedLines:  wall.lines,
        settings:    globalSettings,
      }));
      broadcastSetup(getStatusSnapshot());
      return;
    }

    // ── Mobile app ──
    if (msg.type === 'join') {
      const { wallId, userId } = msg;
      const wall = getOrCreateWall(wallId);
      assignedWallId = wallId;
      assignedUserId = userId;

      if (wall.activeUsers.size < MAX_ACTIVE_USERS) {
        const sessionId = uuidv4();
        wall.activeUsers.set(userId, { ws, lineData: null, sessionId, isRenderer: false });
        ws.send(JSON.stringify({ type: 'active', sessionId, activeCount: wall.activeUsers.size, settings: globalSettings }));
        broadcastRenderers(wallId, { type: 'user_joined', userId, activeCount: wall.activeUsers.size });
      } else {
        wall.queue.push({ userId, ws });
        ws.send(JSON.stringify({ type: 'queued', position: wall.queue.length }));
      }
      broadcastSetup(getStatusSnapshot());
      return;
    }

    if (msg.type === 'update') {
      const { wallId, userId, line } = msg;
      const wall = walls[wallId];
      if (!wall) return;
      const user = wall.activeUsers.get(userId);
      if (!user) return;
      user.lineData = line;
      broadcastRenderers(wallId, { type: 'user_update', userId, line });
      broadcastSound({ type: 'user_update', userId: wallId + '_' + userId, line });
      return;
    }

    if (msg.type === 'save') {
      const { wallId, userId, line } = msg;
      const wall = walls[wallId];
      if (!wall) return;
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

    if (isRenderer) {
      wall.renderers.delete(ws);
      broadcastSetup(getStatusSnapshot());
      return;
    }

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
  console.log(`   Setup:    http://localhost:${PORT}/setup.html`);
  console.log(`   Renderer: http://localhost:${PORT}/renderer.html?wall=WALL_ID`);
  console.log(`   Mobile:   http://localhost:${PORT}/app.html?wall=WALL_ID\n`);
});
