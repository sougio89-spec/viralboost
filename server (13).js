const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const nodemailer = require('nodemailer');

// ════════════════════════════════════════
// ── EMAIL SYSTEM (Brevo SMTP)
// ════════════════════════════════════════

const mailer = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN,   // your Brevo SMTP login (email)
    pass: process.env.BREVO_SMTP_KEY,     // your Brevo SMTP key
  },
});

const FROM_EMAIL = 'ViralBoost <contact@viralboost.fr>';

// ── Welcome email (sent on signup) ──
async function sendWelcomeEmail(user) {
  const { email, name } = user;
  const firstName = (name || 'Creator').split(' ')[0];
  try {
    await mailer.sendMail({
      from: FROM_EMAIL,
      to: email,
      subject: '🚀 Welcome to ViralBoost — You\'re in!',
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to ViralBoost</title>
</head>
<body style="margin:0;padding:0;background:#05040f;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#05040f;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0e0c1e;border-radius:16px;border:1px solid rgba(129,140,248,0.2);overflow:hidden;max-width:600px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:40px;text-align:center;">
          <img src="https://viralboost.fr/icon-192.png" alt="ViralBoost" width="72" height="72" style="border-radius:16px;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;">
          <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;">⚡ ViralBoost</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;letter-spacing:2px;text-transform:uppercase;">Free Ad Platform for Creators</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          <h1 style="color:#f0f0ff;font-size:26px;margin:0 0 16px;font-weight:800;">Hey ${firstName}, welcome aboard! 🎉</h1>
          <p style="color:#a5b4fc;font-size:15px;line-height:1.7;margin:0 0 24px;">
            Your ViralBoost account is live. You can now publish your ads, find sponsorships, connect with other creators and start growing your audience — all for free.
          </p>

          <!-- What you can do -->
          <div style="background:#131128;border-radius:12px;padding:24px;margin-bottom:28px;border:1px solid rgba(129,140,248,0.15);">
            <div style="color:#818cf8;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;">What you can do now</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:8px 0;color:#c7d2fe;font-size:14px;">📢 &nbsp;<strong>Publish your first ad</strong> in 30 seconds</td></tr>
              <tr><td style="padding:8px 0;color:#c7d2fe;font-size:14px;">🤝 &nbsp;<strong>Find sponsorships & partnerships</strong> with other creators</td></tr>
              <tr><td style="padding:8px 0;color:#c7d2fe;font-size:14px;">💰 &nbsp;<strong>Earn money</strong> through collabs and brand deals</td></tr>
              <tr><td style="padding:8px 0;color:#c7d2fe;font-size:14px;">📈 &nbsp;<strong>Grow your audience</strong> with 12,000+ active creators</td></tr>
            </table>
          </div>

          <!-- CTA Button -->
          <div style="text-align:center;margin-bottom:28px;">
            <a href="https://viralboost.fr" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-size:16px;font-weight:800;padding:16px 40px;border-radius:12px;text-decoration:none;letter-spacing:0.5px;">
              🚀 Start Publishing for Free
            </a>
          </div>

          <p style="color:#5a567a;font-size:13px;line-height:1.6;margin:0;">
            You can log in anytime using this email address: <strong style="color:#818cf8;">${email}</strong>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#080714;padding:24px 40px;border-top:1px solid rgba(129,140,248,0.1);text-align:center;">
          <p style="color:#37345a;font-size:12px;margin:0;">© ${new Date().getFullYear()} ViralBoost · <a href="https://viralboost.fr" style="color:#4f46e5;text-decoration:none;">viralboost.fr</a></p>
          <p style="color:#2a2845;font-size:11px;margin:8px 0 0;">You received this email because you signed up on ViralBoost.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log(`📧 Welcome email sent → ${email}`);
  } catch(e) {
    console.error(`❌ Welcome email failed for ${email}:`, e.message);
  }
}

// ── Re-engagement email (sent after 24h inactivity) ──
async function sendReEngagementEmail(user) {
  const { email, name } = user;
  const firstName = (name || 'Creator').split(' ')[0];
  try {
    await mailer.sendMail({
      from: FROM_EMAIL,
      to: email,
      subject: `${firstName}, your audience is waiting for you 👀`,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Come back to ViralBoost</title>
</head>
<body style="margin:0;padding:0;background:#05040f;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#05040f;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#0e0c1e;border-radius:16px;border:1px solid rgba(129,140,248,0.2);overflow:hidden;max-width:600px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#0f172a,#1e1b4b);padding:40px;text-align:center;border-bottom:1px solid rgba(129,140,248,0.15);">
          <img src="https://viralboost.fr/icon-192.png" alt="ViralBoost" width="72" height="72" style="border-radius:16px;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;">
          <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;">⚡ ViralBoost</div>
          <div style="font-size:48px;margin-top:16px;">👀</div>
          <h2 style="color:#f0f0ff;font-size:22px;font-weight:800;margin:12px 0 0;">We miss you, ${firstName}</h2>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          <p style="color:#a5b4fc;font-size:15px;line-height:1.7;margin:0 0 24px;">
            It's been 24 hours since you last visited. While you were away, creators on ViralBoost were publishing ads, landing sponsorships and growing their audiences.
          </p>
          <p style="color:#a5b4fc;font-size:15px;line-height:1.7;margin:0 0 28px;">
            Don't miss out — your next collab, brand deal or audience spike could be one click away.
          </p>

          <!-- Stats block -->
          <div style="background:#131128;border-radius:12px;padding:24px;margin-bottom:28px;border:1px solid rgba(129,140,248,0.15);text-align:center;">
            <div style="color:#818cf8;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:20px;">What's happening right now</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="text-align:center;padding:8px;">
                  <div style="font-size:28px;font-weight:900;color:#f0f0ff;">12,000+</div>
                  <div style="font-size:11px;color:#5a567a;margin-top:4px;">Active Creators</div>
                </td>
                <td style="text-align:center;padding:8px;">
                  <div style="font-size:28px;font-weight:900;color:#f0f0ff;">30s</div>
                  <div style="font-size:11px;color:#5a567a;margin-top:4px;">To Publish</div>
                </td>
                <td style="text-align:center;padding:8px;">
                  <div style="font-size:28px;font-weight:900;color:#f0f0ff;">100%</div>
                  <div style="font-size:11px;color:#5a567a;margin-top:4px;">Free Forever</div>
                </td>
              </tr>
            </table>
          </div>

          <!-- CTA Button -->
          <div style="text-align:center;margin-bottom:28px;">
            <a href="https://viralboost.fr" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-size:16px;font-weight:800;padding:16px 40px;border-radius:12px;text-decoration:none;letter-spacing:0.5px;">
              ⚡ Come Back & Grow
            </a>
          </div>

          <p style="color:#5a567a;font-size:13px;line-height:1.6;margin:0;text-align:center;">
            Publish ads · Find sponsorships · Earn money · Grow your audience
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#080714;padding:24px 40px;border-top:1px solid rgba(129,140,248,0.1);text-align:center;">
          <p style="color:#37345a;font-size:12px;margin:0;">© ${new Date().getFullYear()} ViralBoost · <a href="https://viralboost.fr" style="color:#4f46e5;text-decoration:none;">viralboost.fr</a></p>
          <p style="color:#2a2845;font-size:11px;margin:8px 0 0;">
            You received this because you have an account on ViralBoost. 
            <a href="https://viralboost.fr" style="color:#37345a;">Unsubscribe</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log(`📧 Re-engagement email sent → ${email}`);
    return true;
  } catch(e) {
    console.error(`❌ Re-engagement email failed for ${email}:`, e.message);
    return false;
  }
}

// ── 24h inactivity check — runs every hour ──
setInterval(async () => {
  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const TWO_HOURS_BUFFER  = 2  * 60 * 60 * 1000; // avoid sending twice

  for (const [email, user] of db.users) {
    if (user.banned) continue;
    if (user.reEngagementSent) continue; // already sent once today

    const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : new Date(user.createdAt).getTime();
    const inactive = now - lastSeen;

    if (inactive >= TWENTY_FOUR_HOURS && inactive <= TWENTY_FOUR_HOURS + TWO_HOURS_BUFFER) {
      const sent = await sendReEngagementEmail(user);
      if (sent) {
        user.reEngagementSent = new Date().toISOString();
        db.users.set(email, user);
      }
    }

    // Reset reEngagementSent daily so they can receive it again if inactive again
    if (user.reEngagementSent) {
      const sentAt = new Date(user.reEngagementSent).getTime();
      if (now - sentAt > TWENTY_FOUR_HOURS) {
        user.reEngagementSent = null;
        db.users.set(email, user);
      }
    }
  }
}, 60 * 60 * 1000); // every hour

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── SITEMAP.XML + ROBOTS.TXT — AVANT express.static ──
// Ces routes doivent être déclarées AVANT app.use(express.static(...))
// sinon les fichiers physiques sitemap.xml / robots.txt du dossier prennent le dessus
app.get('/sitemap.xml', (req, res) => {
  const now = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://viralboost.fr/</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

// Disallow sous-routes SPA → évite que Google indexe des doublons canoniques
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /dashboard\n' +
    'Disallow: /profile\n' +
    'Disallow: /settings\n' +
    'Disallow: /admin\n' +
    'Sitemap: https://viralboost.fr/sitemap.xml'
  );
});

app.use(express.static(path.join(__dirname, '.')));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ════════════════════════════════════════
// ── PERSISTANCE FICHIER JSON (sans MongoDB)
// ── Toutes les données sont sauvegardées dans data.json
// ── Au redémarrage du serveur, tout est rechargé automatiquement
// ════════════════════════════════════════

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch(e) {
    console.log('⚠️  data.json illisible, on repart de zéro');
  }
  return { users: {}, posts: [], projects: [], groups: {}, groupMessages: {}, reports: [], adminDMs: [], chatMessages: [], votes: {} };
}

function saveData() {
  try {
    const snapshot = {
      users:        Object.fromEntries(db.users),
      posts:        db.posts,
      projects:     db.projects,
      groups:       Object.fromEntries(db.groups),
      groupMessages:Object.fromEntries(db.groupMessages),
      reports:      db.reports,
      adminDMs:     db.adminDMs,
      chatMessages: db.chatMessages.slice(-200), // garder les 200 derniers
      votes:        Object.fromEntries(
                      [...db.votes].map(([k,v]) => [k, [...v]])
                    ),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  } catch(e) {
    console.error('❌ Erreur sauvegarde data.json:', e.message);
  }
}

// Sauvegarde auto toutes les 30 secondes
setInterval(saveData, 30000);

// Sauvegarde propre à l'arrêt du serveur
process.on('SIGTERM', () => { saveData(); process.exit(0); });
process.on('SIGINT',  () => { saveData(); process.exit(0); });

// ── Charger les données au démarrage ──
const raw = loadData();
const db = {
  users:        new Map(Object.entries(raw.users || {})),
  posts:        raw.posts || [],
  projects:     raw.projects || [],
  groups:       new Map(Object.entries(raw.groups || {})),
  groupMessages:new Map(Object.entries(raw.groupMessages || {})),
  reports:      raw.reports || [],
  adminDMs:     raw.adminDMs || [],
  chatMessages: raw.chatMessages || [],
  votes:        new Map(Object.entries(raw.votes || {}).map(([k,v]) => [k, new Set(v)])),
};

console.log(`✅ Données chargées : ${db.users.size} users · ${db.posts.length} posts · ${db.projects.length} projets · ${db.chatMessages.length} msgs chat`);

// ── PLANS ──
const PLANS = {
  free:    { name: 'FREE',    price: 0,    limits: { pubsPerHour: 1,   chatMsgs: 3,   vitrineHours: 1       } },
  starter: { name: 'STARTER', price: 300,  limits: { pubsPerDay: 3,    chatMsgs: 10,  vitrineHours: 168     } },
  pro:     { name: 'PRO',     price: 1499, limits: { pubsPerDay: 999,  chatMsgs: 999, vitrineHours: 720     } },
  elite:   { name: 'ELITE',   price: 3999, limits: { pubsPerDay: 999,  chatMsgs: 999, vitrineHours: 9999999 } },
};

// ════════════════════════════════════════
// ── WEBSOCKET — TEMPS RÉEL
// ════════════════════════════════════════

const userSockets = new Map();   // userId -> Set<ws>
const onlineUsers = new Map();   // userId -> { name, plan, avatar }
const dmThreads   = new Map();   // "userA:userB" -> [msgs]

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function sendToUser(userId, data) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const msg = JSON.stringify(data);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function getDMKey(a, b) { return [a, b].sort().join(':'); }

wss.on('connection', (ws) => {
  let connectedUserId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    switch(data.type) {

      case 'join': {
        connectedUserId = data.userId;
        if (!userSockets.has(data.userId)) userSockets.set(data.userId, new Set());
        userSockets.get(data.userId).add(ws);
        onlineUsers.set(data.userId, { id: data.userId, name: data.name || 'Anonyme', plan: data.plan || 'free', avatar: data.avatar || '👤' });

        // Envoyer l'historique chat (50 derniers messages)
        ws.send(JSON.stringify({ type: 'history', messages: db.chatMessages.slice(-50) }));

        // Envoyer les projets existants
        ws.send(JSON.stringify({ type: 'projects_history', projects: [...db.projects].sort((a,b)=>(b.votes||0)-(a.votes||0)).slice(0,50) }));

        // Envoyer les posts existants
        ws.send(JSON.stringify({ type: 'posts_history', posts: db.posts.slice(0, 50) }));

        broadcastToAll({ type: 'online_users', users: Array.from(onlineUsers.values()) });
        break;
      }

      case 'message': {
        if (!connectedUserId) return;
        const msg = {
          id: 'msg_' + Date.now(),
          userId: connectedUserId,
          name: data.name || 'Anonyme',
          plan: data.plan || 'free',
          text: (data.text || '').slice(0, 500),
          timestamp: new Date().toISOString(),
          isAdmin: data.isAdmin || false,
        };
        db.chatMessages.push(msg);
        if (db.chatMessages.length > 200) db.chatMessages.shift();
        broadcastToAll({ type: 'message', message: msg });
        break;
      }

      case 'dm': {
        if (!connectedUserId) return;
        const toId = data.toId;
        if (!toId || toId === connectedUserId) return;
        const dmMsg = {
          id: 'dm_' + Date.now(),
          fromId: connectedUserId,
          fromName: data.fromName || 'Anonyme',
          fromPlan: data.fromPlan || 'free',
          toId,
          text: (data.text || '').slice(0, 500),
          timestamp: new Date().toISOString(),
        };
        const key = getDMKey(connectedUserId, toId);
        if (!dmThreads.has(key)) dmThreads.set(key, []);
        dmThreads.get(key).push(dmMsg);
        sendToUser(toId, { type: 'dm', message: dmMsg });
        sendToUser(connectedUserId, { type: 'dm_sent', message: dmMsg });
        break;
      }

      case 'get_dm_history': {
        if (!connectedUserId) return;
        const key = getDMKey(connectedUserId, data.withId);
        ws.send(JSON.stringify({ type: 'dm_history', withId: data.withId, messages: dmThreads.get(key) || [] }));
        break;
      }

      case 'typing': {
        if (!connectedUserId) return;
        broadcastToAll({ type: 'typing', userId: connectedUserId, name: data.name, isTyping: data.isTyping });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (connectedUserId) {
      const sockets = userSockets.get(connectedUserId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(connectedUserId);
          onlineUsers.delete(connectedUserId);
          broadcastToAll({ type: 'online_users', users: Array.from(onlineUsers.values()) });
        }
      }
    }
  });
});

// ════════════════════════════════════════
// ── API ROUTES
// ════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── USERS ──
app.post('/api/register-user', async (req, res) => {
  try {
    const { name, email, plan, username, avatar, createdAt } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const existing = db.users.get(email) || {};
    const isNewUser = !existing.email; // true if first time registering
    const user = {
      ...existing,
      name, email, username, plan: plan || 'free', avatar,
      projectsCount: existing.projectsCount || 0,
      createdAt: existing.createdAt || createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    db.users.set(email, user);
    saveData();
    // Send welcome email only on first signup
    if (isNewUser) sendWelcomeEmail(user);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Track last seen (call this on every login) ──
app.post('/api/ping', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = db.users.get(email);
    if (user) {
      user.lastSeenAt = new Date().toISOString();
      user.reEngagementSent = null; // reset so they can get the email again after next 24h absence
      db.users.set(email, user);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/:email', (req, res) => {
  const user = db.users.get(req.params.email);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  res.json(user);
});

// ── POSTS (fil d'actualité) ──
app.get('/api/posts', (req, res) => {
  res.json(db.posts.slice(0, 100));
});

app.post('/api/posts', (req, res) => {
  try {
    const post = { ...req.body, createdAt: new Date().toISOString(), id: req.body.id || ('post_' + Date.now()) };
    db.posts.unshift(post);
    if (db.posts.length > 500) db.posts.pop();
    saveData();
    broadcastToAll({ type: 'new_post', post });
    res.json({ ok: true, post });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/like', (req, res) => {
  try {
    const post = db.posts.find(p => p.id === req.params.id);
    if (post) {
      post.likes = (post.likes || 0) + 1;
      broadcastToAll({ type: 'like_update', postId: req.params.id, likes: post.likes });
      saveData();
    }
    res.json({ ok: true, likes: post?.likes || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/share', (req, res) => {
  try {
    const post = db.posts.find(p => p.id === req.params.id);
    if (post) { post.shares = (post.shares || 0) + 1; }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', (req, res) => {
  db.posts = db.posts.filter(p => p.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// ── PROJETS VITRINE ──
app.get('/api/projects', (req, res) => {
  res.json([...db.projects].sort((a, b) => (b.votes || 0) - (a.votes || 0)));
});

app.post('/api/projects', (req, res) => {
  try {
    const proj = { ...req.body, votes: 0, views: 0, createdAt: new Date().toISOString(), id: req.body.id || ('proj_' + Date.now()) };
    db.projects.unshift(proj);
    if (db.projects.length > 200) db.projects.pop();
    saveData();
    broadcastToAll({ type: 'new_project', project: proj });
    res.json({ ok: true, project: proj });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/vote', (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId requis' });
    if (!db.votes.has(id)) db.votes.set(id, new Set());
    if (db.votes.get(id).has(userId)) return res.json({ ok: false, reason: 'already_voted' });
    db.votes.get(id).add(userId);
    const proj = db.projects.find(p => p.id === id);
    if (proj) { proj.votes = (proj.votes || 0) + 1; }
    saveData();
    broadcastToAll({ type: 'vote_update', projectId: id, votes: proj?.votes || 1 });
    res.json({ ok: true, votes: proj?.votes || 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
  const { key } = req.body || {};
  if (key !== (process.env.ADMIN_KEY || 'viralboost-admin')) return res.status(403).json({ error: 'Accès refusé' });
  db.projects = db.projects.filter(p => p.id !== req.params.id);
  saveData();
  broadcastToAll({ type: 'project_deleted', projectId: req.params.id });
  res.json({ ok: true });
});

// ── GROUPES ──
app.get('/api/groups', (req, res) => {
  res.json([...db.groups.values()].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/groups', (req, res) => {
  try {
    const group = { ...req.body, id: req.body.id || ('grp_' + Date.now()), createdAt: new Date().toISOString(), membersCount: 1 };
    db.groups.set(group.id, group);
    saveData();
    broadcastToAll({ type: 'new_group', group });
    res.json({ ok: true, group });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:id/messages', (req, res) => {
  res.json(db.groupMessages.get(req.params.id) || []);
});

app.post('/api/groups/:id/messages', (req, res) => {
  try {
    const msg = { ...req.body, groupId: req.params.id, timestamp: new Date().toISOString() };
    if (!db.groupMessages.has(req.params.id)) db.groupMessages.set(req.params.id, []);
    db.groupMessages.get(req.params.id).push(msg);
    saveData();
    broadcastToAll({ type: 'group_message', groupId: req.params.id, message: msg });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/groups/:id/settings', (req, res) => {
  try {
    const { settings, requesterId } = req.body;
    const group = db.groups.get(req.params.id);
    if (group && group.creatorId === requesterId) {
      Object.assign(group, settings);
      db.groups.set(req.params.id, group);
      saveData();
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SIGNALEMENTS ──
app.post('/api/report', (req, res) => {
  try {
    const report = { ...req.body, createdAt: new Date().toISOString(), id: 'rep_' + Date.now(), status: 'pending' };
    db.reports.push(report);
    saveData();
    console.log(`🚨 SIGNALEMENT: ${report.reporterEmail} → ${report.reportedName} | ${report.reason}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DM ADMIN ──
app.post('/api/admin-dm', (req, res) => {
  try {
    const dm = { ...req.body, createdAt: new Date().toISOString(), id: 'adm_' + Date.now(), read: false };
    db.adminDMs.push(dm);
    saveData();
    console.log(`📩 DM ADMIN de ${dm.fromEmail} (${dm.fromPlan}): ${dm.text}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contact-admin', (req, res) => {
  try {
    const dm = { ...req.body, createdAt: new Date().toISOString(), id: 'adm_' + Date.now() };
    db.adminDMs.push(dm);
    saveData();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IA BOOST ──
app.post('/api/generate-boost', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: req.body.prompt }]
    });
    res.json({ content: response.content[0].text.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia-boost', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: req.body.description || req.body.prompt || 'Analyse' }]
    });
    res.json({ strategy: response.content[0].text.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat-promo', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      system: `Tu es un expert en marketing digital, growth hacking et promotion de projets en ligne. Tu donnes des conseils CONCRETS, ACTIONNABLES et PERSONNALISÉS. Tu réponds en français.`,
      messages: req.body.messages.slice(-10)
    });
    res.json({ reply: response.content[0].text.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAYMENT STRIPE ──
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { plan } = req.body;
    const planData = PLANS[plan];
    if (!planData || planData.price === 0) return res.status(400).json({ error: 'Plan invalide ou gratuit' });
    const pi = await stripe.paymentIntents.create({
      amount: planData.price,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { service: 'viralboost', plan }
    });
    res.json({ clientSecret: pi.client_secret });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── UPLOAD FICHIERS (images/vidéos) ──
const multer = require('multer');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

app.use('/uploads', express.static(uploadDir));

app.post('/api/upload', async (req, res) => {
  try {
    await upload.single('file')(req, res);
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    const url = '/uploads/' + req.file.filename;
    res.json({ url, filename: req.file.filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════
// ── ADMIN DASHBOARD (soug759@gmail.com)
// ════════════════════════════════════════

const ADMIN_KEY = process.env.ADMIN_KEY || 'viralboost-admin';

app.get('/api/admin/all-users', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  res.json(Array.from(db.users.values()));
});

app.get('/api/admin/reports', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  res.json([...db.reports].reverse());
});

app.get('/api/admin/dms', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  res.json([...db.adminDMs].reverse());
});

app.post('/api/admin/ban', (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  const user = db.users.get(req.body.email);
  if (user) { user.banned = true; user.bannedAt = new Date().toISOString(); saveData(); }
  sendToUser(req.body.email, { type: 'banned', message: 'Ton compte a été suspendu.' });
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('<h1>🚫 Accès refusé</h1>');

  const users    = Array.from(db.users.values()).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const reports  = [...db.reports].reverse().slice(0, 50);
  const adminDMs = [...db.adminDMs].reverse();
  const posts    = db.posts.slice(0, 30);
  const projects = db.projects.slice(0, 30);

  const total = users.length;
  const plans = { free: 0, starter: 0, pro: 0, elite: 0 };
  users.forEach(u => { const p = u.plan || 'free'; if (plans[p] !== undefined) plans[p]++; else plans.free++; });
  const revenue = (plans.starter * 3 + plans.pro * 14.99 + plans.elite * 39.99).toFixed(2);
  const payants = plans.starter + plans.pro + plans.elite;
  const today = new Date(); today.setHours(0,0,0,0);
  const newToday = users.filter(u => u.createdAt && new Date(u.createdAt) >= today).length;
  const now = new Date().toLocaleString('fr-FR');

  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ViralBoost — Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#030a04;color:#e8fef0;min-height:100vh;}
.topbar{background:#071009;border-bottom:1px solid rgba(34,197,94,.2);padding:16px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:99;}
.logo{font-size:20px;font-weight:900;background:linear-gradient(135deg,#22c55e,#86efac);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.live{display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:#4ade80;padding:5px 13px;border-radius:20px;font-size:11px;font-weight:700;}
.dot{width:7px;height:7px;background:#22c55e;border-radius:50%;animation:blink 1.5s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.wrap{max-width:1250px;margin:0 auto;padding:28px 24px;}
.meta{color:#2d5a38;font-size:11px;margin-bottom:24px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:36px;}
.card{background:#0a1609;border:1px solid rgba(34,197,94,.12);border-radius:14px;padding:20px;position:relative;overflow:hidden;}
.card::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--c,linear-gradient(90deg,#22c55e,#4ade80));}
.card.orange{--c:linear-gradient(90deg,#f97316,#fdba74);}
.card.blue{--c:linear-gradient(90deg,#3b82f6,#93c5fd);}
.card.purple{--c:linear-gradient(90deg,#a855f7,#d8b4fe);}
.card.gold{--c:linear-gradient(90deg,#eab308,#fde047);}
.card.red{--c:linear-gradient(90deg,#ef4444,#fca5a5);}
.card.teal{--c:linear-gradient(90deg,#14b8a6,#5eead4);}
.ico{font-size:26px;margin-bottom:8px;}
.num{font-size:34px;font-weight:900;color:#f0fdf4;line-height:1;}
.lbl{font-size:10px;color:#4a7a58;margin-top:5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
.sub{font-size:10px;color:#1a3a1e;margin-top:3px;}
.rev{font-size:28px;font-weight:900;color:#fbbf24;}
.sec{margin-bottom:36px;}
.sec-title{font-size:15px;font-weight:800;color:#22c55e;margin-bottom:12px;}
.tbl-wrap{background:#080f09;border:1px solid rgba(34,197,94,.1);border-radius:14px;overflow:auto;}
table{width:100%;border-collapse:collapse;min-width:600px;}
th{padding:11px 15px;text-align:left;font-size:10px;color:#4a7a58;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border-bottom:1px solid rgba(34,197,94,.08);}
td{padding:11px 15px;border-bottom:1px solid rgba(34,197,94,.04);font-size:13px;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
.bp{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:800;}
.bp.free{background:rgba(74,122,88,.18);color:#6b9e7a;border:1px solid rgba(74,122,88,.3);}
.bp.starter{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.25);}
.bp.pro{background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.3);}
.bp.elite{background:rgba(234,179,8,.12);color:#fbbf24;border:1px solid rgba(234,179,8,.3);}
.em{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);color:#4ade80;padding:2px 9px;border-radius:6px;font-size:11px;font-family:monospace;}
.btn{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#4ade80;padding:7px 16px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.empty{padding:32px;text-align:center;color:#1a3a1e;font-size:13px;}
.storage-info{background:rgba(34,197,94,.04);border:1px solid rgba(34,197,94,.12);border-radius:10px;padding:14px 18px;margin-bottom:24px;font-size:12px;color:#4a7a58;display:flex;align-items:center;gap:10px;}
</style></head><body>

<div class="topbar">
  <div style="display:flex;align-items:center;gap:12px;">
    <div class="logo">⚡ ViralBoost</div>
    <span style="background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:#4ade80;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:800">👑 ADMIN</span>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <div class="live"><span class="dot"></span>${onlineUsers.size} en ligne</div>
    <a href="/admin?key=${ADMIN_KEY}" class="btn">🔄 Actualiser</a>
  </div>
</div>

<div class="wrap">
  <div class="meta">🕐 ${now}</div>

  <div class="storage-info">
    💾 <strong>Mode fichier JSON</strong> — Toutes les données sont sauvegardées dans <code>data.json</code> sur le serveur Render. Aucune base de données requise. Sauvegarde automatique toutes les 30 secondes.
  </div>

  <div class="grid">
    <div class="card"><div class="ico">👥</div><div class="num">${total}</div><div class="lbl">Inscrits</div><div class="sub">+${newToday} aujourd'hui</div></div>
    <div class="card orange"><div class="ico">🆓</div><div class="num">${plans.free}</div><div class="lbl">FREE</div></div>
    <div class="card blue"><div class="ico">🚀</div><div class="num">${plans.starter}</div><div class="lbl">STARTER 3€</div><div class="sub">${(plans.starter*3).toFixed(0)}€</div></div>
    <div class="card purple"><div class="ico">💎</div><div class="num">${plans.pro}</div><div class="lbl">PRO 14,99€</div><div class="sub">${(plans.pro*14.99).toFixed(0)}€</div></div>
    <div class="card gold"><div class="ico">👑</div><div class="num">${plans.elite}</div><div class="lbl">ELITE 39,99€</div><div class="sub">${(plans.elite*39.99).toFixed(0)}€</div></div>
    <div class="card gold"><div class="ico">💰</div><div class="rev">${revenue}€</div><div class="lbl">Revenu mensuel</div><div class="sub">${payants} payant${payants>1?'s':''}</div></div>
    <div class="card teal"><div class="ico">💬</div><div class="num">${db.chatMessages.length}</div><div class="lbl">Msgs chat</div></div>
    <div class="card red"><div class="ico">🚨</div><div class="num">${reports.length}</div><div class="lbl">Signalements</div></div>
    <div class="card"><div class="ico">📢</div><div class="num">${db.posts.length}</div><div class="lbl">Publications</div></div>
    <div class="card"><div class="ico">✨</div><div class="num">${db.projects.length}</div><div class="lbl">Projets vitrine</div></div>
  </div>

  <!-- USERS -->
  <div class="sec">
    <div class="sec-title">👥 Utilisateurs — ${total}</div>
    <div class="tbl-wrap">
      ${!users.length ? '<div class="empty">Aucun utilisateur inscrit</div>' : `
      <table>
        <thead><tr><th>#</th><th>Nom</th><th>Email</th><th>Plan</th><th>Inscrit le</th><th>Statut</th></tr></thead>
        <tbody>${users.map((u,i) => `<tr>
          <td style="color:#2d5a38;font-size:11px">${i+1}</td>
          <td><strong>${u.name||'—'}</strong>${u.username?` <span style="color:#2d5a38;font-size:11px">@${u.username}</span>`:''}</td>
          <td><span class="em">${u.email}</span></td>
          <td><span class="bp ${u.plan||'free'}">${(u.plan||'free').toUpperCase()}</span></td>
          <td style="color:#4a7a58;font-size:12px">${u.createdAt?new Date(u.createdAt).toLocaleString('fr-FR'):'—'}</td>
          <td>${u.banned?'<span style="color:#f87171;font-weight:700">🚫 Banni</span>':'<span style="color:#22c55e;font-weight:700">✅ Actif</span>'}</td>
        </tr>`).join('')}</tbody>
      </table>`}
    </div>
  </div>

  <!-- SIGNALEMENTS -->
  ${reports.length ? `<div class="sec">
    <div class="sec-title">🚨 Signalements — ${reports.length}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Reporter</th><th>Signalé</th><th>Raison</th><th>Date</th></tr></thead>
      <tbody>${reports.map((r,i) => `<tr>
        <td style="color:#2d5a38;font-size:11px">${i+1}</td>
        <td><span class="em">${r.reporterEmail||r.reporterName||'?'}</span></td>
        <td style="color:#f87171;font-weight:700">${r.reportedName||r.reportedId||'?'}</td>
        <td><span class="bp free">${r.reason||'?'}</span></td>
        <td style="font-size:11px;color:#4a7a58">${r.createdAt?new Date(r.createdAt).toLocaleString('fr-FR'):'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>` : ''}

  <!-- DMs ADMIN -->
  ${adminDMs.length ? `<div class="sec">
    <div class="sec-title">📩 DMs Admin — ${adminDMs.length}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>De</th><th>Plan</th><th>Message</th><th>Date</th></tr></thead>
      <tbody>${adminDMs.map((d,i) => `<tr>
        <td style="color:#2d5a38;font-size:11px">${i+1}</td>
        <td><strong>${d.fromName||'?'}</strong><br><span class="em" style="font-size:10px">${d.fromEmail||''}</span></td>
        <td><span class="bp ${d.fromPlan||'free'}">${(d.fromPlan||'free').toUpperCase()}</span></td>
        <td style="max-width:300px;font-size:12px">${d.text||d.message||'—'}</td>
        <td style="font-size:11px;color:#4a7a58">${d.createdAt?new Date(d.createdAt).toLocaleString('fr-FR'):'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>` : ''}

  <!-- PUBLICATIONS RÉCENTES -->
  ${posts.length ? `<div class="sec">
    <div class="sec-title">📢 Publications récentes — ${db.posts.length} total</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Auteur</th><th>Plan</th><th>Contenu</th><th>Likes</th><th>Date</th></tr></thead>
      <tbody>${posts.map((p,i) => `<tr>
        <td style="color:#2d5a38;font-size:11px">${i+1}</td>
        <td><strong>${p.author||'?'}</strong></td>
        <td><span class="bp ${p.plan||'free'}">${(p.plan||'free').toUpperCase()}</span></td>
        <td style="max-width:300px;font-size:12px;color:#6b9e7a">${(p.text||'').slice(0,100)}${(p.text||'').length>100?'...':''}</td>
        <td style="color:#4ade80;font-weight:700">❤️ ${p.likes||0}</td>
        <td style="font-size:11px;color:#4a7a58">${p.createdAt?new Date(p.createdAt).toLocaleString('fr-FR'):'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>` : ''}

  <div style="margin-top:24px;padding:14px;background:rgba(255,215,0,.04);border:1px solid rgba(255,215,0,.1);border-radius:8px;font-size:11px;color:#4a7a58;text-align:center">
    👑 Admin réservé à soug759@gmail.com · ViralBoost v2 · Fichier data.json · Aucune base de données requise
  </div>
</div>
</body></html>`);
});

// ── HEALTH CHECK (obligatoire pour Render + monitoring) ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), users: db.users.size, posts: db.posts.length, ts: Date.now() });
});

// ── FALLBACK SPA — SEO CANONIQUE ──
// Les bots Google ne comprennent pas les fragments (#), mais peuvent crawler /dashboard, /profile, etc.
// On redirige toute URL "page" non-racine vers la canonique https://viralboost.fr/
// Les fichiers statiques sont déjà gérés par express.static plus haut.
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|json|xml|txt|map)$/i;

app.get('*', (req, res) => {
  // Laisser passer les fichiers statiques
  if (STATIC_EXTENSIONS.test(req.path)) {
    return res.status(404).send('Not found');
  }

  // Toute URL autre que "/" est une vue SPA → redirection 301 vers la canonique
  // Cela évite que Google indexe /dashboard, /profile, etc. comme pages distinctes
  if (req.path !== '/') {
    return res.redirect(301, 'https://viralboost.fr/');
  }

  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── DÉMARRAGE — 0.0.0.0 OBLIGATOIRE pour Render ──
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Render exige 0.0.0.0, jamais localhost

server.listen(PORT, HOST, () => {
  console.log(`✅ ViralBoost démarré sur http://${HOST}:${PORT}`);
  console.log(`📊 Admin : /admin?key=${process.env.ADMIN_KEY || 'viralboost-admin'}`);
  console.log(`💾 Persistance : data.json`);
  console.log(`🌐 Health : /health`);
});
