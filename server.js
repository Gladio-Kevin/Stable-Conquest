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
const genTok = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const GRACE_MS = 300000; // bağlantısı kopan oyuncu 5 dk odada kalır

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const base = 'https://' + req.headers.host;
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

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
// Her oda için benzersiz 7 haneli sayı
const genId = () => { let s; do { s = String(1000000 + rnd(9000000)); } while (rooms.has(s)); return s; };
const freeCol = r => COLS.find(c => !r.players.some(p => p.c === c));
const everyone = r => [...r.players, ...r.specs];
const snap = (r, ws) => {
  const me = r.players.find(p => p.ws === ws);
  return {
    t: 'room', id: r.id, name: r.name, max: r.max, host: ws.pid === r.hostPid, me: ws.pid, token: me ? me.token : '',
    players: r.players.map(p => ({ pid: p.pid, n: p.n, c: p.c, ready: !!p.ready, host: p.pid === r.hostPid })),
    history: r.hist.slice(-30)
  };
};
const bcast = r => r.players.forEach(p => send(p.ws, snap(r, p.ws)));
function sys(r, t) { r.hist.push('<i>' + t + '</i>'); everyone(r).forEach(p => send(p.ws, { t: 'sys', text: t })); }
function chat(r, n, text) { r.hist.push('<b>' + n + ':</b> ' + text); everyone(r).forEach(p => send(p.ws, { t: 'chat', n, text })); }

/* ---------- OYUN ---------- */
const STARTS = [30, 5, 0, 35];
const TURN_MS = 120000; // her tur 2 dakika
function nb(i) {
  const r = Math.floor(i / 6), c = i % 6, a = [];
  if (r > 0) a.push(i - 6); if (r < 5) a.push(i + 6); if (c > 0) a.push(i - 1); if (c < 5) a.push(i + 1);
  return a;
}
function pushFrame(g, o) { g.frames.push(Object.assign({ own: [...g.own], tr: [...g.tr], round: g.round }, o)); }
function produce(g) {
  for (let i = 0; i < 36; i++) if (g.own[i] >= 0) g.tr[i] += g.castle[i] ? 3 : 1;
  g.moved.fill(false); g.ended.clear(); g.plans.clear();
}
function newGame(r) {
  clearTimeout(r.timer);
  const own = Array(36).fill(-1), tr = [], castle = Array(36).fill(false);
  for (let i = 0; i < 36; i++) tr.push(2 + rnd(3));
  [7, 10, 25, 28, 14, 21].forEach(i => { castle[i] = true; tr[i] = 6; });
  r.players.forEach((p, k) => { p.idx = k; p.dc = false; own[STARTS[k]] = k; tr[STARTS[k]] = 6; castle[STARTS[k]] = false; });
  r.gp = r.players.map(p => ({ idx: p.idx, pid: p.pid, n: p.n, c: p.c, pat: p.pat || '', fx: p.fx || '' }));
  r.g = { own, tr, castle, moved: Array(36).fill(false), round: 1, ended: new Set(), plans: new Map(), steps: [], rv: new Set(), frames: [], over: false, winner: -1 };
  produce(r.g); pushFrame(r.g, { msg: 'Oyun başladı' }); armTimer(r, 0);
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
    const st = { f: x.f, t: x.t, k: a.k, by: x.idx, msg: a.msg, round: g.round, own: [...g.own], tr: [...g.tr] };
    steps.push(st); g.frames.push(st);
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
  if (a.length > 1 && a.every(p => g.ended.has(p.pid) || p.dc)) {
    g.steps = resolveTurn(r); a = alive(r);
    if (a.length > 1) {
      g.round++; produce(g); pushFrame(g, { msg: 'Tur ' + g.round + ' başladı, askerler arttı' });
      armTimer(r, g.steps.length * 800 + 1500); return;
    }
  }
  if (a.length <= 1) { g.over = true; g.winner = a[0] ? a[0].idx : -1; clearTimeout(r.timer); pushFrame(g, { msg: '🏁 Oyun bitti' }); }
}
function gbcast(r, msg) {
  const g = r.g, left = Math.max(0, Math.round(((g.deadline || Date.now()) - Date.now()) / 1000));
  const base = {
    t: 'g', own: g.own, tr: g.tr, castle: g.castle, round: g.round, left, ended: [...g.ended],
    over: g.over, winner: g.winner, msg: msg || '', players: r.gp, steps: g.steps, rv: [...g.rv],
    replay: g.over ? g.frames : null
  };
  r.players.forEach(p => send(p.ws, Object.assign({}, base, { you: p.idx, pid: p.pid, plan: g.plans.get(p.pid) || [] })));
  r.specs.forEach(s => send(s.ws, Object.assign({}, base, { you: -2, pid: s.pid, plan: [] })));
  g.steps = [];
}
function promoteSpecs(r) {
  while (r.specs.length && r.players.length < r.max) {
    const s = r.specs.shift();
    r.players.push({ pid: s.pid, ws: s.ws, n: s.n, c: freeCol(r), ready: false, token: genTok() });
  }
}

