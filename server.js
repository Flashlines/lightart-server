const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();
let clientCounter = 0;

// clientId -> "td" | "phone" (default). Set by an explicit {type:"hello",
// role:"td"} message sent once from ws_callbacks.py's onConnect. Used to
// avoid broadcasting per-frame control data to every connected phone (only
// TouchDesigner needs it) - see the 2026-08 incident where an unbounded
// number of active phones each fanned their control stream out to every
// other phone, overloading both this process and TD's single-threaded
// message handling.
const roles = new Map();

// Latest interaction-gating state sent by TouchDesigner, re-sent to every
// newly connecting phone so it reflects the current state immediately
// instead of waiting for the next change.
let sessionState = { type: "session", active: true, message: "" };

// ─── CAPACITY / QUEUE ──────────────────────────────────────────
// Default cap so an event that forgets to call set_max_users() fails safe
// instead of letting every connecting phone become an active slot (root
// cause of the 2026-08 freeze). Raise via set_max_users(n), or explicitly
// set_max_users(0) to opt back into unlimited.
let maxActiveUsers = 50;
const activeClients = new Map(); // clientId -> activatedAt (ms)
const queue = []; // clientId[], FIFO

const TURN_DURATION_MS = 30000; // max time in an active slot once someone is waiting
const ROTATION_TICK_MS = 1000;

function oldestActiveClientId() {
  let oldest = null;
  let oldestTime = Infinity;
  for (const [id, t] of activeClients) {
    if (roles.get(id) === "td") continue; // TD is never a rotation candidate
    if (t < oldestTime) { oldest = id; oldestTime = t; }
  }
  return oldest;
}

// "leave" (like "control") is only consumed by TouchDesigner (to prune
// ws_instances) - phones have no handler for it, so broadcasting it to
// every connected phone was pure wasted fan-out.
function broadcastLeave(clientId) {
  const leaveMsg = JSON.stringify({ type: "leave", clientId, timestamp: Date.now() });
  clients.forEach((targetWs, targetId) => {
    if (roles.get(targetId) === "td" && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(leaveMsg);
    }
  });
}

function broadcastClientCount() {
  const countMsg = JSON.stringify({ type: "clientCount", count: clients.size });
  clients.forEach((targetWs) => {
    if (targetWs.readyState === WebSocket.OPEN) targetWs.send(countMsg);
  });
}

// Tells a single client whether it currently holds an active slot (and how
// long it has left, if anyone is waiting) or is queued (and at what
// position).
function sendTurnState(clientId) {
  const ws = clients.get(clientId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (activeClients.has(clientId)) {
    const activatedAt = activeClients.get(clientId);
    const remainingMs = queue.length > 0
      ? Math.max(0, TURN_DURATION_MS - (Date.now() - activatedAt))
      : null; // no one waiting -> no countdown pressure
    ws.send(JSON.stringify({ type: "turn", active: true, remainingMs }));
  } else {
    const position = queue.indexOf(clientId) + 1; // 1-based
    ws.send(JSON.stringify({ type: "turn", active: false, position, queueLength: queue.length }));
  }
}

// Demotes a client that has been evicted (either its 30s turn ran out, or
// maxActiveUsers shrank below the current active count): drops it from
// ws_instances (via a normal "leave") and, if still connected, sends it to
// the back of the queue.
function demote(clientId) {
  if (!activeClients.delete(clientId)) return;
  broadcastLeave(clientId);
  const ws = clients.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    queue.push(clientId);
    sendTurnState(clientId);
  }
}

function promote(clientId) {
  activeClients.set(clientId, Date.now());
  sendTurnState(clientId);
}

// Single source of truth: brings activeClients/queue back in line with
// maxActiveUsers. Call after anything that could free or shrink capacity
// (connect, disconnect, config change, rotation tick).
function rebalance() {
  while (activeClients.size > maxActiveUsers) {
    demote(oldestActiveClientId());
  }
  while (activeClients.size < maxActiveUsers && queue.length > 0) {
    promote(queue.shift());
  }
  if (queue.length === 0) {
    // Queue just drained (or was already empty) - make sure any client
    // still showing a countdown from a moment ago gets it cleared.
    for (const clientId of activeClients.keys()) sendTurnState(clientId);
  }
}

