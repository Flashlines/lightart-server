const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map(); // clientId → { ws, isTD }
let clientCounter = 0;

wss.on("connection", (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, { ws, isTD: false });

  console.log(`[+] New connection: ${clientId} (total: ${clients.size})`);

  // Send init to everyone – TD will identify itself back
  ws.send(JSON.stringify({ type: "init", clientId, clientCount: clients.size }));
  broadcastCount();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // TD registers itself
    if (msg.type === "register" && msg.role === "touchdesigner") {
      const entry = clients.get(clientId);
      if (entry) entry.isTD = true;
      console.log(`[TD] TouchDesigner registered: ${clientId}`);
      ws.send(JSON.stringify({ type: "registered", clientId }));
      broadcastCount();
      return;
    }

    // Control message from browser → forward to all TDs
    if (msg.type === "control") {
      msg.clientId = clientId;
      msg.timestamp = Date.now();
      let forwarded = 0;
      clients.forEach(({ ws: targetWs, isTD }) => {
        if (isTD && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify(msg));
          forwarded++;
        }
      });
      console.log(`[→] Control from ${clientId} forwarded to ${forwarded} TD(s)`);
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[-] Disconnected: ${clientId} (remaining: ${clients.size})`);
    broadcastCount();
  });

  ws.on("error", (err) => {
    console.error(`[!] Error on ${clientId}:`, err.message);
  });
});

function broadcastCount() {
  const browserCount = [...clients.values()].filter(c => !c.isTD).length;
  const msg = JSON.stringify({ type: "clientCount", count: browserCount });
  clients.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

console.log(`✦ WebSocket server running on port ${PORT}`);
