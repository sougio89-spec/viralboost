// Serveur Arène v2 — zéro dépendance (Node 18+).
// Lancer : node arena-server.js  puis ouvrir http://localhost:3000
// Variables d'environnement : PORT, DATA_DIR (dossier de données persistant), TRUST_PROXY=1 (derrière un proxy/CDN), ALLOW_ORIGIN
//
// Ce que le serveur gère pour de VRAIS joueurs :
//  - comptes (scrypt, jetons 30 j), présence en ligne (SSE), synchronisation du profil/des sessions entre appareils
//  - ligues Joueurs côté serveur (la ligue d'un joueur n'est plus dans son navigateur)
//  - créneaux de compétition toutes les heures : inscriptions 15 min avant, divisions de 20 par ligue,
//    bots uniquement pour compléter les places vides, classement live entre vrais joueurs, bilan + montée/descente
//  - règles hebdomadaires (3 compétitions minimum, mode vacances) appliquées par le serveur
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(Math.min(16, Math.max(4, require('os').cpus().length))); // pool de threads pour scrypt
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = +process.env.PORT || 3000, H = 36e5, MIN = 6e4, WK = 6048e5, REG = 15 * MIN, TOKEN_TTL = 30 * 24 * H, MINDIV = 6;
const DATA_DIR = process.env.DATA_DIR || __dirname, CLOUD = path.join(DATA_DIR, 'cloud');
const DBF = path.join(DATA_DIR, 'arena-data.json'), HTML = path.join(__dirname, 'backtest-arena.html');
const TRUST_PROXY = process.env.TRUST_PROXY == '1', ORIGIN = process.env.ALLOW_ORIGIN || '*';
fs.mkdirSync(CLOUD, { recursive: true });

let db = { users: {}, tokens: {}, res: {}, slots: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) {}
for (const t in db.tokens) if (typeof db.tokens[t] == 'string') db.tokens[t] = { u: db.tokens[t], exp: Date.now() + TOKEN_TTL }; // migration v1
db.agg = db.agg || { player: {}, bot: {} }; db.flags = db.flags || [];
// persistance : on marque « modifié », un seul écrivain à la fois, écriture atomique (tmp + rename)
let dirty = false, writing = false;
const save = () => { dirty = true; };
function flush(cb) {
  if (writing || !dirty) return cb && cb();
  dirty = false; writing = true; let data;
  try { data = JSON.stringify(db); } catch (e) { writing = false; return cb && cb(); }
  fs.writeFile(DBF + '.tmp', data, e => { if (e) { writing = false; dirty = true; return cb && cb(); } fs.rename(DBF + '.tmp', DBF, () => { writing = false; cb && cb(); }); });
}
setInterval(() => flush(), 2000);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const getUser = p => { const k = String(p).toLowerCase(); return hasOwn(db.users, k) ? db.users[k] : null; };
// scrypt asynchrone (ne bloque pas le serveur quand des centaines de joueurs se connectent en même temps)
let scryptPending = 0;
const hash = (p, s) => new Promise((ok, ko) => {
  if (scryptPending > 3000) return ko(Object.assign(new Error('serveur surchargé, réessaie dans quelques secondes'), { code: 503 }));
  scryptPending++; crypto.scrypt(p, s, 32, (e, k) => { scryptPending--; e ? ko(e) : ok(k.toString('hex')); });
});
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length == y.length && crypto.timingSafeEqual(x, y); };
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const cur = () => Math.floor(Date.now() / H);

