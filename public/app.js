(() => {
  const telegram = window.Telegram && window.Telegram.WebApp;
  const player = document.getElementById('player');
  const placeholder = document.getElementById('placeholder');
  const templateId = new URLSearchParams(window.location.search).get('templateId');
  let hls;

  if (telegram) {
    telegram.ready();
    telegram.expand();
  }

  async function startPreview() {
    if (!telegram || !telegram.initData) {
      placeholder.textContent = 'Telegram Mini App sessiyasi topilmadi.';
      return;
    }
    if (!/^\d+$/.test(templateId || '')) {
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
      const absolutePlaylistUrl = new URL(result.playlistUrl, window.location.origin).toString();
      const remainingMs = Math.max(0, result.expiresAt - Date.now());
      window.setTimeout(() => {
        if (hls) hls.destroy();
        player.pause();
        placeholder.hidden = false;
        placeholder.textContent = 'Preview vaqti tugadi.';
      }, remainingMs);
      if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = absolutePlaylistUrl;
      } else if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          liveSyncDurationCount: 2,
          maxBufferLength: 3,
          maxMaxBufferLength: 4,
          backBufferLength: 0,
          maxBufferHole: 0.5,
          startLevel: 0,
        });
        hls.loadSource(absolutePlaylistUrl);
        hls.attachMedia(player);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          player.play().catch(() => {});
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) placeholder.textContent = 'Jonli efirni yuklab bo‘lmadi.';
        });
      } else {
        throw new Error('Bu qurilmada HLS video qo‘llab-quvvatlanmaydi.');
      }
      player.addEventListener('playing', () => { placeholder.hidden = true; }, { once: true });
      player.addEventListener('error', () => {
        placeholder.hidden = false;
        placeholder.textContent = 'Jonli efirni yuklab bo‘lmadi.';
      }, { once: true });
      player.play().catch(() => {});
    } catch (error) {
      placeholder.hidden = false;
      placeholder.textContent = error.message;
    }
  }

  player.addEventListener('click', () => {
    player.muted = !player.muted;
    player.play().catch(() => {});
  });
  if (telegram) telegram.onEvent('viewportChanged', () => telegram.expand());
  startPreview();
})();