function leaveRoom(ws) {
  const r = ws.room; if (!r) return;
  ws.room = null;
  const si = r.specs.findIndex(s => s.ws === ws);
  if (si >= 0) { const s = r.specs.splice(si, 1)[0]; sys(r, '👀 ' + s.n + ' izleyiciden ayrıldı'); return; }
  const i = r.players.findIndex(p => p.ws === ws); if (i < 0) return;
  const p = r.players.splice(i, 1)[0];
  clearTimeout(p.dcTimer);
  if (!r.players.length) {
    clearTimeout(r.timer); rooms.delete(r.id);
    r.specs.forEach(s => { send(s.ws, { t: 'kicked' }); s.ws.room = null; });
    return;
  }
  if (p.pid === r.hostPid) { r.hostPid = r.players[0].pid; sys(r, r.players[0].n + ' artık oda sahibi'); }
  sys(r, p.n + ' odadan ayrıldı');
  bcast(r);
  if (r.g && !r.g.over) {
    for (let k = 0; k < 36; k++) if (r.g.own[k] === p.idx) r.g.own[k] = -1;
    r.g.plans.delete(p.pid);
    checkEnd(r); gbcast(r, p.n + ' oyundan ayrıldı');
  }
}

wss.on('connection', ws => {
  ws.pid = nextPid++; ws.room = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong' });
    const r = ws.room;
    const me = r && r.players.find(x => x.ws === ws);

    if (m.t === 'create') {
      leaveRoom(ws);
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      const rn = clean(String(m.room || '').slice(0, 16)) || 'Oda';
      const max = Math.min(4, Math.max(2, parseInt(m.max) || 2));
      const nr = { id: genId(), name: rn, max, hostPid: ws.pid, players: [], specs: [], hist: [], g: null };
      nr.players.push({ pid: ws.pid, ws, n: name, c: COLS.includes(m.c) ? m.c : COLS[0], ready: false, token: genTok() });
      rooms.set(nr.id, nr); ws.room = nr;
      sys(nr, name + ' odayı kurdu'); bcast(nr);
    }
    else if (m.t === 'join') {
      const jr = rooms.get(String(m.id));
      if (!jr) return send(ws, { t: 'err', text: 'Oda bulunamadı!' });
      const name = clean(String(m.name || '').slice(0, 12)) || 'Oyuncu';
      if (jr.g) { // oyun başlamış: izleyici olarak katıl
        leaveRoom(ws);
        jr.specs.push({ pid: ws.pid, ws, n: name }); ws.room = jr;
        sys(jr, '👀 ' + name + ' izleyici olarak katıldı');
        send(ws, { t: 'spec', id: jr.id, name: jr.name, max: jr.max, me: ws.pid, players: jr.gp.map(p => ({ n: p.n, c: p.c })), history: jr.hist.slice(-30) });
        return gbcast(jr, '');
      }
      if (jr.players.length >= jr.max) return send(ws, { t: 'err', text: 'Oda dolu!' });
      leaveRoom(ws);
      let c = COLS.includes(m.c) ? m.c : COLS[0];
      if (jr.players.some(p => p.c === c)) c = freeCol(jr);
      jr.players.push({ pid: ws.pid, ws, n: name, c, ready: false, token: genTok() }); ws.room = jr;
      sys(jr, name + ' odaya katıldı'); bcast(jr);
    }
    else if (m.t === 'rejoin') { // bağlantısı kopan oyuncu geri döner
      const rr = rooms.get(String(m.id));
      const p = rr && m.token && rr.players.find(x => x.token === m.token);
      if (!p) return send(ws, { t: 'norejoin' });
      clearTimeout(p.dcTimer);
      const old = p.ws; p.dc = false; p.ws = ws; ws.pid = p.pid; ws.room = rr;
      if (old && old !== ws) { old.room = null; try { old.terminate(); } catch (e) {} }
      sys(rr, '✅ ' + p.n + ' geri döndü');
      bcast(rr); if (rr.g) gbcast(rr, '');
    }
    else if (r && r.specs.some(s => s.ws === ws)) { // izleyici: sadece sohbet
      const s = r.specs.find(x => x.ws === ws);
      if (m.t === 'chat') { const text = clean(String(m.text || '').slice(0, 80)).trim(); if (text) chat(r, '👀 ' + s.n, text); }
      else if (m.t === 'leave') leaveRoom(ws);
    }
    else if (!r || !me) return;
    else if (m.t === 'cos') {
      const ok = v => /^[a-z0-9_]{0,14}$/.test(String(v || '')) ? String(v || '') : '';
      me.pat = ok(m.pat); me.fx = ok(m.fx);
    }
    else if (m.t === 'typing') { everyone(r).forEach(p => { if (p.ws !== ws) send(p.ws, { t: 'typing', n: me.n }); }); }
    else if (m.t === 'unend' && r.g && !r.g.over) { r.g.ended.delete(me.pid); gbcast(r, ''); }
    else if (m.t === 'givehost' && ws.pid === r.hostPid && !r.g) {
      const p = r.players.find(x => x.pid === m.pid);
      if (p) { r.hostPid = p.pid; sys(r, p.n + ' artık oda sahibi 👑'); bcast(r); }
    }
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
      clearTimeout(p.dcTimer);
      r.players = r.players.filter(x => x !== p); if (p.ws) p.ws.room = null;
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
      if (r.players.every(p => r.g.rv.has(p.pid))) { promoteSpecs(r); bcast(r); newGame(r); gbcast(r, '🔁 Rövanş başladı!'); }
      else { sys(r, me.n + ' rövanş istiyor 🔁'); gbcast(r, ''); }
    }
    else if (m.t === 'end' && r.g && !r.g.over) { r.g.ended.add(me.pid); checkEnd(r); gbcast(r, ''); }
    else if (m.t === 'again' && ws.pid === r.hostPid && r.g && r.g.over) {
      r.g = null; promoteSpecs(r);
      r.players.forEach(p => { p.ready = false; send(p.ws, { t: 'tolobby' }); });
      sys(r, 'Lobiye dönüldü'); bcast(r);
    }
    else if (m.t === 'leave') leaveRoom(ws);
  });
  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    if (r.specs.some(s => s.ws === ws)) return leaveRoom(ws);
    const p = r.players.find(x => x.ws === ws); if (!p) return;
    p.dc = true;
    sys(r, '⚠️ ' + p.n + ' bağlantısı koptu (5 dk içinde dönebilir)');
    bcast(r);
    p.dcTimer = setTimeout(() => { if (p.dc) leaveRoom(p.ws); }, GRACE_MS);
    if (r.g && !r.g.over) { checkEnd(r); gbcast(r, ''); }
  });
});

// Sunucu bağlantıyı canlı tutar (arka plandaki telefonlar da cevap verir, oda kapanmaz)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  });
}, 25000);

server.listen(PORT, () => console.log('Sunucu hazır: port ' + PORT));