// ---------- validation anti-triche : le score doit se déduire de la liste des trades ----------
const ROUND_BARS = 1920, DAY_BARS = 288, MAX_TR = 60; const BOT_BARS = 8640; // match Arenbot : 1 mois de bougies de 5 min par manche
const CMP_CF = 0.00065; // frais compétition par côté (spread 0,03 % + commission 0,04 % + slippage 0,01 %), identiques pour tous
const pr = x => Math.round(x * 1e5) / 1e5;
// mêmes règles de points que le client (close()) et que le moteur Python
// score = 2 × R par trade (borné −3..+6), séries ±1 (3 max chacune), pénalité de drawdown au-delà de 10 %, liquidation ≤ −5,
// moins de 3 trades : score positif au prorata, ÷2 si la manche finit en perte, borné −50..+70, arrondi au centième
function scoreOf(tr, ret, dd, liq) {
  let ws = 0, ls = 0, bu = 0, bd = 0, s = 0;
  for (const t of tr) {
    const risk = (t.sz || 1) * (t.sl > 0 ? t.sl : 1) / 100;
    let p = Math.floor(Math.max(-3, Math.min(6, 2 * (t.r / risk))) * 100 + .5) / 100;
    if (t.r > 1e-9) { ws++; ls = 0; if (ws >= 3 && bu < 3) { p += 1; bu++; } }
    else if (t.r < -1e-9) { ls++; ws = 0; if (ls >= 3 && bd < 3) { p -= 1; bd++; } }
    else { ws = ls = 0; p = 0; }
    t.pc = p; s += p;
  }
  s -= Math.min(10, Math.max(0, -dd * 100 - 10));
  if (liq) s = Math.min(s, -5);
  if (s > 0 && tr.length < 3) s *= tr.length / 3;
  if (ret < 0 && s > 0) s /= 2;
  return Math.floor(Math.max(-50, Math.min(70, s)) * 100 + .5) / 100;
}
// binomiale : P(X >= k) pour n essais de probabilité p (détection statistique des séries de TP impossibles)
function tail(n, k, p) {
  let s = 0, c = 1;
  for (let i = 0; i <= n; i++) { if (i > 0) c = c * (n - i + 1) / i; if (i >= k) s += c * Math.pow(p, i) * Math.pow(1 - p, n - i); }
  return s;
}
// renvoie { o } (résultat nettoyé) ou { err } ; o.sus = 1 si statistiquement suspect (non rejeté)
function checkResult(r, kind) {
  const bad = m => ({ err: 'résultat incohérent : ' + m });
  if (!r || typeof r != 'object' || !Array.isArray(r.eq) || !Array.isArray(r.tr)) return { err: 'résultat invalide' };
  if (r.tr.length > (kind == 'player' ? MAX_TR : 400) && kind == 'player') return bad('trop de trades');
  const raw = r.tr.length, finite = v => Number.isFinite(+v);
  const o = {
    sc: num(r.sc), ret: num(r.ret), dd: num(r.dd), n: Math.round(num(r.n)), tp: num(r.tp), sl: num(r.sl), w: num(r.w), liq: !!r.liq, nb: num(r.nb, 1),
    s0: 0, st: Math.max(1, Math.round(num(r.st, 1))), bars: Math.round(num(r.bars, 0)),
    eq: r.eq.slice(0, 720).map(x => pr(num(x))),
    tr: r.tr.slice(0, 400).map(x => ({ q: x && x.q > 0 ? 1 : -1, a: Math.round(num(x && x.a)), b: Math.round(num(x && x.b)), e: num(x && x.e), x: num(x && x.x), r: num(x && x.r), w: String((x && x.w) || '').slice(0, 8), pt: num(x && x.pt), sl: x && x.sl ? num(x.sl) : null, tp: x && x.tp ? num(x.tp) : null, sz: num(x && x.sz, 1) }))
  };
  for (const k of ['sc', 'ret', 'dd']) if (!finite(r[k])) return bad('champ « ' + k + ' » manquant');
  if (o.ret < -1 || o.ret > 10 || o.dd > 0.0001 || o.dd < -1.0001) return bad('ret/dd hors limites');
  if (o.sc > 70 || o.sc < -50) return bad('score hors limites');
  if (o.eq.length < 2) return bad('courbe vide');
  const tol = e => 0.005 + 0.3 * Math.abs(e);
  const tr = o.tr, full = kind == 'player' || raw <= 400;
  // 1) structure des trades : ordonnés, sans chevauchement, dans la manche
  let prev = 0, prod = 1;
  for (const t of tr) {
    if (t.a < 0 || t.b < t.a || t.a < prev || t.b > (kind == 'player' ? ROUND_BARS : BOT_BARS) + 1) return bad('trades hors séquence');
    if (!(t.r > -1.0001 && t.r < 5)) return bad('rendement de trade impossible');
    prev = t.b; prod *= 1 + t.r;
  }
  if (full) {
    // 2) le score se déduit des trades (TP/SL/sorties + séries), moitié si la manche finit en perte
    const sc = scoreOf(tr, o.ret, o.dd, o.liq);
    if (Math.abs(sc - o.sc) > (kind == 'player' ? 0.05 : 0.05 + 0.01 * tr.length)) return bad('score ≠ trades');
    if (kind == 'player' && tr.some(t => Math.abs(t.pc - t.pt) > 0.02)) return bad('points des trades');
    // 3) cohérence rendement final / trades (composition des gains)
    if (Math.abs(o.ret - (prod - 1)) > tol(o.ret)) return bad('rendement ≠ trades');
    if (o.n && o.n != tr.length) return bad('nombre de trades');
  }
  // 4) courbe d'équité : départ à 0, arrivée = rendement, plate hors trades
  if (Math.abs(o.eq[0]) > (kind == 'player' ? 1e-4 : 0.01)) return bad('courbe de départ'); // Arenbot : un trade ouvert dès la 1re bougie paie déjà ses frais
  if (Math.abs(o.eq[o.eq.length - 1] - o.ret) > tol(o.ret)) return bad('courbe ≠ rendement');
  let pk = 0, ddc = 0; for (const v of o.eq) { if (v < -1.0001 || v > 10) return bad('courbe impossible'); pk = Math.max(pk, v); ddc = Math.min(ddc, (1 + v) / (1 + pk) - 1); }
  if (o.dd > ddc + 0.005) return bad('drawdown ≠ courbe');
  if (o.liq && o.ret > -0.05 + tol(o.ret)) return bad('liquidation');
  if (!o.liq && kind == 'player' && o.ret < -0.05 - tol(o.ret)) return bad('perte au-delà de la liquidation');
  if (kind == 'player') {
    // règles de la compétition : manche de 1920 barres, tailles autorisées, 3 trades/jour max
    if (!(o.bars > 0 && o.bars <= ROUND_BARS) || (!o.liq && o.bars != ROUND_BARS)) return bad('durée de manche');
    for (const t of tr) {
      if (![.25, .5, 1, 2].includes(t.sz)) return bad('taille');
      if (t.w == 'TP' && !(t.tp > 0 && t.r > 0 && Math.abs(t.r - t.sz * (t.tp / 100 - 2 * CMP_CF)) < 1e-6)) return bad('TP incohérent');
      if (t.w == 'SL' && !(t.sl > 0 && t.r < 0 && Math.abs(t.r + t.sz * (t.sl / 100 + 2 * CMP_CF)) < 1e-6)) return bad('SL incohérent');
    }
    // 3 trades par jour maximum
    const cnt = {}; for (const t of tr) { const d = Math.floor(t.a / DAY_BARS); cnt[d] = (cnt[d] || 0) + 1; if (cnt[d] > 3) return bad('plus de 3 trades/jour'); }
    // équité plate quand aucune position n'est ouverte : valeur = composition des trades déjà clos
    const step = o.st, N = o.eq.length;
    if (N != Math.floor(o.bars / step) + 1 + (o.bars % step ? 1 : 0)) return bad('échantillonnage de la courbe');
    for (let k = 0; k < N; k++) {
      const t = Math.min(k * step, o.bars); let open = false, e = 1;
      for (const x of tr) { if (x.b <= t) e *= 1 + x.r; else if (x.a < t) { open = true; break; } }
      if (!open && Math.abs(o.eq[k] - (e - 1)) > tol(e - 1)) return bad('courbe ≠ trades');
    }
    // plausibilité statistique : trop de TP pour le ratio SL/TP annoncé (signalé, pas rejeté)
    const W = tr.filter(t => t.w == 'TP').length;
    if (tr.length >= 8 && W >= 8) {
      let ptp = 0; for (const t of tr) ptp += t.sl > 0 && t.tp > 0 ? t.sl / (t.sl + t.tp) : .5; ptp /= tr.length;
      if (tail(tr.length, W, Math.min(.9, ptp * 1.25)) < 1e-6) o.sus = 1;
    }
  }
  return { o };
}
// ---------- bots de la maison (uniquement pour compléter les divisions) ----------
const NMS = ['Kairo', 'Mira', 'Zed', 'Lyra', 'Nox', 'Vega', 'Orion', 'Sable', 'Juno', 'Atlas', 'Echo', 'Rhea', 'Kilo', 'Nova', 'Onyx', 'Pixel', 'Quill', 'Rune', 'Tarn'];
const botName = i => NMS[i] + (10 + i);
const RESERVED = new Set(); NMS.forEach((n, i) => { RESERVED.add(botName(i).toLowerCase()); RESERVED.add('bot_' + botName(i).toLowerCase()); });
const rn = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// ---------- utilisateurs ----------
function ensure(u) {
  u.created = u.created || Date.now(); u.j = u.j || { t: 8, h: [] }; u.b = u.b || { t: 8, h: [] };
  u.wk = u.wk || { w: Math.floor(Date.now() / WK), c: 0, v: 0 }; u.vac = u.vac || 0; u.msg = u.msg || ''; return u;
}
function wkSettle(u) { // 3 compétitions minimum par semaine, sinon relégation ; 2 semaines de vacances d'affilée max
  const W = Math.floor(Date.now() / WK), K = u.wk; if (K.w < W - 52) K.w = W - 52;
  while (K.w < W) {
    if (u.vac && K.v < 2) K.v++;
    else { if (!u.vac) K.v = 0; if (K.c < 3) { u.j.t = Math.min(8, u.j.t + 1); u.msg = 'Relégation : moins de 3 compétitions la semaine passée.'; } }
    K.c = 0; K.w++;
  }
}
const pub = u => ({ pseudo: u.pseudo, j: u.j, b: u.b, wk: u.wk, vac: u.vac, msg: u.msg, created: u.created });
function authUser(req, url) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('tok') || '', k = db.tokens[t];
  if (!k) return null; if (k.exp < Date.now()) { delete db.tokens[t]; return null; }
  const us = getUser(k.u); return us ? ensure(us) : null;
}
function newToken(us) {
  const mine = Object.entries(db.tokens).filter(([, v]) => v.u == us.pseudo).sort((a, b) => a[1].exp - b[1].exp);
  while (mine.length >= 8) delete db.tokens[mine.shift()[0]];
  const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = { u: us.pseudo, exp: Date.now() + TOKEN_TTL }; return t;
}

