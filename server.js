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

      console.log(`[→] control from ${clientId}: px=${msg.px?.toFixed(2)} py=${msg.py?.toFixed(2)} size=${msg.size?.toFixed(2)} h=${msg.color_h?.toFixed(2)} s=${msg.color_s?.toFixed(2)} v=${msg.color_v?.toFixed(2)}`);
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

console.log(`✦ Server running on port ${PORT} — broadcasting to all clients`);
