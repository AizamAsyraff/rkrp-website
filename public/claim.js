const profile = document.querySelector('#profile'), button = document.querySelector('#claim'), result = document.querySelector('#claim-result');
fetch('/api/me').then(r => r.json()).then(({ user, configured }) => {
  if (!user) return location.replace('/auth/discord');
  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  profile.className = 'profile'; profile.innerHTML = `<img src="${avatar}" alt="" /><div><small>LOGGED IN AS</small><strong>${user.global_name || user.username}</strong><span>@${user.username}</span></div>`;
  button.disabled = !configured; if (!configured) result.textContent = 'Portal sedang menunggu konfigurasi admin.';
}).catch(() => location.replace('/'));
button.addEventListener('click', async () => { button.disabled = true; button.textContent = 'MEMPROSES…'; const response = await fetch('/api/claim', { method: 'POST' }); const data = await response.json(); result.textContent = data.message || data.error; result.className = data.ok ? 'success' : 'error'; if (!data.ok) { button.disabled = false; button.innerHTML = 'Cuba Lagi <span>→</span>'; } });