// ---------- créneaux de compétition ----------
// Créneau id = heure UTC entière. Inscriptions : [début-15 min, début[. Manche 1 : début → +30 min, manche 2 : +30 → +60 min.
const slot = id => (db.slots[id] = db.slots[id] || { reg: {}, divs: null, divOf: {}, st: {}, prog: {}, fin: null });
function makeDivs(reg) {
  const tiers = {}; for (const [p, v] of Object.entries(reg)) (tiers[v.tier] = tiers[v.tier] || []).push([p, v.t]);
  const out = []; let carry = [];
  for (let t = 1; t <= 8; t++) {
    let ps = (tiers[t] || []).sort((a, b) => a[1] - b[1]).map(x => x[0]); ps = carry.concat(ps); carry = [];
    if (!ps.length) continue;
    const later = Object.keys(tiers).some(k => +k > t);
    if (ps.length < MINDIV && later) { carry = ps; continue; } // trop peu de joueurs : on les fusionne avec la ligue voisine
    const n = Math.ceil(ps.length / 20), sz = Math.ceil(ps.length / n);
    for (let i = 0; i < ps.length; i += sz) out.push({ tier: t, idx: out.length, players: ps.slice(i, i + sz) });
  }
  return out;
}
function ensureDivs(id) {
  const s = db.slots[id]; if (!s || s.divs || Date.now() < id * H) return s;
  s.divs = makeDivs(s.reg); s.divs.forEach(d => d.players.forEach(p => s.divOf[p] = d.idx)); save(); return s;
}
const started = (s, p, r) => !!(s.st[p] && s.st[p][r]);
function rows(id, di, force) { // classement d'une division : vrais joueurs + bots pour compléter
  const s = db.slots[id]; if (!s || !s.divs) return null;
  if (s.fin && s.fin[di]) return s.fin[di];
  const d = s.divs[di], now = Date.now(), pr = (db.res[id] || {}).player || {}, closed = force || now > id * H + 65 * MIN;
  const humans = d.players.filter(p => started(s, p, 0) || now < id * H + 3 * MIN).map(p => {
    const rs = (pr[p] && pr[p].res) || [], g = s.prog[p]; let s_ = 0, ret = 0, done = 0, live = 0;
    for (let r = 0; r < 2; r++) {
      if (rs[r]) { s_ += rs[r].sc; ret += rs[r].ret; done++; }
      else if (g && g.r == r && !closed) { s_ += g.sc; ret += g.ret; live = 1; }
      else if (closed && started(s, p, 0)) s_ -= 4;
    }
    return { n: p, s: Math.round(s_ * 10) / 10, ret, done, live, bot: 0 };
  });
  const r = rn(id * 131 + d.idx * 17 + d.tier), bots = [];
  for (let k = 0; k < 20 - humans.length; k++) bots.push({ n: botName(k), s: Math.round((r() - .5) * 28 * (1 + (8 - d.tier) * .12)), ret: 0, done: 2, live: 0, bot: 1 });
  const all = humans.concat(bots).sort((a, b) => b.s - a.s || b.ret - a.ret || (a.n < b.n ? -1 : 1));
  return { tier: d.tier, idx: d.idx, rows: all };
}
function finalize(id) {
  const s = ensureDivs(id); if (!s || !s.divs || s.fin) return; s.fin = {};
  s.divs.forEach((d, di) => {
    const R = rows(id, di, true); s.fin[di] = R;
    d.players.filter(p => started(s, p, 0)).forEach(p => {
      const us = getUser(p); if (!us) return; ensure(us); wkSettle(us);
      const rk = R.rows.findIndex(x => x.n == p) + 1, f = us.j.t; let t = f;
      if (rk <= 4) t = Math.max(1, f - 1); else if (rk > 16) t = Math.min(8, f + 1);
      us.j.t = t; us.j.h.unshift({ id, rk, f, t, tot: R.rows[rk - 1].s }); us.j.h = us.j.h.slice(0, 20); us.wk.c++; us.msg = '';
    });
  });
  save(); bcast({ t: 'final', id });
}
function tickSlots() {
  const now = Date.now();
  for (const k in db.slots) {
    const id = +k, s = db.slots[id]; if (s.fin) continue;
    if (!s.divs && now >= id * H) ensureDivs(id);
    if (!s.divs) continue;
    const all = s.divs.every(d => d.players.every(p => !started(s, p, 0) || ((db.res[id] || {}).player || {})[p] && db.res[id].player[p].res[1]));
    if (now >= id * H + 62 * MIN && (all || now >= id * H + 66 * MIN)) finalize(id);
  }
  // compactage : détail (courbes, trades) 3 h seulement, puis scores seuls ; au-delà de 7 jours les scores sont archivés dans db.agg
  const c = cur();
  for (const k in db.res) {
    const id = +k;
    if (id < c - 24 * 7) {
      for (const kind in db.res[k]) for (const p in db.res[k][kind]) { const v = db.res[k][kind][p];
        if (v.res[0] && v.res[1]) { const a = (db.agg[kind][p] = db.agg[kind][p] || { pts: 0, n: 0, ret: 0 }); a.pts += v.res[0].sc + v.res[1].sc; a.ret += v.res[0].ret + v.res[1].ret; a.n++; } }
      delete db.res[k]; dirty = true; continue;
    }
    if (id < c - 3) for (const kind in db.res[k]) for (const p in db.res[k][kind]) { const rs = db.res[k][kind][p].res; if (rs.some(r => r && r.eq)) { db.res[k][kind][p].res = rs.map(r => r && ({ sc: r.sc, ret: r.ret })); dirty = true; } }
  }
  for (const k in db.slots) {
    const id = +k, sl = db.slots[k];
    if (id < c - 48) { delete db.slots[k]; dirty = true; } // on ne garde que 48 h de créneaux
    else if (sl.fin && id < c - 3 && sl.prog && Object.keys(sl.prog).length) { sl.prog = {}; dirty = true; }
  }
  for (const t in db.tokens) if (db.tokens[t].exp < now) { delete db.tokens[t]; dirty = true; }
}

// ---------- présence & temps réel ----------
const clients = new Map(); // réponse SSE -> pseudo | null (invité)
const onlineCount = () => { const s = new Set(); let g = 0; for (const u of clients.values()) u ? s.add(u) : g++; return { n: s.size + g, players: s.size }; };
const bcast = o => { const m = 'data: ' + JSON.stringify(o) + '\n\n'; for (const c of clients.keys()) try { c.write(m); } catch (e) {} };
const lazy = {}; // 'lobby' et 'sub' : au plus un message toutes les 3 s, quel que soit le nombre d'inscriptions/envois
const bcastLazy = o => { if (lazy[o.t]) return; lazy[o.t] = setTimeout(() => { delete lazy[o.t]; bcast(o); }, 3000); };
let onT = 0; const bOnline = () => { if (onT) return; onT = setTimeout(() => { onT = 0; bcast(Object.assign({ t: 'online' }, onlineCount())); }, 800); };

const clean = (r, kind) => checkResult(r, kind);
const readBody = (req, max = 8e5) => new Promise((ok, ko) => { let b = '', n = 0; req.on('data', c => { n += c.length; if (n > max) { req.destroy(); ko(new Error('trop gros')); } else b += c; }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ko(new Error('JSON invalide')); } }); });
const HOPS = Math.max(1, +process.env.TRUSTED_HOPS || 1);
const ipOf = req => { if (TRUST_PROXY) { const l = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean); if (l.length) return l[Math.max(0, l.length - HOPS)]; } return req.socket.remoteAddress; };
let lobbyCache = null, ladderCache = null, leagueCache = {}, champRankCache = null;
const CREATE_LIMIT = +process.env.CREATE_LIMIT || 50; // comptes créés par IP et par heure
const hits = new Map(); setInterval(() => hits.clear(), MIN);
const fails = new Map(), creates = new Map(); setInterval(() => { fails.clear(); }, 5 * MIN); setInterval(() => creates.clear(), H);
function flag(who, kind, id, why, res) { // journal des résultats rejetés / suspects, consultable dans arena-data.json (db.flags)
  db.flags.push({ t: Date.now(), who, kind, id, why, sc: res && res.sc, ret: res && res.ret }); if (db.flags.length > 500) db.flags.splice(0, db.flags.length - 500);
  console.warn('[triche?]', who, kind, id, why); save();
}
const cloudFile = p => path.join(CLOUD, p.toLowerCase() + '.json');

// ===== Ligue des Traders (tournoi hebdo, mercredi 17 h Europe/Paris) : inscriptions + effectifs par tour =====
const CHAMP_MIN = +process.env.CHAMP_MIN_TIER || 8, // ligue la plus basse admise (1 = élite … 8 = la plus basse) : accès si ligue <= CHAMP_MIN
  CHAMP_LOBBY = 5 * MIN, CHAMP_DIRECT = 16;
