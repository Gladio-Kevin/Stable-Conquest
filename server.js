const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const COLS = ['#3d9bff', '#ff5a6e', '#3fdc8e', '#ffb52e', '#b57bff', '#ff7bd5'];
const BAD = /(amk|aq|orospu|pi[cç]|siktir|sikeyim|yarra[kg]|ibne|amına|amina|götveren)/gi;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = s => esc(String(s).replace(BAD, '***'));

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    if (e) { res.writeHead(500); return res.end('index.html bulunamadi'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextPid = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const genId = () => { let s; do { s = String(1000000 + Math.floor(Math.random() * 9000000)); } while (rooms.has(s)); return s; };
const freeCol = r => COLS.find(c => !r.players.some(p => p.c === c));
const snap = (r, ws) => ({
  t: 'room', id: r.id, name: r.name, max: r.max, host: ws.pid === r.hostPid, me: ws.pid,
  players: r.players.map(p => ({ pid: p.pid, n: p.n, c: p.c, host: p.pid === r.hostPid })),
  history: r.hist.slice(-30)
});
const bcast = r => r.players.forEach(p => send(p.ws, snap(r, p.ws)));
function sys(r, t) { r.hist.push('<i>' + t + '</i>'); r.players.forEach(p => send(p.ws, { t: 'sys', text: t })); }
function chat(r, n, text) { r.hist.push('<b>' + n + ':</b> ' + text); r.players.forEach(p => send(p.ws, { t: 'chat', n, text })); }

function leaveRoom(ws) {
  const r = ws.room; if (!r) return;
  ws.room = null;
  const i = r.players.findIndex(p => p.ws === ws); if (i < 0) return;
  const p = r.players.splice(i, 1)[0];
  if (!r.players.length) { rooms.delete(r.id); return; }
  if (p.pid === r.hostPid) { r.hostPid = r.players[0].pid; sys(r, r.players[0].n + ' artık oda sahibi'); }
  sys(r, p.n + ' odadan ayrıldı');
  bcast(r);
}

wss.on('connection', ws => {
  ws.pid = nextPid++; ws.room = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const r = ws.room;

    if (m.t === 'create') {
      leaveRoom(ws);
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      const rn = clean(String(m.room || '').slice(0, 16)) || 'Oda';
      const max = Math.min(4, Math.max(2, parseInt(m.max) || 2));
      const nr = { id: genId(), name: rn, max, hostPid: ws.pid, players: [], hist: [] };
      nr.players.push({ pid: ws.pid, ws, n: name, c: COLS.includes(m.c) ? m.c : COLS[0] });
      rooms.set(nr.id, nr); ws.room = nr;
      sys(nr, name + ' odayı kurdu');
      bcast(nr);
    }
    else if (m.t === 'join') {
      const jr = rooms.get(String(m.id));
      if (!jr) return send(ws, { t: 'err', text: 'Oda bulunamadı!' });
      if (jr.players.length >= jr.max) return send(ws, { t: 'err', text: 'Oda dolu!' });
      leaveRoom(ws);
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      let c = COLS.includes(m.c) ? m.c : COLS[0];
      if (jr.players.some(p => p.c === c)) c = freeCol(jr);
      jr.players.push({ pid: ws.pid, ws, n: name, c }); ws.room = jr;
      sys(jr, name + ' odaya katıldı');
      bcast(jr);
    }
    else if (!r) return;
    else if (m.t === 'chat') {
      const p = r.players.find(x => x.ws === ws);
      const text = clean(String(m.text || '').slice(0, 80)).trim();
      if (p && text) chat(r, p.n, text);
    }
    else if (m.t === 'color') {
      const p = r.players.find(x => x.ws === ws);
      if (p && COLS.includes(m.c) && !r.players.some(x => x !== p && x.c === m.c)) { p.c = m.c; bcast(r); }
      else send(ws, { t: 'sys', text: '⚠️ Bu renk başkasında!' });
    }
    else if (m.t === 'cycle' && ws.pid === r.hostPid) {
      const p = r.players.find(x => x.pid === m.pid);
      if (!p) return;
      const cur = COLS.indexOf(p.c);
      for (let k = 1; k <= COLS.length; k++) {
        const c = COLS[(cur + k) % COLS.length];
        if (!r.players.some(x => x.c === c)) { p.c = c; break; }
      }
      bcast(r);
    }
    else if (m.t === 'kick' && ws.pid === r.hostPid && m.pid !== ws.pid) {
      const p = r.players.find(x => x.pid === m.pid);
      if (!p) return;
      send(p.ws, { t: 'kicked' });
      r.players = r.players.filter(x => x !== p); p.ws.room = null;
      sys(r, '🚫 ' + p.n + ' odadan atıldı');
      bcast(r);
    }
    else if (m.t === 'leave') leaveRoom(ws);
  });
  ws.on('close', () => leaveRoom(ws));
});

server.listen(PORT, () => console.log('Sunucu hazır: port ' + PORT));