wss.on("connection", (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, ws);

  console.log(`[+] Connected: ${clientId} (total: ${clients.size})`);

  if (activeClients.size < maxActiveUsers) {
    activeClients.set(clientId, Date.now());
  } else {
    queue.push(clientId);
  }

  ws.send(JSON.stringify({ type: "init", clientId, clientCount: clients.size }));
  ws.send(JSON.stringify(sessionState));
  sendTurnState(clientId);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello") {
      // Sent once by ws_callbacks.py's onConnect to identify the
      // TouchDesigner connection, so control/leave fan-out can target it
      // specifically instead of every connected phone.
      if (msg.role === "td") {
        roles.set(clientId, "td");
        // TD is a consumer, not a controllable slot - keep it out of the
        // capacity/queue accounting entirely so a full house of phones can
        // never rotate TD itself into the queue and silently break
        // interaction gating for everyone.
        activeClients.delete(clientId);
        const qIdx = queue.indexOf(clientId);
        if (qIdx !== -1) queue.splice(qIdx, 1);
        rebalance();
        console.log(`[TD] ${clientId} identified as TouchDesigner`);
      }
      return;
    }

    if (msg.type === "control") {
      if (!activeClients.has(clientId)) return; // queued clients can't push state

      msg.clientId = clientId;
      msg.timestamp = Date.now();

      // Only TouchDesigner consumes control data - broadcasting it to
      // every other phone too (as this used to do) turned each incoming
      // message into O(clients) outgoing sends, which is what overloaded
      // the server and TD's message handling once enough phones connected.
      clients.forEach((targetWs, targetId) => {
        if (targetId !== clientId && roles.get(targetId) === "td" && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify(msg));
        }
      });

      console.log(`[→] control from ${clientId}: px=${msg.px?.toFixed(2)} py=${msg.py?.toFixed(2)} size=${msg.size?.toFixed(2)} h=${msg.color_h?.toFixed(2)} s=${msg.color_s?.toFixed(2)} v=${msg.color_v?.toFixed(2)}`);
    }

    if (msg.type === "session") {
      // Sent by TouchDesigner to gate interaction and show/update the
      // overlay text on all phones, e.g. between show segments.
      sessionState = {
        type: "session",
        active: !!msg.active,
        message: typeof msg.message === "string" ? msg.message : "",
      };
      console.log(`[TD] session from ${clientId}: active=${sessionState.active} message="${sessionState.message}"`);

      clients.forEach((targetWs, targetId) => {
        if (targetId !== clientId && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify(sessionState));
        }
      });
    }

    if (msg.type === "config" && msg.maxUsers !== undefined) {
      // Sent by TouchDesigner via set_max_users(). 0/empty = unlimited.
      const n = parseInt(msg.maxUsers, 10);
      maxActiveUsers = Number.isFinite(n) && n > 0 ? n : Infinity;
      console.log(`[TD] maxUsers -> ${maxActiveUsers === Infinity ? "unbegrenzt" : maxActiveUsers}`);
      rebalance();
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    roles.delete(clientId);
    const wasActive = activeClients.delete(clientId);
    const qIdx = queue.indexOf(clientId);
    if (qIdx !== -1) queue.splice(qIdx, 1);

    console.log(`[-] Disconnected: ${clientId} (remaining: ${clients.size})`);

    // Tell everyone (including TouchDesigner) which client left, so it can
    // be pruned from any per-instance table/CHOP.
    broadcastLeave(clientId);
    broadcastClientCount();

    if (wasActive) rebalance(); // free slot -> promote next in queue
  });

  ws.on("error", (err) => console.error(`[!] ${clientId}:`, err.message));
});

// Every 1s while someone is waiting: evict active clients whose 30s turn is
// up (freeing their slot for the queue) and push updated countdowns /
// queue positions to everyone affected. Entirely inert (no work, no
// traffic) as long as nobody is queued.
setInterval(() => {
  if (queue.length === 0) return;

  const now = Date.now();
  for (const [clientId, activatedAt] of [...activeClients.entries()]) {
    if (now - activatedAt >= TURN_DURATION_MS) demote(clientId);
  }
  rebalance();

  for (const clientId of activeClients.keys()) sendTurnState(clientId);
  for (const clientId of queue) sendTurnState(clientId);
}, ROTATION_TICK_MS);

// Every 25s, send a harmless text keepalive to every client. This is an
// application-level heartbeat (not the low-level WS ping/pong control
// frame) on purpose: TouchDesigner's WebSocket DAT does not reply to
// protocol-level pings, and terminating it for "not ponging" caused an
// endless connect/disconnect loop. Clients that don't recognize the
// "ping" type simply ignore it (see onReceiveText / ws.onmessage).
const HEARTBEAT_INTERVAL_MS = 25000;
const heartbeat = setInterval(() => {
  const msg = JSON.stringify({ type: "ping" });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

console.log(`✦ Server running on port ${PORT} — control/leave routed to TD only`);