const parisParts = t => { const o = {}; for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t)) o[p.type] = p.value; return o; };
function champNext(now) { // prochain mercredi 17:00 Paris (gère l'heure d'été)
  for (let d = 0; d < 9; d++) { const b = new Date(now + d * 864e5); for (const h of [15, 16]) { const t = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), h); const p = parisParts(t); if (t > now && p.weekday == 'Wed' && p.hour == '17' && p.minute == '00') return t; } }
  return now + WK;
}
function champQuotas(N) { // effectifs qualifiés par tour pour arriver à 10 finalistes (progression géométrique)
  if (N < CHAMP_DIRECT) return { direct: true, n: N, rounds: [], final: 10 };
  const r = Math.pow(N / 10, .25); return { direct: false, n: N, rounds: [1, 2, 3, 4].map(k => k == 4 ? 10 : Math.round(N / Math.pow(r, k))), final: 10 };
}
function champEv(start) { db.champ = db.champ || {}; for (const k of Object.keys(db.champ)) if (+k < Date.now() - WK) delete db.champ[k]; return db.champ[start] = db.champ[start] || { reg: {} }; }

// ===== Ligue des Traders : moteur de course (le marché vit ICI ; le joueur ne reçoit jamais le futur) =====
const DAY = +process.env.CHAMP_DAY_MS || 15000, HIST = 60, BREAK = +process.env.CHAMP_BREAK_MS || 40000, CAP_R = +process.env.CHAMP_ROUND_MS || 15 * MIN, CAP_F = +process.env.CHAMP_FINAL_MS || 20 * MIN, C0 = 1000;
const CASSETS = ['Nasdaq 100', 'S&P 500', 'Bitcoin', 'Ethereum', 'Or', 'EUR/USD', 'Apple', 'Tesla', 'Nvidia']; // pas de pétrole en compétition
let E = null, lastLobby = 0;
const eqOf = (p, c) => p.cap + (p.pos ? p.pos.sz * p.pos.d * (c - p.pos.e) : 0);
const shut = (p, px) => { if (p.pos) { p.cap += p.pos.sz * p.pos.d * (px - p.pos.e); p.pos = null; } };
const mkP = (n, bot) => ({ n, bot, cap: C0, pos: null, out: 0, rk: null, dd: 0, dn: 0, dk: -1 });
// Marché réaliste : vol journalière propre à l'actif, régimes de vol (GARCH + niveau lent), queues épaisses (Student t5),
// effet de levier, tendances / ranges persistants, gaps d'ouverture, mèches issues d'un chemin intra-bougie.
const CVOL = { 'Nasdaq 100': .012, 'S&P 500': .009, 'Bitcoin': .025, 'Ethereum': .03, 'Or': .01, 'EUR/USD': .005, 'Apple': .014, 'Tesla': .035, 'Nvidia': .028 };
const CGAP = { 'Nasdaq 100': .3, 'S&P 500': .3, 'Bitcoin': 0, 'Ethereum': 0, 'Or': .2, 'EUR/USD': .15, 'Apple': .45, 'Tesla': .5, 'Nvidia': .5 };
const CLEV = { 'Nasdaq 100': .05, 'S&P 500': .05, 'Bitcoin': .03, 'Ethereum': .03, 'Or': 0, 'EUR/USD': 0, 'Apple': .04, 'Tesla': .04, 'Nvidia': .04 };
const gN = () => { const u = Math.random() || 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * Math.random()); };
const gT = () => { let q = 0; for (let k = 0; k < 5; k++) q += gN() ** 2; return gN() / Math.sqrt(q / 5) / 1.2909944487358056; };
function mkRound(rd) {
  const asset = CASSETS[Math.floor(Math.random() * CASSETS.length)], n = HIST + Math.ceil((rd == 4 ? CAP_F : CAP_R) / DAY) + 5, S = [];
  const sd = (CVOL[asset] || .012) * (.75 + Math.random() * .6), gp = CGAP[asset] || 0, lev = CLEV[asset] || 0;
  let p = 100, lv = gN() * .3, h = 1, mdr = gN() * .3, reg = 0, regLeft = 0, ea = 0, lx = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    if (regLeft-- <= 0) { const u = Math.random(); reg = u < .3 ? (Math.random() < .5 ? 1 : -1) : u < .65 ? 2 : 0; regLeft = 4 + Math.floor(Math.random() * 14); } // tendance haussière / baissière, range, neutre
    lv = Math.max(-.8, Math.min(1, .95 * lv + .09 * gN() - lev * prev / sd * .3)); mdr = .85 * mdr + .2 * gN();
    const vm = Math.exp(lv - .06), z = gT(), s = sd * vm * Math.sqrt(h), kap = reg == 2 ? .12 : .02;
    const drift = (mdr * .35 + (reg == 1 || reg == -1 ? reg * .5 : 0)) * sd - kap * (lx - ea) - .004 * lx;
    const gap = i && Math.random() < .7 ? gp * sd * gT() : 0, o = p * Math.exp(gap), x = s * z + drift, c = o * Math.exp(x);
    let cs = 0, mx = 0, mn = 0; const e = [], NS = 8; for (let j = 0; j < NS; j++) { cs += gN() * s / Math.sqrt(NS); e.push(cs); }
    for (let j = 0; j < NS - 1; j++) { const pt = e[j] - (j + 1) / NS * (cs - x); if (pt > mx) mx = pt; if (pt < mn) mn = pt; }
    const hi = Math.max(o, c, o * Math.exp(mx + Math.abs(gN()) * s * .2)), lo = Math.min(o, c, o * Math.exp(mn - Math.abs(gN()) * s * .2));
    S.push({ o, h: hi, l: lo, c }); h = Math.max(.4, Math.min(8, .03 + .08 * Math.min(25, z * z) + .89 * h));
    lx += Math.log(c / p); ea += .15 * (lx - ea); prev = x; p = c;
  }
  return { asset, S };
}
const quotaOf = rd => rd == 4 ? 1 : (E.q.direct ? 10 : E.q.rounds[rd]);
function place(p, d, sl, tp, rk, px, k) { p.pos = { d, e: px, sz: rk / 100 * C0 / (px * sl / 100), sl: px * (1 - d * sl / 100), tp: px * (1 + d * tp / 100) }; if (p.dk != k) { p.dk = k; p.dn = 0; } p.dn++; }
function rankRows() {
  const c = E.S[E.k].c, a = Object.values(E.P).map(p => { const e = eqOf(p, c); return { n: p.n, bot: p.bot, p: (e / C0 - 1) * 100, e, rk: p.rk, dd: p.dd, out: p.out }; });
  const g = r => r.out ? 2 : r.rk != null ? 0 : 1;
  return a.sort((x, y) => g(x) - g(y) || (g(x) == 0 ? x.rk - y.rk || y.e - x.e || x.dd - y.dd : y.e - x.e));
}
function refreshRows() { const R = rankRows(); E.rank = {}; R.forEach((r, i) => E.rank[r.n] = i + 1); E.rc = R.filter(r => r.rk != null).length; E.na = R.filter(r => !r.out).length; E.rows = R.slice(0, 10).map(r => ({ n: r.n, p: +r.p.toFixed(2), rk: r.rk != null ? 1 : 0, out: r.out })); return R; }
function openLobby(s) {
  const ev = champEv(s), names = Object.keys(ev.reg); if (!names.length) return;
  const N = names.length, q = champQuotas(N); E = { start: s, phase: 'lobby', N, q, alive: names, first: q.direct ? 4 : 0, rd: -1, k: HIST - 1, P: null }; E.nx = mkRound(E.first);
  console.log('[champ] lobby', new Date(s).toISOString(), N, 'inscrits');
}
function startRound(rd) {
  const R = E.nx; E.nx = null; E.rd = rd; E.S = R.S; E.asset = R.asset; E.t0 = Date.now(); E.k = E.proc = HIST - 1; E.phase = 'round'; E.P = {};
  for (const n of E.alive) E.P[n] = mkP(n, 0);
  if (rd == 4) { let b = 0; while (Object.keys(E.P).length < 10) { const n = 'Arenbot ' + (++b); E.P[n] = mkP(n, 1); } } // finale : Arenbots pour compléter jusqu'à 10
  refreshRows(); console.log('[champ] manche', rd + 1, E.asset, Object.keys(E.P).length, 'joueurs');
}
function stepCandle(k) {
  const c = E.S[k]; E.k = k;
  for (const p of Object.values(E.P)) {
    if (p.out || p.rk != null) continue;
    if (p.pos) { const d = p.pos.d, sl = d > 0 ? c.l <= p.pos.sl : c.h >= p.pos.sl, tp = d > 0 ? c.h >= p.pos.tp : c.l <= p.pos.tp; if (sl) shut(p, p.pos.sl); else if (tp) shut(p, p.pos.tp); } // SL prioritaire si les deux sont touchés
    const e = eqOf(p, c.c); p.dd = Math.max(p.dd, (C0 - e) / C0);
    if (e <= C0 * .95) { shut(p, c.c); p.out = 1; } else if (e >= C0 * 1.1) { shut(p, c.c); p.rk = k; }
    else if (p.bot && !p.pos && Math.random() < .15) place(p, Math.random() < .5 ? 1 : -1, .6, 1.2, 1, c.c, k);
  }
}
function champRewards(rows) {
  const H = db.champH = db.champH || []; H.push({ t: E.start, podium: E.res.podium, N: E.N }); if (H.length > 52) H.shift();
  rows.filter(r => !r.bot).slice(0, 10).forEach((r, i) => { const u = Object.values(db.users).find(x => x.pseudo == r.n); if (!u) return; (u.rew = u.rew || []).push({ t: E.start, k: i == 0 ? 'champion' : i < 3 ? 'podium' : 'finaliste', lot: i == 0 ? 'Elite 3 mois' : i < 3 ? 'Pro' : 'Badge finaliste' }); });
  save();
}
function endRound() {
  const R = refreshRows(), rd = E.rd;
  if (rd == 4 || !R.some(r => !r.out)) { E.res = { podium: R.slice(0, 3).filter(r => !r.out).map(r => r.n), rows: R.slice(0, 10).map(r => ({ n: r.n, p: +r.p.toFixed(2), bot: r.bot })) }; E.phase = 'done'; E.end = Date.now(); if (rd == 4) champRewards(R); return; }
  E.alive = R.filter(r => !r.out).slice(0, quotaOf(rd)).map(r => r.n); // atteints +10 % d'abord (les plus rapides), puis plus gros profits
  E.nx = mkRound(rd + 1); E.phase = 'break'; E.brk = Date.now() + BREAK; console.log('[champ] fin manche', rd + 1, '→', E.alive.length, 'qualifiés');
}
function champTick() {
  const now = Date.now(), s = champNext(now);
  if ((!E || E.phase == 'done') && now >= s - CHAMP_LOBBY && lastLobby != s) { lastLobby = s; openLobby(s); }
  if (!E) return;
  if (E.phase == 'lobby' && now >= E.start) startRound(E.first);
  else if (E.phase == 'break' && now >= E.brk) startRound(E.rd + 1);
  else if (E.phase == 'round') {
    const k = Math.min(E.S.length - 1, HIST - 1 + Math.floor((now - E.t0) / DAY)); while (E.proc < k) stepCandle(++E.proc);
    refreshRows(); const cap = E.rd == 4 ? CAP_F : CAP_R, act = Object.values(E.P).some(p => !p.out && p.rk == null);
    if (E.rc >= quotaOf(E.rd) || now - E.t0 >= cap || !act) endRound();
  }
}
function champOrder(n, b, close) {
  if (!E || E.phase != 'round') return 'pas de manche en cours';
  const p = E.P[n]; if (!p || p.out || p.rk != null) return 'tu ne joues plus cette manche';
  const px = E.S[E.k].c; if (close) { if (!p.pos) return 'aucune position'; shut(p, px); return ''; }
  if (p.pos) return 'position déjà ouverte'; if (p.dk != E.k) { p.dk = E.k; p.dn = 0; } if (p.dn >= 2) return '2 trades max par jour de marché (attends la bougie suivante)';
  const d = b.d == 'b' ? 1 : b.d == 's' ? -1 : 0, sl = +b.sl, tp = +b.tp, rk = +b.risk;
  if (!d || !(sl >= .05 && sl <= 20) || !(tp >= .05 && tp <= 40) || !(rk >= .05 && rk <= 1)) return 'ordre invalide (risque ≤ 1 %, SL et TP requis)';
  if (rk * tp / sl > 2.0001) return 'gain max 2 % du capital par trade (réduis le TP ou élargis le SL)';
  place(p, d, sl, tp, rk, px, E.k); return '';
}
function champState(us, rid, from) {
  const now = Date.now(); if (E.phase == 'done' && now - E.end > 15 * MIN) return { none: 1 };
  const live = E.phase == 'round' || E.phase == 'done', rdv = live ? E.rd : E.phase == 'lobby' ? E.first : E.rd + 1, id = E.start + '-' + rdv, S = live ? E.S : E.nx.S, k = live ? E.k : HIST - 1, f0 = rid == id ? Math.min(from, k + 1) : 0;
  const p = us && E.P && live ? E.P[us.pseudo] : null, c = S[k].c, q = quotaOf(rdv);
  return { phase: E.phase, rid: id, rd: rdv, final: rdv == 4, asset: live ? E.asset : E.nx.asset, f0, c: S.slice(f0, k + 1).map(x => [x.o, x.h, x.l, x.c].map(v => +v.toFixed(4))), start: E.start, N: E.N, quota: q, left: Math.max(0, q - (E.rc || 0)), na: E.na || E.alive.length, rank: us && E.rank ? E.rank[us.pseudo] || 0 : 0, rows: E.rows || [], res: E.res || null,
    cd: E.phase == 'lobby' ? E.start - now : E.phase == 'break' ? E.brk - now : E.phase == 'round' ? E.t0 + (rdv == 4 ? CAP_F : CAP_R) - now : 0,
    me: p ? { eq: +eqOf(p, c).toFixed(2), out: p.out, rk: p.rk, dd: p.dd, dn: p.dk == E.k ? p.dn : 0, pos: p.pos && { d: p.pos.d, e: p.pos.e, sl: p.pos.sl, tp: p.pos.tp } } : null, inn: us ? E.alive.includes(us.pseudo) : false };
}
setInterval(() => { try { champTick(); } catch (e) { console.error('[champ]', e); } }, 1000);

