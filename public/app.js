(() => {
  const telegram = window.Telegram && window.Telegram.WebApp;
  const player = document.getElementById('player');
  const status = document.getElementById('status');
  const placeholder = document.getElementById('placeholder');
  const stopButton = document.getElementById('stop-button');
  const soundButton = document.getElementById('sound-button');
  const templateId = new URLSearchParams(window.location.search).get('templateId');
  let playlistUrl;
  let hls;
  let stopped = false;

  if (telegram) {
    telegram.ready();
    telegram.expand();
  }

  function setStatus(message) {
    status.textContent = message;
  }

  async function stopPreview() {
    if (stopped) return;
    stopped = true;
    stopButton.disabled = true;
    if (hls) hls.destroy();
    player.pause();
    player.removeAttribute('src');
    player.load();
    placeholder.hidden = false;
    placeholder.textContent = 'Preview to‘xtatildi.';
    if (playlistUrl && telegram && telegram.initData) {
      const sessionId = playlistUrl.split('/')[2];
      try {
        await fetch(`/api/previews/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: telegram.initData }),
          keepalive: true,
        });
      } catch {
        setStatus('Preview serverda avtomatik ravishda to‘xtatiladi.');
      }
    }
    stopButton.hidden = true;
    soundButton.hidden = true;
    setStatus('Preview to‘xtatildi.');
  }

  async function startPreview() {
    if (!telegram || !telegram.initData) {
      setStatus('Preview’ni Telegram ichidan oching.');
      placeholder.textContent = 'Telegram Mini App sessiyasi topilmadi.';
      return;
    }
    if (!/^\d+$/.test(templateId || '')) {
      setStatus('Stream shabloni ko‘rsatilmagan.');
      placeholder.textContent = 'Botdan stream tanlab, Preview tugmasini bosing.';
      return;
    }
    try {
      const response = await fetch('/api/previews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: telegram.initData, templateId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Preview’ni boshlash imkonsiz.');
      playlistUrl = result.playlistUrl;
      const absolutePlaylistUrl = new URL(playlistUrl, window.location.origin).toString();
      placeholder.hidden = true;
      stopButton.hidden = false;
      soundButton.hidden = false;
      setStatus('Preview jonli efirga ulanmoqda…');
      const remainingMs = Math.max(0, result.expiresAt - Date.now());
      window.setTimeout(() => {
        if (!stopped) {
          stopped = true;
          if (hls) hls.destroy();
          player.pause();
          placeholder.hidden = false;
          placeholder.textContent = 'Preview vaqti tugadi. Botdan qayta oching.';
          stopButton.hidden = true;
          soundButton.hidden = true;
          setStatus('Preview muddati tugadi.');
        }
      }, remainingMs);
      if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = absolutePlaylistUrl;
      } else if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          liveSyncDurationCount: 2,
          maxBufferLength: 5,
          maxMaxBufferLength: 7,
          backBufferLength: 0,
          maxBufferHole: 0.5,
        });
        hls.loadSource(absolutePlaylistUrl);
        hls.attachMedia(player);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          setStatus('Preview ishlayapti.');
          player.play().catch(() => setStatus('Videoni ko‘rish uchun ▶ tugmasini bosing.'));
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setStatus('Video ochilmadi. Preview’ni to‘xtatib qayta urinib ko‘ring.');
        });
      } else {
        throw new Error('Bu qurilmada HLS video qo‘llab-quvvatlanmaydi.');
      }
      player.addEventListener('playing', () => setStatus('Preview ishlayapti.'), { once: true });
      player.play().catch(() => setStatus('Videoni ko‘rish uchun ▶ tugmasini bosing.'));
    } catch (error) {
      placeholder.hidden = false;
      placeholder.textContent = error.message;
      setStatus('Preview boshlanmadi.');
    }
  }

  stopButton.addEventListener('click', stopPreview);
  soundButton.addEventListener('click', () => {
    player.muted = false;
    player.play().catch(() => {});
    soundButton.hidden = true;
  });
  if (telegram) telegram.onEvent('viewportChanged', () => telegram.expand());
  startPreview();
})();
