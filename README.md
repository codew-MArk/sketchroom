# Sketchroom

A real-time collaborative whiteboard. Open the same room in two browsers and draw: lines, cursors and presence sync live over WebSockets.

**Live demo:** _add your deployed link here_

## Features
- Live drawing: in-progress strokes stream to everyone as you draw, and commit when you lift the pen
- Multiplayer cursors with names and colors, and a presence list
- Rooms via URL: `/?room=standup` gives that group their own private board
- Eraser (click a line), undo your last line, clear board, export PNG
- Automatic reconnect with exponential backoff, and a full state resync on reconnect

## Architecture
```
Browser  <--WebSocket-->  Node server  (rooms: Map<name, {strokes, clients}>)
```
| Message | Direction | Stored? | Purpose |
|---|---|---|---|
| `live` | client -> others | no | in-progress stroke segments, throttled to about 14/s |
| `stroke` | client -> server -> others | yes | committed stroke |
| `cursor` | client -> others | no | pointer position, throttled to about 20/s |
| `remove` / `clear` | client -> server -> others | yes | delete strokes |

Design decisions
- **Two-tier sync.** Ephemeral data (cursors, live segments) is relayed and never stored. Durable data (committed strokes) lives in the room state, so late joiners get a full snapshot on connect.
- **Strokes are immutable, keyed by ID.** Concurrent edits cannot conflict: adds, and deletes by ID, commute. This avoids needing CRDTs or operational transforms for a drawing app.
- **Logical coordinate space (1600x1000).** Every client scales to its own screen, so a phone and a monitor see the same drawing.
- **Server never trusts the client.** Payload size cap, point-count cap, numeric validation, per-room stroke cap, token-bucket rate limit, and path-traversal protection on static files.
- **Heartbeat.** Ping/pong every 15s terminates dead sockets so presence stays accurate.

## Run locally
```bash
npm install
npm start          # http://localhost:3000
```
Open `http://localhost:3000/?room=demo` in two tabs.

## Deploy
Any Node host that supports WebSockets works (Render, Railway, Fly.io). Build command `npm install`, start command `npm start`. The `PORT` env var is respected.

## Known limits and next steps
- Room state is in memory, so it resets on restart. Next: persist to Redis or SQLite.
- One server instance. To scale horizontally, add Redis pub/sub so rooms span instances.
- No auth. Next: signed room tokens and read-only viewers.
- Next: shapes, text, infinite canvas, and an operation log for full undo/redo.