const DUELS = new Map(), DCH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; setInterval(() => { const t = Date.now() - 3 * H; for (const [k, m] of DUELS) if (m.created < t) DUELS.delete(k); }, 10 * MIN);
async function api(req, res, u) {
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const ip = ipOf(req), P = u.pathname, POST = req.method == 'POST', now = Date.now();
  let _me, _meDone = 0; const me = () => { if (!_meDone) { _meDone = 1; _me = authUser(req, u); } return _me; };
  { const m = me(), key = m ? 'u:' + m.pseudo : 'ip:' + ip, n = (hits.get(key) || 0) + 1; hits.set(key, n); if (n > (m ? 900 : 1500)) return send(429, { err: 'trop de requêtes' }); }

  if (P == '/api/champ/state') return send(200, E ? champState(me(), u.searchParams.get('rid'), +u.searchParams.get('from') || 0) : { none: 1 });
  if ((P == '/api/champ/order' || P == '/api/champ/close') && POST) { const us = me(); if (!us) return send(401, { err: 'connecte-toi' }); const er = champOrder(us.pseudo, P.endsWith('order') ? await readBody(req) : {}, P.endsWith('close')); return er ? send(400, { err: er }) : send(200, { ok: 1 }); }
  if (P == '/api/champ' || P == '/api/champ/join' || P == '/api/champ/leave') {
    const start = champNext(now), ev = champEv(start), us = me(), N = Object.keys(ev.reg).length;
    if (P == '/api/champ') return send(200, { start, lobby: start - CHAMP_LOBBY, now, n: N, minTier: CHAMP_MIN, quotas: champQuotas(N), reg: us ? !!ev.reg[us.pseudo] : false, tier: us ? us.j.t : null });
    if (!POST) return send(405, { err: 'POST requis' });
    if (!us) return send(401, { err: 'connecte-toi' });
    if (now >= start - CHAMP_LOBBY) return send(400, { err: 'inscriptions closes (lobby à 16h55)' });
    if (P == '/api/champ/leave') { delete ev.reg[us.pseudo]; save(); return send(200, { ok: 1 }); }
    if (us.vac) return send(400, { err: 'tu es en mode vacances' });
    if ((us.j.t || 8) > CHAMP_MIN) return send(400, { err: 'Ligue ' + CHAMP_MIN + ' minimum' });
    if (!ev.reg[us.pseudo]) ev.reg[us.pseudo] = { tier: us.j.t, t: now };
    save(); return send(200, { ok: 1 });
  }
  if (P == '/api/round') return send(200, { id: cur(), closes: (cur() + 1) * H, now });
  if (P == '/api/online') return send(200, onlineCount());

  if (P == '/api/stream') {
    const us = me();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (clients.size >= 20000) { res.writeHead(503); return res.end(); }
    let mine = 0; for (const c of clients.values()) if (us && c == us.pseudo) mine++;
    if (mine >= 6) { res.writeHead(429); return res.end(); }
    res.write('retry: 3000\n\n'); clients.set(res, us ? us.pseudo : null); bOnline();
    res.write('data: ' + JSON.stringify(Object.assign({ t: 'online' }, onlineCount())) + '\n\n');
    req.on('close', () => { clients.delete(res); bOnline(); }); res.on('error', () => clients.delete(res)); return;
  }

  // ----- 1 contre 1 : un code, deux joueurs, même marché (sans compte requis) -----
  if (P.startsWith('/api/duel/')) {
    const ok = o => send(200, Object.assign({ now: Date.now() }, o)), ko = (c, m) => send(c, { err: m, now: Date.now() });
    const num = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
    const nm = v => String(v || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Joueur';
    const cd = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const stat = (o, done) => { o = o || {}; const r = { done: done ? 1 : 0 }; for (const k of ['eq', 'c', 'ret', 'n', 'wr', 'pf', 'pts', 'q', 'cur']) if (o[k] != null && Number.isFinite(+o[k])) r[k] = +o[k]; return r; };
    if (P == '/api/duel/create' && POST) {
      const b = await readBody(req, 4e3), r0 = b.rules || {}, BIG = ['NQR', 'DEX', 'XAUM', 'BTCM', 'JPYM'];
      let as = Array.isArray(r0.as) ? r0.as.filter(a => BIG.includes(a)) : []; if (!as.length) as = BIG.slice();
      const R = { as, mins: [5, 10, 15, 20, 30].includes(+r0.mins) ? +r0.mins : 10, days: [1, 2, 3].includes(+r0.days) ? +r0.days : 2, cap: num(r0.cap, 100, 1e7, 10000),
        risk: num(r0.risk, 0, 10, 1), dl: num(r0.dl, 0, 100, 3), dd: num(r0.dd, 0, 100, 5), nt: Math.round(num(r0.nt, 0, 50, 3)), sl: r0.sl ? 1 : 0, tp: r0.tp ? 1 : 0, rr: num(r0.rr, 0, 10, 1),
        pf: ['zero', 'calme', 'std', 'agr'].includes(r0.pf) ? r0.pf : 'std', crit: ['ret', 'pf', 'wr', 'pts'].includes(r0.crit) ? r0.crit : 'ret' };
      if (DUELS.size > 5000) return ko(503, 'trop de matchs en cours');
      let code; do { code = Array.from(crypto.randomBytes(5), x => DCH[x % DCH.length]).join(''); } while (DUELS.has(code));
      const name = nm(b.name), m = { code, phase: 'wait', rules: R, names: { a: name, b: null }, seed: null, t0: 0, a: null, b: null, created: now };
      DUELS.set(code, m); return ok({ code, phase: m.phase, rules: R, names: m.names });
    }
    if (P == '/api/duel/join' && POST) {
      const b = await readBody(req, 2e3), m = DUELS.get(cd(b.code)); if (!m) return ko(404, 'Code introuvable');
      if (m.names.b) return ko(409, 'Ce match est déjà complet'); if (m.phase != 'wait') return ko(409, 'Ce match a déjà commencé');
      let n = nm(b.name); if (n.toLowerCase() == String(m.names.a).toLowerCase()) n = (n.slice(0, 13) + ' 2');
      m.names.b = n; m.phase = 'ready'; return ok({ code: m.code, phase: m.phase, rules: m.rules, names: m.names });
    }
    if (P == '/api/duel/start' && POST) {
      const b = await readBody(req, 2e3), m = DUELS.get(cd(b.code)); if (!m) return ko(404, 'Match expiré');
      if (b.role != 'a') return ko(403, 'Seul le créateur peut lancer');
      if (m.phase == 'run') return ok({ ok: 1 }); if (m.phase != 'ready') return ko(409, 'Attends ton adversaire');
      m.seed = { as: m.rules.as[Math.floor(Math.random() * m.rules.as.length)], rg: Math.floor(Math.random() * 1001) };
      m.t0 = now + 5000; m.phase = 'run'; return ok({ ok: 1 });
    }
    if (P == '/api/duel/state') {
      const m = DUELS.get(cd(u.searchParams.get('code'))); if (!m) return ko(404, 'Match expiré');
      if (m.phase == 'run' && ((m.a && m.a.done && m.b && m.b.done) || now > m.t0 + m.rules.mins * 60e3 + 20e3)) m.phase = 'done';
      return ok({ phase: m.phase, rules: m.rules, names: m.names, seed: m.seed, t0: m.t0, a: m.a, b: m.b });
    }
    if (P == '/api/duel/push' && POST) {
      const b = await readBody(req, 4e3), m = DUELS.get(cd(b.code)); if (!m) return ko(404, 'Match expiré');
      if (b.role != 'a' && b.role != 'b') return ko(400, 'rôle invalide'); if (m.phase != 'run' && m.phase != 'done') return ok({ ok: 1 });
      const prev = m[b.role]; if (prev && prev.done) return ok({ ok: 1 });
      m[b.role] = stat(b.s, b.s && b.s.done); return ok({ ok: 1 });
    }
    return ko(404, 'inconnu');
  }

  // ----- compte -----
  if (P == '/api/auth' && POST) {
    const b = await readBody(req, 2e3), p = String(b.pseudo || ''), pw = String(b.pass || '');
    if ((fails.get(ip) || 0) >= 20) return send(429, { err: 'trop de tentatives, réessaie dans quelques minutes' });
    if (!/^[\w-]{3,16}$/.test(p)) return send(400, { err: 'pseudo : 3 à 16 caractères (lettres, chiffres, _ -)' });
    if (pw.length < 6 || pw.length > 200) return send(400, { err: 'mot de passe : 6 caractères minimum' });
    let us = getUser(p);
    if (b.create) {
      if (us) return send(409, { err: 'pseudo déjà pris' });
      if (RESERVED.has(p.toLowerCase())) return send(409, { err: 'ce pseudo est réservé à un bot' });
      if ((creates.get(ip) || 0) >= CREATE_LIMIT) return send(429, { err: 'trop de comptes créés depuis cette connexion' });
      creates.set(ip, (creates.get(ip) || 0) + 1);
      const salt = crypto.randomBytes(8).toString('hex'), h = await hash(pw, salt);
      if (getUser(p)) return send(409, { err: 'pseudo déjà pris' }); // course pendant le hachage
      us = db.users[p.toLowerCase()] = ensure({ pseudo: p, salt, h });
    } else {
      const ok = us && hasOwn(us, 'h') && same(us.h, await hash(pw, us.salt));
      if (!ok) { fails.set(ip, (fails.get(ip) || 0) + 1); return send(401, { err: 'pseudo ou mot de passe incorrect' }); }
    }
    ensure(us); const t = newToken(us); save();
    return send(200, { token: t, pseudo: us.pseudo, me: pub(us) });
  }
  if (P == '/api/logout' && POST) { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); delete db.tokens[t]; save(); return send(200, { ok: 1 }); }
  if (P == '/api/delete' && POST) {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    const b = await readBody(req, 2e3); if (!same(us.h, await hash(String(b.pass || ''), us.salt))) return send(401, { err: 'mot de passe incorrect' });
    delete db.users[us.pseudo.toLowerCase()]; for (const t in db.tokens) if (db.tokens[t].u == us.pseudo) delete db.tokens[t];
    for (const id in db.res) for (const k in db.res[id]) delete db.res[id][k][us.pseudo];
    for (const id in db.slots) { const sl = db.slots[id]; delete sl.reg[us.pseudo]; delete sl.prog[us.pseudo]; }
    for (const k of ['player', 'bot']) delete db.agg[k][us.pseudo];
    fs.unlink(cloudFile(us.pseudo), () => {}); save(); return send(200, { ok: 1 });
  }
  if (P == '/api/me') { const us = me(); if (!us) return send(401, { err: 'connecte-toi' }); wkSettle(us); save(); return send(200, pub(us)); }
  if (P == '/api/vac' && POST) {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' }); wkSettle(us);
    const b = await readBody(req); us.vac = b.on ? 1 : 0;
    if (us.vac) { const ns = db.slots[cur() + 1]; if (ns) delete ns.reg[us.pseudo]; }
    save(); return send(200, pub(us));
  }

  // ----- synchronisation du profil / sessions entre appareils -----
  if (P == '/api/sync') {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    if (POST || req.method == 'PUT') {
      const b = await readBody(req, 1.5e6); if (!b || typeof b != 'object' || !Array.isArray(b.ses)) return send(400, { err: 'données invalides' });
      if (us.syncT && now - us.syncT < 3000) return send(429, { err: 'synchronisation trop fréquente' }); us.syncT = now;
      const o = { ts: now, pro: b.pro && typeof b.pro == 'object' ? b.pro : {}, ses: b.ses.slice(-200), lg: b.lg && typeof b.lg == 'object' ? b.lg : {} }, f = cloudFile(us.pseudo), tmp = f + '.' + process.pid + '.tmp';
      return fs.writeFile(tmp, JSON.stringify(o), e => { if (e) return send(500, { err: 'écriture impossible' }); fs.rename(tmp, f, e2 => e2 ? send(500, { err: 'écriture impossible' }) : send(200, { ok: 1, ts: o.ts })); });
    }
    return fs.readFile(cloudFile(us.pseudo), 'utf8', (e, d) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(e ? '{}' : d); });
  }

  // ----- compétition Joueurs -----
  if (P == '/api/lobby') {
    const us = me(), cid = Math.floor(now / H), nid = cid + 1, ns = db.slots[nid], out = { now, online: onlineCount() };
    if (!lobbyCache || lobbyCache.nid != nid || now - lobbyCache.t > 2000) { // un seul passage sur les inscrits, partagé entre tous les clients
      const byTier = {}, names = {}; let count = 0;
      if (ns) for (const [p, v] of Object.entries(ns.reg)) { byTier[v.tier] = (byTier[v.tier] || 0) + 1; count++; const l = names[v.tier] || (names[v.tier] = []); if (l.length < 40) l.push(p); }
      lobbyCache = { nid, t: now, byTier, names, count };
    }
    out.next = { id: nid, start: nid * H, opens: nid * H - REG, open: now >= nid * H - REG, count: lobbyCache.count, byTier: lobbyCache.byTier, names: us ? (lobbyCache.names[us.j.t] || []) : [], me: us && ns && ns.reg[us.pseudo] ? { tier: ns.reg[us.pseudo].tier } : null };
    if (us) {
      for (const id of [cid, cid - 1]) { // créneau en cours (ou qui vient de finir) auquel je participe
        const s = db.slots[id]; if (!s || !s.reg[us.pseudo] || now > id * H + 80 * MIN) continue; ensureDivs(id);
        out.cur = { id, start: id * H, st: [started(s, us.pseudo, 0), started(s, us.pseudo, 1)], done: [0, 1].map(r => !!((db.res[id] || {}).player || {})[us.pseudo] && !!db.res[id].player[us.pseudo].res[r]), div: s.divOf[us.pseudo] != null, final: !!s.fin };
        break;
      }
    }
    return send(200, out);
  }
  if (P == '/api/join' && POST) {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' }); wkSettle(us);
    const nid = Math.floor(now / H) + 1;
    if (now < nid * H - REG) return send(400, { err: 'les inscriptions ouvrent 15 min avant le début' });
    if (us.vac) return send(400, { err: 'tu es en mode vacances' });
    const s = slot(nid); if (!s.reg[us.pseudo]) s.reg[us.pseudo] = { tier: us.j.t, t: now };
    save(); lobbyCache = null; bcastLazy({ t: 'lobby' }); return send(200, { ok: 1, id: nid, start: nid * H, tier: s.reg[us.pseudo].tier });
  }
  if (P == '/api/leave' && POST) {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    const nid = Math.floor(now / H) + 1, s = db.slots[nid]; if (s) delete s.reg[us.pseudo]; save(); lobbyCache = null; bcastLazy({ t: 'lobby' }); return send(200, { ok: 1 });
  }
  if (P == '/api/start' && POST) { // je lance une manche : une seule fois, dans la fenêtre prévue
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    const b = await readBody(req), id = num(b.id, -1), r = b.r == 1 ? 1 : 0, s = ensureDivs(id);
    if (!s || !s.divs || s.divOf[us.pseudo] == null) return send(403, { err: 'tu n’es pas inscrit à cette compétition' });
    const t0 = id * H + r * 30 * MIN, lo = r ? t0 - 2 * MIN : t0, hi = r ? t0 + 15 * MIN : t0 + 3 * MIN;
    if (now < lo || now > hi) return send(403, { err: r ? 'la manche 2 ne peut plus être lancée' : 'trop tard : la compétition a commencé' });
    if (r == 1 && !started(s, us.pseudo, 0)) return send(403, { err: 'manche 1 non jouée' });
    const st = s.st[us.pseudo] = s.st[us.pseudo] || [0, 0];
    if (st[r]) return send(409, { err: 'cette manche a déjà été lancée', dup: 1 });
    st[r] = now; us.last = id; save();
    const d = s.divs[s.divOf[us.pseudo]];
    return send(200, { ok: 1, now, start: id * H, round0: t0, tier: d.tier, idx: d.idx, players: d.players });
  }
  if (P == '/api/progress' && POST) { // je publie mon score live, je reçois celui des autres joueurs de ma division
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    const b = await readBody(req, 2e4), id = num(b.id, -1), r = b.r == 1 ? 1 : 0, s = db.slots[id];
    if (!s || !s.divs || s.divOf[us.pseudo] == null) return send(403, { err: 'pas dans cette compétition' });
    const g = s.prog[us.pseudo];
    if (started(s, us.pseudo, r) && now <= id * H + (r + 1) * 30 * MIN + 2 * MIN && (!g || now - g.t > 1500)) s.prog[us.pseudo] = { r, sc: Math.max(-70, Math.min(70, num(b.sc))), ret: Math.max(-1, Math.min(10, num(b.ret))), t: now };
    const d = s.divs[s.divOf[us.pseudo]], live = d.players.filter(p => p != us.pseudo && (started(s, p, 0) || now < id * H + 3 * MIN)).map(p => {
      const q = s.prog[p], pr = ((db.res[id] || {}).player || {})[p], rs = (pr && pr.res) || [];
      let ret = 0; if (rs[r]) ret = rs[r].ret; else if (q && q.r == r) ret = q.ret; return { n: p, r: ret };
    });
    return send(200, { now, live });
  }
  if (P == '/api/standings') { // classement de ma division (live, provisoire ou final) ; sans id = ma dernière compétition
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' });
    const id = u.searchParams.get('id') != null ? num(u.searchParams.get('id'), -1) : us.last;
    const s = id != null ? ensureDivs(id) : null; if (!s || !s.divs || s.divOf[us.pseudo] == null) return send(200, { none: 1 });
    const R = rows(id, s.divOf[us.pseudo]); return send(200, { id, start: id * H, final: !!s.fin, tier: R.tier, rows: R.rows });
  }
  if (P == '/api/ladder') { // joueurs par ligue (aperçu public)
    if (!ladderCache || now - ladderCache.t > 10000) ladderCache = { t: now, d: Object.values(db.users).map(x => ({ name: x.pseudo, t: ensure(x).j.t, n: x.j.h.length })).sort((a, b) => a.t - b.t || b.n - a.n).slice(0, 100) };
    return send(200, ladderCache.d);
  }

  // ----- résultats (Arenbot + manches de compétition) -----
  if (P == '/api/submit' && POST) {
    const us = me(); if (!us) return send(401, { err: 'connecte-toi' }); const meN = us.pseudo;
    const b = await readBody(req), id = num(b.id, -1), k = b.kind == 'player' ? 'player' : 'bot', ri = b.round === 1 ? 1 : 0;
    const v = checkResult(b.res, k);
    if (v.err) { flag(meN, k, id, v.err, b.res); return send(400, { err: v.err }); }
    const r = v.o; let tier = num(b.tier);
    if (k == 'player') { // manche officielle : doit avoir été lancée, une seule soumission, dans les temps
      const s = db.slots[id]; if (!s || !started(s, meN, ri)) return send(403, { err: 'manche non lancée' });
      const end = id * H + (ri + 1) * 30 * MIN;
      if (now > end + 5 * MIN) return send(400, { err: 'manche expirée' });
      // une manche complète dure 30 min de marché : un résultat « terminé » ne peut pas arriver avant la fin (tolérance 30 s)
      if (!r.liq && now < end - 30e3) { flag(meN, k, id, 'envoyé avant la fin de la manche', b.res); return send(400, { err: 'manche non terminée' }); }
      if (r.liq && now < s.st[meN][ri] + 3000) return send(400, { err: 'résultat trop rapide' });
      const ex = ((db.res[id] || {}).player || {})[meN]; if (ex && ex.res[ri]) return send(409, { err: 'manche déjà envoyée' });
      tier = s.reg[meN] ? s.reg[meN].tier : 8;
      if (r.sus) flag(meN, k, id, 'série de TP statistiquement improbable (accepté, à examiner)', null);
    } else if (id < cur() - 1 || id > cur()) return send(400, { err: 'manche expirée ou résultat invalide' });
    const slotR = ((db.res[id] = db.res[id] || {})[k] = db.res[id][k] || {});
    delete r.sus; (slotR[meN] = slotR[meN] || { t: now, res: [] }).res[ri] = r; slotR[meN].t = now; slotR[meN].tier = tier; save();
    bcastLazy({ t: 'sub', id, k }); return send(200, { ok: 1 });
  }
  if (P == '/api/results') {
    const tier = u.searchParams.get('tier'), id = u.searchParams.get('id'), k = u.searchParams.get('kind') == 'player' ? 'player' : 'bot', s = (db.res[id] || {})[k] || {};
    return send(200, Object.entries(s).filter(([, v]) => v.res[0] && v.res[1] && v.res[0].eq && (tier == null || String(v.tier) == tier)).sort((a, b) => b[1].t - a[1].t).slice(0, 40).map(([name, v]) => ({ name, res: v.res })));
  }
  if (P == '/api/league') { // classement général : cumul archivé + créneaux encore détaillés (mis en cache 30 s)
    const k = u.searchParams.get('kind') == 'player' ? 'player' : 'bot', c = leagueCache[k];
    if (c && now - c.t < 30000) return send(200, c.d);
    const A = {}; for (const [n, v] of Object.entries(db.agg[k] || {})) A[n] = { name: n, pts: v.pts, n: v.n, ret: v.ret };
    for (const id in db.res) for (const [n, v] of Object.entries(db.res[id][k] || {})) if (v.res[0] && v.res[1]) {
      const a = A[n] || (A[n] = { name: n, pts: 0, n: 0, ret: 0 }); a.pts += v.res[0].sc + v.res[1].sc; a.ret += v.res[0].ret + v.res[1].ret; a.n++;
    }
    const d = Object.values(A).sort((a, b) => b.pts - a.pts || b.ret - a.ret).slice(0, 100); leagueCache[k] = { t: now, d };
    return send(200, d);
  }
  if (P == '/api/champ/ranking') { // palmarès mondial de la Ligue des Traders : titres, podiums, finales (cache 30 s)
    if (!champRankCache || now - champRankCache.t > 30000) {
      const rows = Object.values(db.users).map(x => { const r = x.rew || []; return { name: x.pseudo, champ: r.filter(w => w.k == 'champion').length, pod: r.filter(w => w.k == 'podium').length, fin: r.filter(w => w.k == 'finaliste').length }; })
        .filter(o => o.champ + o.pod + o.fin > 0).sort((a, b) => b.champ - a.champ || b.pod - a.pod || b.fin - a.fin || (a.name < b.name ? -1 : 1)).slice(0, 100);
      champRankCache = { t: now, d: { rows, hist: (db.champH || []).slice(-10).reverse() } };
    }
    return send(200, champRankCache.d);
  }
  send(404, { err: 'inconnu' });
}

