import { VideoLabel } from './db';

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
  status: string,
  labels: VideoLabel[],
  publishedAt: string | null,
): string {
  const initialLabelIds = JSON.stringify(labels.map(l => l.label_id));

  function metaDate(): string {
    if (publishedAt) {
      const pub = fmtDate(publishedAt);
      const add = fmtDate(addedAt);
      if (pub !== add) {
        return 'Published ' + escHtml(pub)
          + ' &nbsp;·&nbsp; <span style="color:var(--text-faint)">Added ' + escHtml(add) + '</span>';
      }
      return escHtml(pub);
    }
    return escHtml(fmtDate(addedAt));
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <link rel="stylesheet" href="/shared.css">
  <style>
    /* ── Top bar ── */
    .top-bar {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; border-bottom: 1px solid var(--bg-raised);
    }
    .back-link {
      color: var(--accent); text-decoration: none; font-size: 14px;
      white-space: nowrap; min-height: 44px; display: flex; align-items: center;
      flex-shrink: 0;
    }
    .back-link:hover { color: var(--accent-muted); }
    .page-title {
      font-size: 14px; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }

    /* ── Audio player ── */
    .player {
      background: var(--bg-base); border-bottom: 1px solid var(--bg-raised);
      padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .player-row {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .play-btn {
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--accent); border: none; cursor: pointer;
      color: #fff; font-size: 22px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; -webkit-tap-highlight-color: transparent;
      transition: background 0.15s;
    }
    .play-btn:hover  { background: var(--accent-hover); }
    .play-btn:active { background: var(--accent-press); }
    .speed-select {
      background: none; border: 1px solid var(--border); border-radius: 8px;
      color: #a1a1aa; font-size: 13px; padding: 8px 10px; cursor: pointer;
      min-height: 44px; appearance: none; -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, color 0.15s;
    }
    .speed-select:hover { border-color: var(--border-mid); color: var(--text); }
    .time-display {
      font-size: 13px; color: var(--text-muted); white-space: nowrap;
      font-variant-numeric: tabular-nums; margin-left: auto;
    }
    .progress-wrap { display: flex; align-items: center; gap: 10px; }
    .progress-bar {
      flex: 1; height: 4px; background: var(--bg-raised); border-radius: 2px;
      cursor: pointer; position: relative;
    }
    .progress-fill {
      height: 100%; background: var(--accent); border-radius: 2px;
      width: 0%; transition: width 0.25s linear; pointer-events: none;
    }
    .progress-bar:active .progress-fill { transition: none; }
    .next-status {
      font-size: 12px; color: var(--text-muted); padding: 0 2px;
      min-height: 16px;
    }

    /* ── Generate / error state ── */
    .action-wrap {
      background: var(--bg-base); border-bottom: 1px solid var(--bg-raised);
      padding: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .generate-btn {
      background: var(--accent); border: none; border-radius: 10px;
      color: #fff; font-size: 15px; padding: 12px 20px; cursor: pointer;
      min-height: 48px; white-space: nowrap;
      -webkit-tap-highlight-color: transparent; transition: background 0.15s;
    }
    .generate-btn:hover    { background: var(--accent-hover); }
    .generate-btn:disabled { background: var(--border); color: var(--text-muted); cursor: default; }
    .action-status       { font-size: 14px; color: var(--text-muted); }
    .action-status.error { color: var(--red); }

    /* ── Article info ── */
    .article-info {
      max-width: 750px; margin: 0 auto; padding: 28px 20px;
    }
    h1.article-title {
      font-size: 24px; font-weight: 700; color: var(--text-head);
      line-height: 1.3; margin-bottom: 10px;
    }
    .article-meta { font-size: 14px; color: var(--text-muted); }
    .article-meta a { color: var(--accent); text-decoration: none; }
    .article-meta a:hover { text-decoration: underline; }
    .article-body {
      max-width: 750px; margin: 0 auto; padding: 0 20px 40px;
      font-size: 16px; line-height: 1.75; color: #d4d4d8;
    }
    .article-body p { margin-bottom: 1.1em; }
    .article-body-loading { color: var(--text-faint); font-style: italic; }

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
  <span class="badge badge-${escHtml(status)}" id="status-badge">${escHtml(status)}</span>
  <button class="btn-ghost sm" id="btn-reader-labels">Labels</button>
</div>

${audioSrc
  ? `<div class="player" id="player">
  <audio id="audio" src="${escHtml(audioSrc)}" preload="metadata"></audio>
  <div class="player-row">
    <button class="play-btn" id="play-btn" title="Play / Pause">▶</button>
    <button class="btn-ghost" style="min-height:44px" id="skip-back" title="Back 10s">↩ 10s</button>
    <button class="btn-ghost" style="min-height:44px" id="skip-fwd"  title="Forward 30s">30s ↪</button>
    <select class="speed-select" id="speed-select" title="Playback speed">
      <option value="0.75">0.75×</option>
      <option value="1" selected>1×</option>
      <option value="1.25">1.25×</option>
      <option value="1.5">1.5×</option>
      <option value="1.75">1.75×</option>
      <option value="2">2×</option>
    </select>
    <span class="time-display" id="time-display">0:00 / --:--</span>
    <button class="btn-ghost" style="min-height:44px" id="autoplay-btn" title="Toggle autoplay">↻ Auto</button>
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
    ${escHtml(channelName)} &nbsp;·&nbsp; ${metaDate()}
    &nbsp;·&nbsp; <a href="${escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Original ↗</a>
  </div>
</div>

<div class="article-body" id="article-body">
  <p class="article-body-loading">Loading article…</p>
</div>

<div class="overlay" id="labels-overlay">
  <div class="modal">
    <div class="modal-handle"></div>
    <div class="modal-label">Labels</div>
    <div class="label-picker" id="label-picker-list"></div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="labels-apply-btn">Apply</button>
      <button class="btn btn-cancel" id="labels-cancel-btn">Cancel</button>
    </div>
  </div>
</div>

<script>
window.READER_DATA = {
  videoId:        ${videoId},
  title:          ${JSON.stringify(title)},
  channelName:    ${JSON.stringify(channelName)},
  initialLabelIds: ${initialLabelIds},
  isGenerating:   ${isGenerating},
};
</script>
<script src="/reader.js"></script>
</body>
</html>`;
}
