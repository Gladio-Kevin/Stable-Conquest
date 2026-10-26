const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const COLS = ['#3d9bff', '#ff5a6e', '#3fdc8e', '#ffb52e', '#b57bff', '#ff7bd5'];
const BAD = /(amk|aq|orospu|pi[cç]|siktir|sikeyim|yarra[kg]|ibne|amına|amina|götveren)/gi;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = s => esc(String(s).replace(BAD, '***'));
const rnd = n => Math.floor(Math.random() * n);

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const base = 'https://' + req.headers.host; // adres otomatik alınır, elle yazmaya gerek yok
  if (url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('User-agent: *\nAllow: /\n\nSitemap: ' + base + '/sitemap.xml\n');
  }
  if (url === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + base + '/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n');
  }
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
// Her oda için benzersiz 7 haneli sayı
const genId = () => { let s; do { s = String(1000000 + rnd(9000000)); } while (rooms.has(s)); return s; };
const freeCol = r => COLS.find(c => !r.players.some(p => p.c === c));
const snap = (r, ws) => ({
  t: 'room', id: r.id, name: r.name, max: r.max, host: ws.pid === r.hostPid, me: ws.pid,
  players: r.players.map(p => ({ pid: p.pid, n: p.n, c: p.c, ready: !!p.ready, host: p.pid === r.hostPid })),
  history: r.hist.slice(-30)
});
const bcast = r => r.players.forEach(p => send(p.ws, snap(r, p.ws)));
function sys(r, t) { r.hist.push('<i>' + t + '</i>'); r.players.forEach(p => send(p.ws, { t: 'sys', text: t })); }
function chat(r, n, text) { r.hist.push('<b>' + n + ':</b> ' + text); r.players.forEach(p => send(p.ws, { t: 'chat', n, text })); }

/* ---------- OYUN ---------- */
const STARTS = [30, 5, 0, 35];
const TURN_MS = 120000; // her tur 2 dakika
function nb(i) {
  const r = Math.floor(i / 6), c = i % 6, a = [];
  if (r > 0) a.push(i - 6); if (r < 5) a.push(i + 6); if (c > 0) a.push(i - 1); if (c < 5) a.push(i + 1);
  return a;
}
function produce(g) {
  for (let i = 0; i < 36; i++) if (g.own[i] >= 0) g.tr[i] += g.castle[i] ? 3 : 1;
  g.moved.fill(false); g.ended.clear(); g.plans.clear();
}
function newGame(r) {
  clearTimeout(r.timer);
  const own = Array(36).fill(-1), tr = [], castle = Array(36).fill(false);
  for (let i = 0; i < 36; i++) tr.push(2 + rnd(3));
  [7, 10, 25, 28, 14, 21].forEach(i => { castle[i] = true; tr[i] = 6; });
  r.players.forEach((p, k) => { p.idx = k; own[STARTS[k]] = k; tr[STARTS[k]] = 6; castle[STARTS[k]] = false; });
  r.gp = r.players.map(p => ({ idx: p.idx, pid: p.pid, n: p.n, c: p.c }));
  r.g = { own, tr, castle, moved: Array(36).fill(false), round: 1, ended: new Set(), plans: new Map(), steps: [], rv: new Set(), over: false, winner: -1 };
  produce(r.g); armTimer(r, 0);
}
const cnt = (g, k) => g.own.filter(o => o === k).length;
const alive = r => r.players.filter(p => cnt(r.g, p.idx) > 0);
function act(r, f, t) {
  const g = r.g, me = g.own[f], n = g.tr[f] - 1, N = r.gp[me].n;
  g.tr[f] = 1; g.moved[f] = true;
  if (g.own[t] === me) { g.tr[t] += n; return { k: 'm', msg: N + ' askerleri birleştirdi' }; }
  const d = g.tr[t];
  if (n > d) { g.own[t] = me; g.tr[t] = n - d; return { k: 'c', msg: N + ' bir kare fethetti! (' + n + ' vs ' + d + ')' + (g.castle[t] ? ' 🏰' : '') }; }
  g.tr[t] = Math.max(1, d - n);
  return { k: 'r', msg: N + ' saldırısı püskürtüldü (' + n + ' vs ' + d + ')' };
}
// Herkes hazır olunca gizli hamleler rastgele sırayla uygulanır
function resolveTurn(r) {
  const g = r.g, mv = [], steps = [];
  r.players.forEach(p => (g.plans.get(p.pid) || []).forEach(x => mv.push({ idx: p.idx, f: x.f, t: x.t })));
  for (let i = mv.length - 1; i > 0; i--) { const j = rnd(i + 1); [mv[i], mv[j]] = [mv[j], mv[i]]; }
  mv.forEach(x => {
    if (g.own[x.f] !== x.idx || g.tr[x.f] < 2) return;
    const a = act(r, x.f, x.t);
    steps.push({ f: x.f, t: x.t, k: a.k, by: x.idx, msg: a.msg, own: [...g.own], tr: [...g.tr] });
  });
  return steps;
}
function armTimer(r, extra) {
  clearTimeout(r.timer);
  if (!r.g || r.g.over) return;
  r.g.deadline = Date.now() + TURN_MS + extra;
  r.timer = setTimeout(() => {
    if (!r.g || r.g.over) return;
    alive(r).forEach(p => r.g.ended.add(p.pid));
    checkEnd(r); gbcast(r, '⏰ Süre doldu, tur geçti!');
  }, TURN_MS + extra);
}
function checkEnd(r) {
  const g = r.g; let a = alive(r);
  if (a.length > 1 && a.every(p => g.ended.has(p.pid))) {
    g.steps = resolveTurn(r); a = alive(r);
    if (a.length > 1) { g.round++; produce(g); armTimer(r, g.steps.length * 800 + 1500); return; }
  }
  if (a.length <= 1) { g.over = true; g.winner = a[0] ? a[0].idx : -1; clearTimeout(r.timer); }
}
function gbcast(r, msg) {
  const g = r.g, left = Math.max(0, Math.round(((g.deadline || Date.now()) - Date.now()) / 1000));
  r.players.forEach(p => send(p.ws, {
    t: 'g', you: p.idx, pid: p.pid, own: g.own, tr: g.tr, castle: g.castle,
    round: g.round, left, ended: [...g.ended], over: g.over, winner: g.winner, msg: msg || '',
    players: r.gp, plan: g.plans.get(p.pid) || [], steps: g.steps, rv: [...g.rv]
  }));
  g.steps = [];
}

