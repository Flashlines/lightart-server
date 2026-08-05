const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();
let clientCounter = 0;

// Latest interaction-gating state sent by TouchDesigner, re-sent to every
// newly connecting phone so it reflects the current state immediately
// instead of waiting for the next change.
let sessionState = { type: "session", active: true, message: "" };

wss.on("connection", (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, ws);

  // Heartbeat: marks the socket alive on every pong reply. Combined with
  // the ping interval below, this both keeps the connection alive through
  // proxies that drop idle sockets (e.g. Railway) and lets us detect and
  // drop connections that silently died without a proper close handshake.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  console.log(`[+] Connected: ${clientId} (total: ${clients.size})`);

  ws.send(JSON.stringify({ type: "init", clientId, clientCount: clients.size }));
  ws.send(JSON.stringify(sessionState));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "control") {
      msg.clientId = clientId;
      msg.timestamp = Date.now();

      // Broadcast to ALL other clients (including TouchDesigner)
      clients.forEach((targetWs, targetId) => {
        if (targetId !== clientId && targetWs.readyState === WebSocket.OPEN) {
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
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[-] Disconnected: ${clientId} (remaining: ${clients.size})`);

    // Tell everyone (including TouchDesigner) which client left, so it can
    // be pruned from any per-instance table/CHOP.
    const leaveMsg = JSON.stringify({ type: "leave", clientId, timestamp: Date.now() });
    const countMsg = JSON.stringify({ type: "clientCount", count: clients.size });
    clients.forEach((targetWs) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(leaveMsg);
        targetWs.send(countMsg);
      }
    });
  });

  ws.on("error", (err) => console.error(`[!] ${clientId}:`, err.message));
});

// Every 25s, ping all clients. Any client that didn't pong since the last
// ping is considered dead and gets terminated (which fires its "close"
// handler above, so it's cleaned up and broadcast as "leave" normally).
const HEARTBEAT_INTERVAL_MS = 25000;
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[!] Terminating unresponsive connection");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

console.log(`✦ Server running on port ${PORT} — broadcasting to all clients`);
