const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const players = new Map();
const matches = new Map();
let waiting = null;
let seq = 1;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function sendJson(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
  });
}

function createPlayer() {
  const player = {id: id('p'), matchId: null, side: 'spectator', events: [], createdAt: Date.now(), lastSeen: Date.now()};
  players.set(player.id, player);
  return player;
}

function matchPlayers(a, b) {
  const matchId = id('m');
  a.matchId = matchId; a.side = 'blue';
  b.matchId = matchId; b.side = 'red';
  matches.set(matchId, {id: matchId, players: [a.id, b.id], createdAt: Date.now()});
  a.events.push({seq: seq++, msg: {kind: 'matched', side: a.side, matchId}});
  b.events.push({seq: seq++, msg: {kind: 'matched', side: b.side, matchId}});
}

function opponentOf(player) {
  const match = matches.get(player.matchId);
  if (!match) return null;
  const otherId = match.players.find(id => id !== player.id);
  return players.get(otherId) || null;
}

function cleanup() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [playerId, player] of players) {
    if (player.lastSeen >= cutoff) continue;
    if (waiting === playerId) waiting = null;
    players.delete(playerId);
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/random/join') {
    const player = createPlayer();
    if (waiting && players.has(waiting)) {
      const first = players.get(waiting);
      waiting = null;
      matchPlayers(first, player);
      return sendJson(res, 200, {status: 'matched', playerId: player.id, matchId: player.matchId, side: player.side});
    }
    waiting = player.id;
    return sendJson(res, 200, {status: 'waiting', playerId: player.id});
  }

  if (req.method === 'GET' && url.pathname === '/api/random/poll') {
    const player = players.get(url.searchParams.get('playerId'));
    if (!player) return sendJson(res, 404, {error: 'player not found'});
    player.lastSeen = Date.now();
    const after = Number(url.searchParams.get('after') || 0);
    const events = player.events.filter(event => event.seq > after);
    return sendJson(res, 200, {
      status: player.matchId ? 'matched' : 'waiting',
      playerId: player.id,
      matchId: player.matchId,
      side: player.side,
      events,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/random/send') {
    const body = await readJson(req);
    const player = players.get(body.playerId);
    if (!player || !player.matchId) return sendJson(res, 404, {error: 'match not found'});
    player.lastSeen = Date.now();
    const other = opponentOf(player);
    if (!other) return sendJson(res, 404, {error: 'opponent not found'});
    other.events.push({seq: seq++, msg: body.msg});
    return sendJson(res, 200, {ok: true});
  }

  sendJson(res, 404, {error: 'not found'});
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'});
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  cleanup();
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    sendJson(res, 500, {error: 'server error'});
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Chesscard random match server listening on ${HOST}:${PORT}`);
});
