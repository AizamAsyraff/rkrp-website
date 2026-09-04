require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const port = Number(process.env.PORT || 3000);
const discordApi = 'https://discord.com/api/v10';
const required = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_WHITELIST_ROLE_ID'
];

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './' }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30  // 30 days
  }
}));
app.use(express.static('public', { index: false }));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard.html');
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

const configured = () => required.every((key) => process.env[key] && !process.env[key].startsWith('PASTE_'));
const authHeaders = () => ({ Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` });

// Cache TTL: 5 minutes for claim status to avoid hammering Discord API
const CLAIM_CACHE_TTL = 5 * 60 * 1000;

app.get('/auth/discord', (req, res) => {
  if (!configured()) return res.redirect('/?error=config');
  if (req.session.oauthStartedAt && Date.now() - req.session.oauthStartedAt < 30_000) return res.redirect('/?error=wait');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.oauthStartedAt = Date.now();
  const query = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
    state
  });
  res.redirect(`${discordApi}/oauth2/authorize?${query}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  if (!req.query.code || req.query.state !== req.session.oauthState) return res.redirect('/?error=auth');
  try {
    const tokenResponse = await fetch(`${discordApi}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    const tokenBody = await tokenResponse.text();
    if (!tokenResponse.ok) {
      console.error(`Discord OAuth exchange failed (${tokenResponse.status}): ${tokenBody}`);
      throw new Error('OAuth token exchange failed');
    }
    const token = JSON.parse(tokenBody);
    const profileResponse = await fetch(`${discordApi}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!profileResponse.ok) throw new Error('Unable to read Discord profile');
    req.session.user = await profileResponse.json();
    req.session.accessToken = token.access_token;
    // Clear any cached claim status so it refreshes after login
    delete req.session.claimCache;
    delete req.session.oauthState;
    delete req.session.oauthStartedAt;
    res.redirect('/dashboard.html');
  } catch (error) {
    console.error(error.message);
    res.redirect('/?error=auth');
  }
});

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null, configured: configured() }));

app.get('/api/server-status', async (_, res) => {
  try {
    const join = await fetch('https://cfx.re/join/ler7ry4');
    const endpoint = join.headers.get('x-citizenfx-url');
    if (!endpoint) throw new Error('FiveM endpoint unavailable');
    const baseUrl = new URL(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    const [playersResponse, infoResponse] = await Promise.all([
      fetch(new URL('players.json', baseUrl)),
      fetch(new URL('info.json', baseUrl))
    ]);
    if (!playersResponse.ok || !infoResponse.ok) throw new Error('FiveM status unavailable');
    const players = await playersResponse.json();
    const info = await infoResponse.json();
    const playerList = Array.isArray(players) ? players.slice(0, 100) : [];
    res.json({ online: true, onlinePlayers: playerList.length, maxPlayers: Number(info.vars?.sv_maxClients ?? 0), players: playerList.map((p) => ({ name: String(p.name || 'Unknown').slice(0, 48), ping: Number(p.ping || 0) })) });
  } catch { res.json({ online: false, onlinePlayers: 0, maxPlayers: 0, players: [] }); }
});

app.get('/api/claim-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Sila login Discord dahulu.' });
  if (!configured()) return res.json({ configured: false, claimed: false });

  // Return cached result if fresh (< 5 min) to avoid Discord rate limits
  const cache = req.session.claimCache;
  if (cache && (Date.now() - cache.fetchedAt) < CLAIM_CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  try {
    const response = await fetch(`${discordApi}/guilds/${process.env.DISCORD_GUILD_ID}/members/${req.session.user.id}`, { headers: authHeaders() });
    if (response.status === 404) {
      const data = { configured: true, claimed: false, inGuild: false };
      req.session.claimCache = { data, fetchedAt: Date.now() };
      return res.json(data);
    }
    if (!response.ok) throw new Error('Member check failed');
    const member = await response.json();
    const data = { configured: true, inGuild: true, claimed: (member.roles || []).includes(process.env.DISCORD_WHITELIST_ROLE_ID) };
    req.session.claimCache = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch { res.status(502).json({ error: 'Tidak dapat menyemak role Discord.' }); }
});

app.post('/api/claim', async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Portal belum dikonfigurasi oleh admin.' });
  if (!req.session.user || !req.session.accessToken) return res.status(401).json({ error: 'Sila login Discord dahulu.' });
  try {
    const memberUrl = `${discordApi}/guilds/${process.env.DISCORD_GUILD_ID}/members/${req.session.user.id}`;
    const join = await fetch(memberUrl, {
      method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: req.session.accessToken })
    });
    if (!join.ok && join.status !== 204) throw new Error('Discord membership check failed');
    const role = await fetch(`${memberUrl}/roles/${process.env.DISCORD_WHITELIST_ROLE_ID}`, { method: 'PUT', headers: authHeaders() });
    if (!role.ok && role.status !== 204) throw new Error('Role assignment failed');
    // Bust the cache after successful claim so next load shows updated status
    delete req.session.claimCache;
    res.json({ ok: true, message: 'Berjaya! Role Warga RKRP telah ditambah ke Discord anda.' });
  } catch (error) {
    console.error(error.message);
    res.status(502).json({ error: 'Tidak dapat memberi role. Pastikan bot berada dalam server, ada Manage Roles, dan role bot lebih tinggi daripada role Warga RKRP.' });
  }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('*', (_, res) => res.sendFile(require('path').join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`RKRP Portal running on http://localhost:${port}`));