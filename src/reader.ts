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
  text: string,
): string {
  const noText = !text.trim();

  // Build paragraph HTML: split on double newlines; fall back to ~800-char sentence boundaries
  let paragraphsHtml = '';
  if (!noText) {
    let paras: string[];
    if (text.includes('\n\n')) {
      paras = text.split(/\n\n+/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    } else {
      // No double newlines — split at sentence boundaries around ~800 chars
      paras = [];
      let remaining = text.trim();
      while (remaining.length > 0) {
        if (remaining.length <= 800) {
          paras.push(remaining);
          break;
        }
        // Find last sentence boundary before 800 chars
        const chunk = remaining.slice(0, 800);
        const lastDot = Math.max(
          chunk.lastIndexOf('. '),
          chunk.lastIndexOf('! '),
          chunk.lastIndexOf('? '),
        );
        const cutAt = lastDot > 200 ? lastDot + 1 : 800;
        paras.push(remaining.slice(0, cutAt).trim());
        remaining = remaining.slice(cutAt).trim();
      }
    }

    paragraphsHtml = paras
      .map((p, i) => `<p class="article-para" id="para-${i}">${escHtml(p)}</p>`)
      .join('\n');
  }

  const paragraphCount = noText ? 0 : paragraphsHtml.split('class="article-para"').length - 1;

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
      font-family: system-ui, -apple-system, Georgia, serif;
      font-size: 18px;
      line-height: 1.7;
      min-height: 100vh;
      -webkit-text-size-adjust: 100%;
    }

    /* Sticky controls bar */
    .controls-bar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(17,17,17,0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid #2a2a2a;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .back-link {
      color: #6366f1;
      text-decoration: none;
      font-size: 14px;
      white-space: nowrap;
      flex-shrink: 0;
      padding: 6px 0;
      min-height: 44px;
      display: flex;
      align-items: center;
    }
    .back-link:hover { color: #a5b4fc; }

    .ctrl-sep {
      width: 1px;
      height: 24px;
      background: #3f3f46;
      flex-shrink: 0;
    }

    .ctrl-btn {
      background: none;
      border: 1px solid #3f3f46;
      color: #a1a1aa;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 15px;
      white-space: nowrap;
      min-height: 44px;
      min-width: 44px;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .ctrl-btn:hover { border-color: #71717a; color: #e4e4e7; }
    .ctrl-btn:disabled { opacity: 0.35; cursor: default; }
    .ctrl-btn.playing { border-color: #6366f1; color: #a5b4fc; }

    .speed-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #71717a;
      white-space: nowrap;
    }
    .speed-slider {
      width: 90px;
      accent-color: #6366f1;
      cursor: pointer;
    }

    /* Article content */
    .content {
      max-width: 750px;
      margin: 0 auto;
      padding: 32px 20px 80px;
    }

    h1.article-title {
      font-size: 26px;
      font-weight: 700;
      color: #f4f4f5;
      line-height: 1.3;
      margin-bottom: 10px;
    }

    .article-meta {
      font-size: 14px;
      color: #71717a;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid #27272a;
    }
    .article-meta a {
      color: #6366f1;
      text-decoration: none;
    }
    .article-meta a:hover { text-decoration: underline; }

    .article-para {
      margin-bottom: 1.4em;
      color: #d4d4d8;
      scroll-margin-top: 80px;
      padding: 4px 6px;
      border-radius: 4px;
      transition: background 0.2s;
    }
    .article-para.active {
      background: rgba(255, 200, 0, 0.15);
    }

    .no-text-msg {
      color: #71717a;
      font-size: 16px;
      line-height: 1.6;
      padding: 32px 0;
    }
    .no-text-msg a {
      color: #6366f1;
      text-decoration: none;
    }
    .no-text-msg a:hover { text-decoration: underline; }

    @media (max-width: 599px) {
      h1.article-title { font-size: 22px; }
      body { font-size: 17px; }
      .content { padding: 24px 16px 64px; }
    }
  </style>
</head>
<body>

<div class="controls-bar">
  <a class="back-link" href="/">← Watchlist</a>
  <div class="ctrl-sep"></div>
  ${noText ? `<span style="font-size:13px;color:#52525b">No article text available</span>` : `
  <button class="ctrl-btn" id="btn-play"  title="Play">▶ Play</button>
  <button class="ctrl-btn" id="btn-pause" title="Pause" disabled>⏸ Pause</button>
  <button class="ctrl-btn" id="btn-stop"  title="Stop"  disabled>⏹ Stop</button>
  <div class="ctrl-sep"></div>
  <div class="speed-wrap">
    <span>Speed: <span id="speed-label">1.0</span>×</span>
    <input type="range" class="speed-slider" id="speed-slider"
      min="0.5" max="2.5" step="0.1" value="1.0">
  </div>
  `}
</div>

<div class="content">
  <h1 class="article-title">${escHtml(title)}</h1>
  <div class="article-meta">
    ${escHtml(channelName)} &nbsp;·&nbsp;
    ${fmtDate(addedAt)}
    &nbsp;·&nbsp; <a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Original article ↗</a>
  </div>

  ${noText
    ? `<div class="no-text-msg">
        <p>Article text not available for listening.</p>
        <p style="margin-top:12px"><a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open the original article instead ↗</a></p>
      </div>`
    : `<div id="article-body">${paragraphsHtml}</div>`
  }
</div>

${noText ? '' : `
<script>
  // ── State ──────────────────────────────────────────────────────────────────
  const PARA_COUNT  = ${paragraphCount};
  let currentIdx    = 0;
  let isPlaying     = false;
  let currentRate   = 1.0;
  let currentUtter  = null;

  const btnPlay  = document.getElementById('btn-play');
  const btnPause = document.getElementById('btn-pause');
  const btnStop  = document.getElementById('btn-stop');
  const slider   = document.getElementById('speed-slider');
  const speedLbl = document.getElementById('speed-label');

  function getPara(idx) {
    return document.getElementById('para-' + idx);
  }

  function setHighlight(idx) {
    // Remove previous
    document.querySelectorAll('.article-para.active').forEach(el => el.classList.remove('active'));
    if (idx >= 0 && idx < PARA_COUNT) {
      const el = getPara(idx);
      if (el) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  function updateButtons(playing) {
    btnPlay.disabled  =  playing;
    btnPause.disabled = !playing;
    btnStop.disabled  = !playing;
    btnPlay.classList.toggle('playing', playing);
  }

  function speakPara(idx) {
    if (idx >= PARA_COUNT) {
      // Done
      isPlaying = false;
      currentIdx = 0;
      setHighlight(-1);
      updateButtons(false);
      return;
    }

    const el = getPara(idx);
    if (!el) { speakPara(idx + 1); return; }

    const text = el.innerText.trim();
    if (!text) { speakPara(idx + 1); return; }

    setHighlight(idx);
    currentIdx = idx;

    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = currentRate;
    currentUtter = utt;

    utt.onend = () => {
      if (isPlaying) speakPara(idx + 1);
    };
    utt.onerror = (e) => {
      // 'interrupted' fires on pause/cancel — not a real error
      if (e.error !== 'interrupted' && e.error !== 'canceled' && isPlaying) {
        speakPara(idx + 1);
      }
    };

    window.speechSynthesis.speak(utt);
  }

  function startFrom(idx) {
    window.speechSynthesis.cancel();
    isPlaying = true;
    updateButtons(true);
    speakPara(idx);
  }

  btnPlay.addEventListener('click', () => {
    if ('speechSynthesis' in window) {
      startFrom(currentIdx);
    } else {
      alert('Your browser does not support text-to-speech.');
    }
  });

  btnPause.addEventListener('click', () => {
    // speechSynthesis.pause() is unreliable on iOS; cancel + remember position
    window.speechSynthesis.cancel();
    isPlaying = false;
    updateButtons(false);
    // currentIdx is already set to the paragraph that was speaking
    setHighlight(currentIdx);
  });

  btnStop.addEventListener('click', () => {
    window.speechSynthesis.cancel();
    isPlaying = false;
    currentIdx = 0;
    setHighlight(-1);
    updateButtons(false);
  });

  slider.addEventListener('input', () => {
    currentRate = parseFloat(slider.value);
    speedLbl.textContent = currentRate.toFixed(1);
  });

  // Allow tapping a paragraph to start reading from there
  document.getElementById('article-body').addEventListener('click', e => {
    const para = e.target.closest('.article-para');
    if (!para) return;
    const id = para.id; // para-N
    const idx = parseInt(id.split('-')[1], 10);
    if (!isNaN(idx)) startFrom(idx);
  });

  // Clean up on page unload
  window.addEventListener('pagehide', () => window.speechSynthesis.cancel());
  window.addEventListener('beforeunload', () => window.speechSynthesis.cancel());
</script>
`}
</body>
</html>`;
}