function leaveRoom(ws) {
  const r = ws.room; if (!r) return;
  ws.room = null;
  const i = r.players.findIndex(p => p.ws === ws); if (i < 0) return;
  const p = r.players.splice(i, 1)[0];
  if (!r.players.length) { clearTimeout(r.timer); rooms.delete(r.id); return; }
  if (p.pid === r.hostPid) { r.hostPid = r.players[0].pid; sys(r, r.players[0].n + ' artık oda sahibi'); }
  sys(r, p.n + ' odadan ayrıldı');
  bcast(r);
  if (r.g && !r.g.over) {
    for (let k = 0; k < 36; k++) if (r.g.own[k] === p.idx) r.g.own[k] = -1; r.g.plans.delete(p.pid);
    checkEnd(r); gbcast(r, p.n + ' oyundan ayrıldı');
  }
}

wss.on('connection', ws => {
  ws.pid = nextPid++; ws.room = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const r = ws.room;
    const me = r && r.players.find(x => x.ws === ws);

    if (m.t === 'create') {
      leaveRoom(ws);
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      const rn = clean(String(m.room || '').slice(0, 16)) || 'Oda';
      const max = Math.min(4, Math.max(2, parseInt(m.max) || 2));
      const nr = { id: genId(), name: rn, max, hostPid: ws.pid, players: [], hist: [], g: null };
      nr.players.push({ pid: ws.pid, ws, n: name, c: COLS.includes(m.c) ? m.c : COLS[0], ready: false });
      rooms.set(nr.id, nr); ws.room = nr;
      sys(nr, name + ' odayı kurdu'); bcast(nr);
    }
    else if (m.t === 'join') {
      const jr = rooms.get(String(m.id));
      if (!jr) return send(ws, { t: 'err', text: 'Oda bulunamadı!' });
      if (jr.g) return send(ws, { t: 'err', text: 'Bu odada oyun başlamış!' });
      if (jr.players.length >= jr.max) return send(ws, { t: 'err', text: 'Oda dolu!' });
      leaveRoom(ws);
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      let c = COLS.includes(m.c) ? m.c : COLS[0];
      if (jr.players.some(p => p.c === c)) c = freeCol(jr);
      jr.players.push({ pid: ws.pid, ws, n: name, c, ready: false }); ws.room = jr;
      sys(jr, name + ' odaya katıldı'); bcast(jr);
    }
    else if (!r || !me) return;
    else if (m.t === 'chat') {
      const text = clean(String(m.text || '').slice(0, 80)).trim();
      if (text) chat(r, me.n, text);
    }
    else if (m.t === 'color' && !r.g) {
      if (COLS.includes(m.c) && !r.players.some(x => x !== me && x.c === m.c)) { me.c = m.c; bcast(r); }
      else send(ws, { t: 'sys', text: '⚠️ Bu renk dolu!' });
    }
    else if (m.t === 'ready' && !r.g) { me.ready = !me.ready; sys(r, me.n + (me.ready ? ' hazır oldu ✅' : ' hazır değil ❌')); bcast(r); }
    else if (m.t === 'cycle' && ws.pid === r.hostPid && !r.g) {
      const p = r.players.find(x => x.pid === m.pid); if (!p) return;
      const cur = COLS.indexOf(p.c);
      for (let k = 1; k <= COLS.length; k++) {
        const c = COLS[(cur + k) % COLS.length];
        if (!r.players.some(x => x.c === c)) { p.c = c; break; }
      }
      bcast(r);
    }
    else if (m.t === 'kick' && ws.pid === r.hostPid && m.pid !== ws.pid && !r.g) {
      const p = r.players.find(x => x.pid === m.pid); if (!p) return;
      send(p.ws, { t: 'kicked' });
      r.players = r.players.filter(x => x !== p); p.ws.room = null;
      sys(r, '🚫 ' + p.n + ' odadan atıldı'); bcast(r);
    }
    else if (m.t === 'start' && ws.pid === r.hostPid && !r.g) {
      if (r.players.length < r.max) return send(ws, { t: 'sys', text: '⚠️ Oda dolmadan başlatılamaz (' + r.players.length + '/' + r.max + ')' });
      if (!r.players.every(p => p.ready)) return send(ws, { t: 'sys', text: '⚠️ Herkes hazır olmadan başlatılamaz' });
      newGame(r); gbcast(r, 'Savaş başladı!');
    }
    else if (m.t === 'move' && r.g && !r.g.over) {
      const g = r.g, f = m.from | 0, t = m.to | 0;
      if (g.ended.has(me.pid) || f < 0 || f > 35 || t < 0 || t > 35) return;
      if (g.own[f] !== me.idx || g.tr[f] < 2 || !nb(f).includes(t)) return;
      const pl = g.plans.get(me.pid) || [];
      if (pl.some(x => x.f === f)) return;
      pl.push({ f, t }); g.plans.set(me.pid, pl); gbcast(r, '');
    }
    else if (m.t === 'unplan' && r.g && !r.g.over && !r.g.ended.has(me.pid)) {
      const f = m.from | 0, pl = (r.g.plans.get(me.pid) || []).filter(x => x.f !== f);
      r.g.plans.set(me.pid, pl); gbcast(r, '');
    }
    else if (m.t === 'rematch' && r.g && r.g.over) {
      if (r.players.length < 2) return send(ws, { t: 'sys', text: '⚠️ Rakip kalmadı' });
      r.g.rv.add(me.pid);
      if (r.players.every(p => r.g.rv.has(p.pid))) { newGame(r); gbcast(r, '🔁 Rövanş başladı!'); }
      else { sys(r, me.n + ' rövanş istiyor 🔁'); gbcast(r, ''); }
    }
    else if (m.t === 'end' && r.g && !r.g.over) { r.g.ended.add(me.pid); checkEnd(r); gbcast(r, ''); }
    else if (m.t === 'again' && ws.pid === r.hostPid && r.g && r.g.over) {
      r.g = null; r.players.forEach(p => { p.ready = false; send(p.ws, { t: 'tolobby' }); });
      sys(r, 'Lobiye dönüldü'); bcast(r);
    }
    else if (m.t === 'leave') leaveRoom(ws);
  });
  ws.on('close', () => leaveRoom(ws));
});

server.listen(PORT, () => console.log('Sunucu hazır: port ' + PORT));
