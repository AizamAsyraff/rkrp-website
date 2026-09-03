require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

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
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(express.static('public'));

const configured = () => required.every((key) => process.env[key] && !process.env[key].startsWith('PASTE_'));
const authHeaders = () => ({ Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` });

app.get('/auth/discord', (req, res) => {
  if (!configured()) return res.redirect('/?error=config');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
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
    delete req.session.oauthState;
    res.redirect('/dashboard.html');
  } catch (error) {
    console.error(error.message);
    res.redirect('/?error=auth');
  }
});

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null, configured: configured() }));

app.get('/api/server-status', async (_, res) => {
  try {
    const response = await fetch('https://servers-frontend.fivem.net/api/servers/single/ler7ry4');
    if (!response.ok) throw new Error('FiveM unavailable');
    const payload = await response.json();
    const server = payload.Data || payload;
    const players = Array.isArray(server.players) ? server.players.slice(0, 100) : [];
    res.json({ online: true, onlinePlayers: Number(server.clients ?? players.length), maxPlayers: Number(server.sv_maxclients ?? 0), players: players.map((p) => ({ name: String(p.name || 'Unknown').slice(0, 48), ping: Number(p.ping || 0) })) });
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

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('*', (_, res) => res.sendFile(require('path').join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`RKRP Portal running on http://localhost:${port}`));
