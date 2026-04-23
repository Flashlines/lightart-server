const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();
let clientCounter = 0;

wss.on("connection", (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, ws);

  console.log(`[+] Connected: ${clientId} (total: ${clients.size})`);

  ws.send(JSON.stringify({ type: "init", clientId, clientCount: clients.size }));

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

      console.log(`[→] control from ${clientId}: hue=${Math.round(msg.hue)}° x=${msg.x?.toFixed(2)} y=${msg.y?.toFixed(2)} spd=${msg.speed?.toFixed(2)}`);
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[-] Disconnected: ${clientId} (remaining: ${clients.size})`);
    // Broadcast updated count
    const msg = JSON.stringify({ type: "clientCount", count: clients.size });
    clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  });

  ws.on("error", (err) => console.error(`[!] ${clientId}:`, err.message));
});

console.log(`✦ Server running on port ${PORT} — broadcasting to all clients`);
