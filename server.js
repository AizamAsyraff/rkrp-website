require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const app = express();
const port = Number(process.env.PORT || 3000);
const discordApi = 'https://discord.com/api/v10';
const required = [
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_WHITELIST_ROLE_ID'
];

const SESSION_DAYS = 60;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * SESSION_DAYS;

app.set('trust proxy', 1);
app.use(express.json());

// cookie-session: data disimpan dalam cookie itu sendiri (encrypted + signed)
// Survive Render restart, deploy, scale — tak perlu external store
app.use(cookieSession({
  name: 'rkrp_session',
  keys: [
    process.env.SESSION_SECRET || 'PLEASE_SET_SESSION_SECRET_IN_ENV',
    process.env.SESSION_SECRET_OLD || 'PLEASE_SET_SESSION_SECRET_IN_ENV'
  ],
  maxAge: SESSION_MAX_AGE,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

app.use(express.static('public', { index: false }));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard.html');
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

const configured = () => required.every((key) => process.env[key] && !process.env[key].startsWith('PASTE_'));
const authHeaders = () => ({ Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` });

// Retry helper untuk handle Discord 429
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = (Number(res.headers.get('retry-after') || 2) + 1) * 1000;
      console.warn(`Discord rate limited, retrying in ${retryAfter}ms (attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, retryAfter));
      continue;
    }
    return res;
  }
  throw new Error('Discord rate limit max retries exceeded');
}

app.get('/auth/discord', (req, res) => {
  if (!configured()) return res.redirect('/?error=config');
  // Kalau dah login, terus ke dashboard
  if (req.session.user) return res.redirect('/dashboard.html');
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
    const tokenResponse = await fetchWithRetry(`${discordApi}/oauth2/token`, {
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
    req.session.oauthState = null;
    req.session.oauthStartedAt = null;
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
  try {
    const response = await fetch(`${discordApi}/guilds/${process.env.DISCORD_GUILD_ID}/members/${req.session.user.id}`, { headers: authHeaders() });
    if (response.status === 404) return res.json({ configured: true, claimed: false, inGuild: false });
    if (!response.ok) throw new Error('Member check failed');
    const member = await response.json();
    res.json({ configured: true, inGuild: true, claimed: (member.roles || []).includes(process.env.DISCORD_WHITELIST_ROLE_ID) });
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
    res.json({ ok: true, message: 'Berjaya! Role Warga RKRP telah ditambah ke Discord anda.' });
  } catch (error) {
    console.error(error.message);
    res.status(502).json({ error: 'Tidak dapat memberi role. Pastikan bot berada dalam server, ada Manage Roles, dan role bot lebih tinggi daripada role Warga RKRP.' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null; // cookie-session: null = clear cookie
  res.json({ ok: true });
});

app.get('*', (_, res) => res.sendFile(require('path').join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`RKRP Portal running on http://localhost:${port}`));