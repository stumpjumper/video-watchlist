function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function buildReaderHtml(
  title: string,
  channelName: string,
  addedAt: string,
  sourceUrl: string,
  audioSrc: string | null,
  isGenerating: boolean,
  genError: string | null,
  videoId: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #111;
      color: #e4e4e7;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      -webkit-text-size-adjust: 100%;
    }

    /* ── Top bar ── */
    .top-bar {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; border-bottom: 1px solid #2a2a2a;
    }
    .back-link {
      color: #6366f1; text-decoration: none; font-size: 14px;
      white-space: nowrap; min-height: 44px; display: flex; align-items: center;
      flex-shrink: 0;
    }
    .back-link:hover { color: #a5b4fc; }
    .page-title {
      font-size: 14px; color: #71717a;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ── Audio player ── */
    .player {
      background: #18181b; border-bottom: 1px solid #27272a;
      padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .player-row {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .play-btn {
      width: 52px; height: 52px; border-radius: 50%;
      background: #6366f1; border: none; cursor: pointer;
      color: #fff; font-size: 22px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; -webkit-tap-highlight-color: transparent;
      transition: background 0.15s;
    }
    .play-btn:hover { background: #4f46e5; }
    .play-btn:active { background: #4338ca; }
    .skip-btn {
      background: none; border: 1px solid #3f3f46; border-radius: 8px;
      color: #a1a1aa; font-size: 13px; padding: 8px 12px; cursor: pointer;
      white-space: nowrap; min-height: 44px;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .skip-btn:hover { border-color: #71717a; color: #e4e4e7; }
    .speed-select {
      background: none; border: 1px solid #3f3f46; border-radius: 8px;
      color: #a1a1aa; font-size: 13px; padding: 8px 10px; cursor: pointer;
      min-height: 44px; appearance: none; -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .speed-select:hover { border-color: #71717a; color: #e4e4e7; }
    .autoplay-btn {
      background: none; border: 1px solid #3f3f46; border-radius: 8px;
      color: #a1a1aa; font-size: 12px; padding: 8px 10px; cursor: pointer;
      min-height: 44px; white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .autoplay-btn.on  { border-color: #4f46e5; color: #a5b4fc; }
    .autoplay-btn:hover { border-color: #71717a; color: #e4e4e7; }
    .next-status {
      font-size: 12px; color: #71717a; padding: 0 2px;
      min-height: 16px;
    }
    .time-display {
      font-size: 13px; color: #71717a; white-space: nowrap;
      font-variant-numeric: tabular-nums; margin-left: auto;
    }
    .progress-wrap { display: flex; align-items: center; gap: 10px; }
    .progress-bar {
      flex: 1; height: 4px; background: #27272a; border-radius: 2px;
      cursor: pointer; position: relative;
    }
    .progress-fill {
      height: 100%; background: #6366f1; border-radius: 2px;
      width: 0%; transition: width 0.25s linear; pointer-events: none;
    }
    .progress-bar:active .progress-fill { transition: none; }

    /* ── Generate / error state ── */
    .action-wrap {
      background: #18181b; border-bottom: 1px solid #27272a;
      padding: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .generate-btn {
      background: #6366f1; border: none; border-radius: 10px;
      color: #fff; font-size: 15px; padding: 12px 20px; cursor: pointer;
      min-height: 48px; white-space: nowrap;
      -webkit-tap-highlight-color: transparent; transition: background 0.15s;
    }
    .generate-btn:hover { background: #4f46e5; }
    .generate-btn:disabled { background: #3f3f46; color: #71717a; cursor: default; }
    .action-status { font-size: 14px; color: #71717a; }
    .action-status.error { color: #f87171; }

    /* ── Article info ── */
    .article-info {
      max-width: 750px; margin: 0 auto; padding: 28px 20px;
    }
    h1.article-title {
      font-size: 24px; font-weight: 700; color: #f4f4f5;
      line-height: 1.3; margin-bottom: 10px;
    }
    .article-meta {
      font-size: 14px; color: #71717a;
    }
    .article-meta a { color: #6366f1; text-decoration: none; }
    .article-meta a:hover { text-decoration: underline; }

    .article-body {
      max-width: 750px; margin: 0 auto; padding: 0 20px 40px;
      font-size: 16px; line-height: 1.75; color: #d4d4d8;
    }
    .article-body p { margin-bottom: 1.1em; }
    .article-body-loading { color: #52525b; font-style: italic; }

    @media (max-width: 599px) {
      h1.article-title { font-size: 20px; }
      .article-info { padding: 20px 16px; }
      .article-body { padding: 0 16px 32px; font-size: 15px; }
    }
  </style>
</head>
<body>

<div class="top-bar">
  <a class="back-link" href="/">← Watchlist</a>
  <span class="page-title">${escHtml(title)}</span>
</div>

${audioSrc
  ? `<div class="player" id="player">
  <audio id="audio" src="${escHtml(audioSrc)}" preload="metadata"></audio>
  <div class="player-row">
    <button class="play-btn" id="play-btn" title="Play / Pause">▶</button>
    <button class="skip-btn" id="skip-back" title="Back 10s">↩ 10s</button>
    <button class="skip-btn" id="skip-fwd"  title="Forward 30s">30s ↪</button>
    <select class="speed-select" id="speed-select" title="Playback speed">
      <option value="0.75">0.75×</option>
      <option value="1" selected>1×</option>
      <option value="1.25">1.25×</option>
      <option value="1.5">1.5×</option>
      <option value="1.75">1.75×</option>
      <option value="2">2×</option>
    </select>
    <span class="time-display" id="time-display">0:00 / --:--</span>
    <button class="autoplay-btn" id="autoplay-btn" title="Toggle autoplay">↻ Auto</button>
  </div>
  <div class="progress-wrap">
    <div class="progress-bar" id="progress-bar">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
  </div>
  <div class="next-status" id="next-status"></div>
</div>`
  : `<div class="action-wrap" id="action-wrap">
  <button class="generate-btn" id="generate-btn"${isGenerating ? ' disabled' : ''}>🎧 ${isGenerating ? 'Generating…' : genError ? 'Retry' : 'Generate Audio'}</button>
  <span class="action-status${genError ? ' error' : ''}" id="action-status">${
    genError
      ? 'Failed: ' + escHtml(genError)
      : isGenerating
        ? 'Fetching article &amp; generating audio…'
        : 'Uses Ava (Premium) voice · cached after first generation'
  }</span>
</div>`
}

<div class="article-info">
  <h1 class="article-title">${escHtml(title)}</h1>
  <div class="article-meta">
    ${escHtml(channelName)} &nbsp;·&nbsp; ${fmtDate(addedAt)}
    &nbsp;·&nbsp; <a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Original ↗</a>
  </div>
</div>

<div class="article-body" id="article-body">
  <p class="article-body-loading">Loading article…</p>
</div>

<script>
(function () {
  const VIDEO_ID    = ${videoId};
  const AUTOPLAY_KEY = 'reader-autoplay';
  const POS_KEY      = 'reader-pos-' + VIDEO_ID;

  // ── Audio player ─────────────────────────────────────────────────────────
  const audio = document.getElementById('audio');
  if (audio) {
    const playBtn      = document.getElementById('play-btn');
    const skipBack     = document.getElementById('skip-back');
    const skipFwd      = document.getElementById('skip-fwd');
    const speedSelect  = document.getElementById('speed-select');
    const timeLbl      = document.getElementById('time-display');
    const bar          = document.getElementById('progress-bar');
    const fill         = document.getElementById('progress-fill');
    const autoplayBtn  = document.getElementById('autoplay-btn');
    const nextStatus   = document.getElementById('next-status');

    // ── Autoplay toggle ───────────────────────────────────────────────────
    let autoplay = localStorage.getItem(AUTOPLAY_KEY) !== 'false';
    function renderAutoplay() {
      autoplayBtn.textContent = '↻ Auto';
      autoplayBtn.className = 'autoplay-btn' + (autoplay ? ' on' : '');
      autoplayBtn.title = autoplay ? 'Autoplay on — click to disable' : 'Autoplay off — click to enable';
    }
    renderAutoplay();
    autoplayBtn.addEventListener('click', () => {
      autoplay = !autoplay;
      localStorage.setItem(AUTOPLAY_KEY, String(autoplay));
      renderAutoplay();
    });

    // ── Position save / restore ───────────────────────────────────────────
    function savePos() {
      if (audio.currentTime > 5 && !audio.ended)
        localStorage.setItem(POS_KEY, String(Math.floor(audio.currentTime)));
    }
    const savedPos = parseFloat(localStorage.getItem(POS_KEY) || '0');
    audio.addEventListener('loadedmetadata', () => {
      if (savedPos > 5) audio.currentTime = savedPos;
      updateTime();
    });
    audio.addEventListener('pause', savePos);
    document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
    setInterval(() => { if (!audio.paused && !audio.ended) savePos(); }, 5000);

    // ── Playback helpers ──────────────────────────────────────────────────
    function fmt(s) {
      if (!isFinite(s)) return '--:--';
      const m = Math.floor(s / 60);
      return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    }
    function updatePlay() { playBtn.textContent = audio.paused ? '▶' : '⏸'; }
    function updateTime() {
      timeLbl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
      fill.style.width = (audio.duration > 0 ? audio.currentTime / audio.duration * 100 : 0) + '%';
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ${JSON.stringify(title)},
        artist: ${JSON.stringify(channelName)},
      });
      navigator.mediaSession.setActionHandler('play',         () => audio.play());
      navigator.mediaSession.setActionHandler('pause',        () => audio.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
      navigator.mediaSession.setActionHandler('seekforward',  () => { audio.currentTime = Math.min(audio.duration, audio.currentTime + 30); });
    }

    audio.addEventListener('play',       updatePlay);
    audio.addEventListener('pause',      updatePlay);
    audio.addEventListener('timeupdate', updateTime);

    playBtn.addEventListener('click',  () => { if (audio.paused) audio.play(); else audio.pause(); });
    skipBack.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    skipFwd.addEventListener('click',  () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
    speedSelect.addEventListener('change', () => { audio.playbackRate = parseFloat(speedSelect.value); });
    bar.addEventListener('click', e => {
      const rect = bar.getBoundingClientRect();
      audio.currentTime = (e.clientX - rect.left) / rect.width * (audio.duration || 0);
    });

    // ── Ended: mark done + autoplay next ─────────────────────────────────
    audio.addEventListener('ended', async () => {
      updatePlay();
      localStorage.removeItem(POS_KEY);

      // Mark as finished
      fetch('/api/videos/' + VIDEO_ID + '/finished', { method: 'POST' }).catch(() => {});

      if (!autoplay) return;

      try {
        const r = await fetch('/api/videos/' + VIDEO_ID + '/next' + location.search);
        const next = await r.json();
        if (!next) { nextStatus.textContent = 'End of list'; return; }

        nextStatus.textContent = (next.has_audio ? 'Next: ' : 'Generating: ') + next.title + '…';

        if (!next.has_audio) {
          const gr = await fetch('/api/videos/' + next.id + '/audio', { method: 'POST' });
          const gd = await gr.json();
          if (gd.status !== 'ready') {
            await new Promise(resolve => {
              function check() {
                setTimeout(async () => {
                  try {
                    const sr = await fetch('/api/videos/' + next.id + '/audio/status');
                    const sd = await sr.json();
                    if (sd.status === 'ready') { resolve(); }
                    else if (sd.status === 'failed') {
                      nextStatus.textContent = 'Generation failed: ' + next.title;
                      resolve('failed');
                    } else { check(); }
                  } catch { check(); }
                }, 4000);
              }
              check();
            }).then(result => { if (result === 'failed') return; });
            if (nextStatus.textContent.startsWith('Generation failed')) return;
          }
        }

        location.href = '/reader/' + next.id + location.search;
      } catch (e) {
        nextStatus.textContent = 'Autoplay error';
      }
    });
  }

  // ── Generate button ───────────────────────────────────────────────────────
  const genBtn    = document.getElementById('generate-btn');
  const genStatus = document.getElementById('action-status');
  if (genBtn) {
    ${isGenerating ? 'poll(VIDEO_ID);' : ''}

    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      genBtn.textContent = '🎧 Generating…';
      genStatus.className = 'action-status';
      genStatus.textContent = 'Fetching article & generating audio…';

      try {
        const res = await fetch('/api/videos/' + VIDEO_ID + '/audio', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'ready') { location.reload(); return; }
        if (data.status === 'generating') { poll(VIDEO_ID); return; }
        genStatus.className = 'action-status error';
        genStatus.textContent = 'Error: ' + (data.error || 'unknown');
        genBtn.disabled = false;
        genBtn.textContent = '🎧 Retry';
      } catch (e) {
        genStatus.className = 'action-status error';
        genStatus.textContent = 'Network error — try again';
        genBtn.disabled = false;
        genBtn.textContent = '🎧 Retry';
      }
    });

    function poll(id) {
      setTimeout(async () => {
        try {
          const r = await fetch('/api/videos/' + id + '/audio/status');
          const d = await r.json();
          if (d.status === 'ready') {
            location.reload();
          } else if (d.status === 'failed') {
            genStatus.className = 'action-status error';
            genStatus.textContent = 'Failed: ' + (d.error || 'unknown error');
            genBtn.disabled = false;
            genBtn.textContent = '🎧 Retry';
          } else {
            poll(id);
          }
        } catch { poll(id); }
      }, 4000);
    }
  }
  // ── Article text ─────────────────────────────────────────────────────────
  const bodyEl = document.getElementById('article-body');
  fetch('/api/videos/' + VIDEO_ID + '/text')
    .then(r => r.json())
    .then(d => {
      if (d.text) {
        bodyEl.innerHTML = d.text
          .split(/\\n{2,}/)
          .map(p => '<p>' + p.replace(/\\n/g, ' ').trim() + '</p>')
          .filter(p => p !== '<p></p>')
          .join('');
      } else {
        bodyEl.innerHTML = '<p class="article-body-loading">Could not load article text.</p>';
      }
    })
    .catch(() => {
      bodyEl.innerHTML = '<p class="article-body-loading">Could not load article text.</p>';
    });
})();
</script>
</body>
</html>`;
}
