const status = document.querySelector('#server-status');
async function checkServer() {
  try {
    const res = await fetch('https://servers-frontend.fivem.net/api/servers/single/ler7ry4');
    if (!res.ok) throw new Error();
    const data = await res.json(); const players = data.Data?.clients; const max = data.Data?.sv_maxclients;
    status.querySelector('strong').textContent = `ONLINE${Number.isFinite(players) ? ` · ${players}/${max} PLAYERS` : ''}`;
  } catch { status.querySelector('.pulse').classList.add('offline'); status.querySelector('strong').textContent = 'STATUS TIDAK TERSEDIA'; }
} checkServer();
