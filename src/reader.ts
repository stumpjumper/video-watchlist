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
    .speed-btn {
      background: none; border: 1px solid #3f3f46; border-radius: 8px;
      color: #a1a1aa; font-size: 13px; padding: 8px 12px; cursor: pointer;
      min-height: 44px; min-width: 52px;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .speed-btn:hover { border-color: #71717a; color: #e4e4e7; }
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

    @media (max-width: 599px) {
      h1.article-title { font-size: 20px; }
      .article-info { padding: 20px 16px; }
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
    <button class="speed-btn" id="speed-btn" title="Cycle speed">1×</button>
    <span class="time-display" id="time-display">0:00 / --:--</span>
  </div>
  <div class="progress-wrap">
    <div class="progress-bar" id="progress-bar">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
  </div>
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

<script>
(function () {
  // ── Audio player ─────────────────────────────────────────────────────────
  const audio = document.getElementById('audio');
  if (audio) {
    const playBtn  = document.getElementById('play-btn');
    const skipBack = document.getElementById('skip-back');
    const skipFwd  = document.getElementById('skip-fwd');
    const speedBtn = document.getElementById('speed-btn');
    const timeLbl  = document.getElementById('time-display');
    const bar      = document.getElementById('progress-bar');
    const fill     = document.getElementById('progress-fill');

    const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
    let speedIdx = 0;

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

    audio.addEventListener('play',          updatePlay);
    audio.addEventListener('pause',         updatePlay);
    audio.addEventListener('ended',         updatePlay);
    audio.addEventListener('timeupdate',    updateTime);
    audio.addEventListener('loadedmetadata',updateTime);

    playBtn.addEventListener('click',  () => { if (audio.paused) audio.play(); else audio.pause(); });
    skipBack.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    skipFwd.addEventListener('click',  () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
    speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      audio.playbackRate = SPEEDS[speedIdx];
      speedBtn.textContent = SPEEDS[speedIdx] + '×';
    });
    bar.addEventListener('click', e => {
      const rect = bar.getBoundingClientRect();
      audio.currentTime = (e.clientX - rect.left) / rect.width * (audio.duration || 0);
    });

    const POS_KEY = 'reader-pos-' + location.pathname;
    const saved = parseFloat(sessionStorage.getItem(POS_KEY) || '0');
    if (saved > 5) audio.currentTime = saved;
    setInterval(() => {
      if (!audio.paused) sessionStorage.setItem(POS_KEY, String(Math.floor(audio.currentTime)));
    }, 5000);
  }

  // ── Generate button ───────────────────────────────────────────────────────
  const genBtn    = document.getElementById('generate-btn');
  const genStatus = document.getElementById('action-status');
  if (genBtn) {
    const pathId = location.pathname.split('/').pop();

    ${isGenerating ? 'poll(pathId);' : ''}

    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true;
      genBtn.textContent = '🎧 Generating…';
      genStatus.className = 'action-status';
      genStatus.textContent = 'Fetching article & generating audio…';

      try {
        const res = await fetch('/api/videos/' + pathId + '/audio', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'ready') { location.reload(); return; }
        if (data.status === 'generating') { poll(pathId); return; }
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
})();
</script>
</body>
</html>`;
}
