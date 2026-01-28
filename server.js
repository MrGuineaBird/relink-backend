// server.js
// TEST UPDATE
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const fs = require("fs/promises");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// --- File paths ---
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const DMS_FILE = path.join(DATA_DIR, "dms.json");

// --- File helpers ---
async function readJSON(file) {
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeJSON(file, obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

// --- Main async function ---
async function main() {
  // --- Load data ---
  let users = await readJSON(USERS_FILE);
  let sessions = await readJSON(SESSIONS_FILE);
  let servers = await readJSON(SERVERS_FILE);
  let dms = await readJSON(DMS_FILE);

  // Ensure all servers have channels.general, members, bans
  for (const sid in servers) {
    if (!servers[sid].channels) servers[sid].channels = { general: [] };
    else if (!servers[sid].channels.general) servers[sid].channels.general = [];
    if (!servers[sid].members) servers[sid].members = [];
    if (!servers[sid].bans) servers[sid].bans = [];
  }

  // --- Helpers ---
  function genInvite(len = 6) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function dmKey(a, b) {
    return [a, b].sort().join(":");
  }

  // --- Auth routes ---
  app.post("/signup", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "username & password required" });
    if (users[username]) return res.status(409).json({ error: "username exists" });
    users[username] = { password, id: uuidv4() };
    await writeJSON(USERS_FILE, users);
    res.json({ ok: true });
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const u = users[username];
    if (!u || u.password !== password) return res.status(401).json({ error: "invalid credentials" });
    const token = uuidv4();
    sessions[token] = username;
    await writeJSON(SESSIONS_FILE, sessions);
    res.json({ token, username });
  });

  app.get("/session/:token", (req, res) => {
    const username = sessions[req.params.token];
    if (!username) return res.status(401).json({ error: "invalid session" });
    res.json({ username });
  });

  // --- Server management ---
  app.post("/server", async (req, res) => {
    const { name, token } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuidv4();
    const invite = genInvite(8);
    const username = token && sessions[token];
    servers[id] = {
      id,
      name,
      invite,
      owner: username || null,
      channels: { general: [] }, // always default
      members: username ? [username] : [],
      bans: []
    };
    await writeJSON(SERVERS_FILE, servers);
    res.json({ id, name, invite });
  });

  app.post("/join/:invite", async (req, res) => {
    const { invite } = req.params;
    const { token } = req.body;
    const username = token && sessions[token];
    if (!username) return res.status(401).json({ error: "invalid session/token" });
    const sid = Object.keys(servers).find(s => servers[s].invite === invite);
    if (!sid) return res.status(404).json({ error: "invite not found" });
    if (servers[sid].bans.includes(username)) return res.status(403).json({ error: "you are banned" });
    if (!servers[sid].members.includes(username)) servers[sid].members.push(username);
    await writeJSON(SERVERS_FILE, servers);
    res.json({ ok: true, serverId: sid, name: servers[sid].name });
  });

  app.get("/servers", (req, res) => {
    const token = req.query.token;
    const username = token && sessions[token];
    if (!username) return res.status(401).json({ error: "invalid session/token" });
    const mine = Object.values(servers)
      .filter(s => s.members.includes(username))
      .map(s => ({ id: s.id, name: s.name }));
    res.json(mine);
  });

  app.get("/channels/:serverId", (req, res) => {
    const sid = req.params.serverId;
    if (!servers[sid]) return res.status(404).json({ error: "server not found" });
    if (!servers[sid].channels) servers[sid].channels = { general: [] }; // ensure default
    res.json(Object.keys(servers[sid].channels));
  });

  app.post("/channels/:serverId", async (req, res) => {
    const sid = req.params.serverId;
    const { name } = req.body;
    if (!servers[sid]) return res.status(404).json({ error: "server not found" });
    if (!name) return res.status(400).json({ error: "name required" });
    if (!servers[sid].channels) servers[sid].channels = { general: [] };
    if (servers[sid].channels[name]) return res.status(409).json({ error: "channel exists" });
    servers[sid].channels[name] = [];
    await writeJSON(SERVERS_FILE, servers);
    res.json({ ok: true, channel: name });
  });

  app.get("/history/:serverId/:channel", (req, res) => {
    const { serverId, channel } = req.params;
    if (!servers[serverId]) return res.status(404).json({ error: "server not found" });
    if (!servers[serverId].channels[channel]) return res.status(404).json({ error: "channel not found" });
    res.json(servers[serverId].channels[channel].slice(-200));
  });

  // --- DMs ---
  app.get("/dms", (req, res) => {
    const token = req.query.token;
    const username = token && sessions[token];
    if (!username) return res.status(401).json({ error: "invalid session" });
    const partners = Object.keys(dms)
      .filter(k => k.includes(username))
      .map(k => k.split(":").find(u => u !== username));
    res.json(partners);
  });

  app.get("/dm/:target", (req, res) => {
    const token = req.query.token;
    const username = token && sessions[token];
    if (!username) return res.status(401).json({ error: "invalid session" });
    const key = dmKey(username, req.params.target);
    res.json(dms[key] || []);
  });

  app.post("/dm/:target", async (req, res) => {
    const { token, text } = req.body;
    const username = token && sessions[token];
    if (!username) return res.status(401).json({ error: "invalid session" });
    const target = req.params.target;
    const key = dmKey(username, target);
    if (!dms[key]) dms[key] = [];
    const msg = { id: uuidv4(), from: username, to: target, text, ts: Date.now() };
    dms[key].push(msg);
    await writeJSON(DMS_FILE, dms);

    wss.clients.forEach(c => {
      if (c.readyState === 1 && (c.username === username || c.username === target)) {
        c.send(JSON.stringify({ type: "dm", message: msg }));
      }
    });
    res.json({ ok: true, message: msg });
  });

  // --- Start server + WebSocket ---
  const server = app.listen(PORT, () => console.log(`RELINK backend on port ${PORT}`));
  const wss = new WebSocket.Server({ server });

  function broadcast(obj, serverId = null, channel = null) {
    const raw = JSON.stringify(obj);
    wss.clients.forEach(c => {
      if (c.readyState !== WebSocket.OPEN) return;
      if (serverId && c.serverId !== serverId) return;
      if (channel && c.channel !== channel) return;
      c.send(raw);
    });
  }

  wss.on("connection", ws => {
    ws.isAlive = true;
    ws.on("pong", () => ws.isAlive = true);

    ws.on("message", async raw => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      if (data.type === "joinServer") {
        const { token, serverId, channel } = data;
        const username = token && sessions[token];
        if (!username || !servers[serverId] || !servers[serverId].members.includes(username)) {
          ws.send(JSON.stringify({ type: "error", error: "invalid token or not member" }));
          return;
        }
        if (servers[serverId].bans.includes(username)) {
          ws.send(JSON.stringify({ type: "error", error: "banned" }));
          return;
        }
        ws.username = username;
        ws.serverId = serverId;
        ws.channel = channel || "general";

        const usersList = Array.from(new Set(
          Array.from(wss.clients)
            .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
            .map(c => c.username)
            .filter(Boolean)
        ));
        broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users: usersList }, ws.serverId, ws.channel);
        return;
      }

      if (data.type === "switch") {
        ws.channel = data.channel;
        if (!ws.serverId) return;
        const usersList = Array.from(new Set(
          Array.from(wss.clients)
            .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
            .map(c => c.username)
            .filter(Boolean)
        ));
        broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users: usersList }, ws.serverId, ws.channel);
        return;
      }

      if (data.type === "message") {
        if (!ws.serverId) return;
        const username = ws.username || (data.token && sessions[data.token]) || "anonymous";
        const serverId = ws.serverId;
        const channel = ws.channel || data.channel || "general";

        if (!servers[serverId] || !servers[serverId].channels[channel]) {
          ws.send(JSON.stringify({ type: "error", error: "channel not found" }));
          return;
        }

        const msg = { id: uuidv4(), username, text: data.text, ts: Date.now(), serverId, channel };
        servers[serverId].channels[channel].push(msg);
        await writeJSON(SERVERS_FILE, servers);
        broadcast({ type: "message", message: msg }, serverId, channel);
        return;
      }

      if (data.type === "dm") {
        const { to, text, token } = data;
        const from = token && sessions[token];
        if (!from) return;

        const key = dmKey(from, to);
        if (!dms[key]) dms[key] = [];
        const msg = { id: uuidv4(), from, to, text, ts: Date.now() };
        dms[key].push(msg);
        await writeJSON(DMS_FILE, dms);

        wss.clients.forEach(c => {
          if (c.readyState === 1 && (c.username === from || c.username === to)) {
            c.send(JSON.stringify({ type: "dm", message: msg }));
          }
        });
        return;
      }
    });

    ws.on("close", () => {
      if (!ws.serverId || !ws.channel) return;
      const usersList = Array.from(new Set(
        Array.from(wss.clients)
          .filter(c => c.serverId === ws.serverId && c.channel === ws.channel)
          .map(c => c.username)
          .filter(Boolean)
      ));
      broadcast({ type: "presence", serverId: ws.serverId, channel: ws.channel, users: usersList }, ws.serverId, ws.channel);
    });
  });

  setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
}

// --- Run main ---
main().catch(err => console.error(err));