// page HTML : lue et compressée une seule fois (relue si le fichier change), ETag pour les rechargements (304)
let page = null;
function loadPage() {
  try { const st = fs.statSync(HTML); if (page && page.m == st.mtimeMs) return; const d = fs.readFileSync(HTML);
    page = { m: st.mtimeMs, d, gz: zlib.gzipSync(d, { level: 9 }), tag: '"' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 16) + '"' }; } catch (e) { if (!page) page = null; }
}
loadPage(); setInterval(loadPage, 5000);
function serveHtml(req, res) {
  if (!page) { res.writeHead(404); return res.end('backtest-arena.html introuvable à côté du serveur'); }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: page.tag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] == page.tag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, Object.assign(h, { 'Content-Encoding': 'gzip' })); res.end(page.gz); }
  else { res.writeHead(200, h); res.end(page.d); }
}

// données de marché réelles (fichiers .bin générés par tools/csv2bin.py) : compressées une fois, mises en cache, ETag
const BINS = {};
function serveBin(req, res, name) {
  let b = BINS[name];
  if (!b) { try { const d = fs.readFileSync(path.join(__dirname, 'data', name)); b = BINS[name] = { gz: zlib.gzipSync(d, { level: 9 }), tag: '"' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 16) + '"' }; } catch (e) { res.writeHead(404); return res.end('introuvable'); } }
  const h = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', ETag: b.tag, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] == b.tag) { res.writeHead(304, h); return res.end(); }
  res.writeHead(200, h); res.end(b.gz);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.method == 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname == '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    if (/^\/data\/[a-z0-9-]+\.bin$/.test(u.pathname)) return serveBin(req, res, u.pathname.slice(6));
    serveHtml(req, res);
  } catch (e) {
    const code = e && e.code == 503 ? 503 : 400;
    if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ err: e.message }));
  }
});
server.keepAliveTimeout = 65e3; server.headersTimeout = 70e3; // > délai d'inactivité des proxys (évite les 502 aléatoires)
server.listen(PORT, () => console.log('Arène en ligne sur http://localhost:' + PORT + ' · données : ' + DATA_DIR));
setInterval(() => { for (const c of clients.keys()) try { c.write(': ping\n\n'); } catch (e) {} }, 25000);
setInterval(() => { try { tickSlots(); } catch (e) { console.error('tick', e); } }, +process.env.TICK_MS || 20000); try { tickSlots(); } catch (e) { console.error('tick', e); }
process.on('uncaughtException', e => console.error('uncaught', e));
process.on('unhandledRejection', e => console.error('unhandled', e));
const bye = () => { try { fs.writeFileSync(DBF, JSON.stringify(db)); } catch (e) {} process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
