"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MAX_STROKES = 5000;        // per room
const MAX_POINTS = 3000;         // per stroke (x,y pairs flattened)
const MAX_MSG_BYTES = 64 * 1024;
const PALETTE = ["#3a5bff", "#ff5a4e", "#1fa67a", "#d98e00", "#8a5cf6", "#e0449b", "#0e8fc4", "#c2410c"];

// ---- static files ---------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }   // block path traversal
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---- rooms ----------------------------------------------------------------
/** room name -> { strokes: Map<id, stroke>, clients: Set<ws> } */
const rooms = new Map();
function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { strokes: new Map(), clients: new Set() });
  return rooms.get(name);
}
function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(data);
}
const peerList = (room) => [...room.clients].map((c) => ({ id: c.id, color: c.color, nick: c.nick, x: c.x, y: c.y }));

// ---- validation: never trust the client -----------------------------------
const num = (n) => typeof n === "number" && Number.isFinite(n);
function cleanStroke(s) {
  if (!s || typeof s.id !== "string" || s.id.length > 40) return null;
  if (!Array.isArray(s.pts) || s.pts.length < 2 || s.pts.length > MAX_POINTS || !s.pts.every(num)) return null;
  return {
    id: s.id,
    pts: s.pts.map((n) => Math.round(n)),
    c: typeof s.c === "string" && s.c.length <= 9 ? s.c : "ink",
    w: Math.min(30, Math.max(1, +s.w || 4)),
    t: num(s.t) ? s.t : Date.now(),
    by: typeof s.by === "string" ? s.by.slice(0, 40) : "",
  };
}

// ---- websocket ------------------------------------------------------------
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });
let nextId = 1;

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const roomName = (url.searchParams.get("room") || "lobby").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "lobby";
  const room = getRoom(roomName);

  ws.id = "u" + nextId++;
  ws.color = PALETTE[(nextId - 1) % PALETTE.length];
  ws.nick = "Guest " + (100 + Math.floor(Math.random() * 900));
  ws.x = null; ws.y = null; ws.alive = true;
  ws.tokens = 120; // simple token-bucket rate limit
  room.clients.add(ws);

  ws.send(JSON.stringify({ type: "init", me: ws.id, room: roomName, strokes: [...room.strokes.values()], peers: peerList(room) }));
  broadcast(room, { type: "peers", peers: peerList(room) });

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", (raw) => {
    if (--ws.tokens < 0) return;                       // drop floods
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "hello":
        if (typeof m.nick === "string") ws.nick = m.nick.trim().slice(0, 24) || ws.nick;
        broadcast(room, { type: "peers", peers: peerList(room) });
        break;
      case "cursor":
        ws.x = num(m.x) ? m.x : null; ws.y = num(m.y) ? m.y : null;
        broadcast(room, { type: "cursor", id: ws.id, x: ws.x, y: ws.y }, ws);
        break;
      case "live": {                                    // in-progress stroke segment, not stored
        if (!Array.isArray(m.pts) || m.pts.length > 400 || !m.pts.every(num)) return;
        broadcast(room, { type: "live", id: ws.id, sid: String(m.sid).slice(0, 40), c: m.c, w: m.w, pts: m.pts }, ws);
        break;
      }
      case "stroke": {                                  // committed stroke, stored and relayed
        const s = cleanStroke(m.stroke); if (!s) return;
        if (room.strokes.size >= MAX_STROKES) return;
        room.strokes.set(s.id, s);
        broadcast(room, { type: "stroke", stroke: s }, ws);
        break;
      }
      case "remove":
        if (typeof m.id === "string" && room.strokes.delete(m.id)) broadcast(room, { type: "remove", id: m.id }, ws);
        break;
      case "clear":
        room.strokes.clear(); broadcast(room, { type: "clear" }, ws);
        break;
    }
  });
  ws.on("close", () => {
    room.clients.delete(ws);
    if (!room.clients.size && !room.strokes.size) rooms.delete(roomName);
    else broadcast(room, { type: "peers", peers: peerList(room) });
  });
});

// refill rate-limit tokens every second (about 60 messages/sec per client)
setInterval(() => { for (const ws of wss.clients) ws.tokens = Math.min(120, ws.tokens + 60); }, 1000);

// heartbeat: drop connections that stop answering pings
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`Sketchroom running on http://localhost:${PORT}`));
