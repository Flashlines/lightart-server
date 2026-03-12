const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Track clients: { ws, id, type }
const clients = new Map();
let clientCounter = 0;

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  clients.forEach(({ ws }) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

wss.on("connection", (ws, req) => {
  const clientId = `client_${++clientCounter}`;
  const isTD = req.url?.includes("touchdesigner");
  clients.set(clientId, { ws, id: clientId, isTD });

  console.log(`[+] ${isTD ? "TouchDesigner" : "Browser"} connected: ${clientId} (total: ${clients.size})`);

  // Send assigned ID to browser client
  if (!isTD) {
    ws.send(JSON.stringify({ type: "init", clientId, clientCount: clients.size }));
    // Notify all about new visitor count
    broadcast({ type: "clientCount", count: [...clients.values()].filter(c => !c.isTD).length });
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Attach sender ID and forward
    msg.clientId = clientId;
    msg.timestamp = Date.now();

    // Forward to TouchDesigner instances
    clients.forEach(({ ws: targetWs, isTD: targetIsTD }) => {
      if (targetIsTD && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(msg));
      }
    });

    // Echo back to all browsers for collaborative awareness (optional)
    // broadcast(msg, ws);
  });

  ws.on("close", () => {
    clients.delete(clientId);
    const browserCount = [...clients.values()].filter(c => !c.isTD).length;
    console.log(`[-] Disconnected: ${clientId} (remaining: ${clients.size})`);
    broadcast({ type: "clientCount", count: browserCount });
  });

  ws.on("error", (err) => {
    console.error(`[!] Error on ${clientId}:`, err.message);
  });
});

console.log(`✦ WebSocket server running on port ${PORT}`);
console.log(`  Browser clients → ws://localhost:${PORT}`);
console.log(`  TouchDesigner   → ws://localhost:${PORT}?touchdesigner`);
