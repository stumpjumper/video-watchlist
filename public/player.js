// AudioEngine — owns the single <audio> element and mini-player DOM state.
// Exposed globally as window.Player.

(function () {
  'use strict';

  const audio = document.createElement('audio');
  audio.preload = 'none';
  document.body.appendChild(audio);

  // Mini-player DOM refs (set once after DOM ready)
  let elTitle, elChannel, elProgress, elPlayPause, elSeekBack, elNextBtn, elSpeedBadge, elInfo;

  // State
  let currentId      = null;
  let currentMeta    = null;   // { id, title, channel_name, emoji, source, content_type }
  let cachedStatus   = null;   // last fetched { status, url, error }
  let pollTimer      = null;
  let queue          = [];     // array of full video meta objects, in display order
  let sourceSpeeds   = {};     // source_key → default_speed

  // ── Initialise ──────────────────────────────────────────────────────────────

  async function init() {
    elTitle      = document.getElementById('mp-title');
    elChannel    = document.getElementById('mp-channel');
    elProgress   = document.getElementById('mp-progress');
    elPlayPause  = document.getElementById('mp-play-pause');
    elSeekBack   = document.getElementById('mp-seek-back');
    elNextBtn    = document.getElementById('mp-next-btn');
    elSpeedBadge = document.getElementById('mp-speed-badge');
    elInfo       = document.getElementById('mp-info');

    // Wire mini-player controls
    elPlayPause.addEventListener('click', handlePlayPause);
    elSeekBack.addEventListener('click', () => seekBack(10));
    elNextBtn.addEventListener('click', nextInQueue);
    elInfo.addEventListener('click', openCurrentReader);

    // Seek by tapping progress track
    document.getElementById('mp-progress-track').addEventListener('click', e => {
      if (!audio.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    });

    // Audio events
    audio.addEventListener('play',  updatePlayBtn);
    audio.addEventListener('pause', updatePlayBtn);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onTimeUpdate);
    audio.addEventListener('error', e => {
      console.error('[player] audio error', e);
      updatePlayBtn();
    });

    setupMediaSession();

    // Load source speeds from server
    try {
      const sources = await fetch('/api/sources').then(r => r.json());
      for (const s of sources) sourceSpeeds[s.source_key] = s.default_speed;
    } catch {}
  }

  // ── Load a video into the player ────────────────────────────────────────────

  async function load(meta) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentId   = meta.id;
    currentMeta = meta;
    cachedStatus = null;

    updateMiniPlayerMeta(meta);
    setPlayBtnIcon('idle');
    elSeekBack.disabled  = true;
    elPlayPause.disabled = true;

    const speed = sourceSpeeds[meta.source] || 1.0;
    elSpeedBadge.textContent = speed !== 1.0 ? speed.toFixed(2).replace(/\.?0+$/, '') + '×' : '';
    elSpeedBadge.style.display = speed !== 1.0 ? '' : 'none';

    try {
      const status = await fetch('/api/videos/' + meta.id + '/audio/status').then(r => r.json());
      cachedStatus = status;
      if (status.status === 'ready') {
        elPlayPause.disabled = false;
        setPlayBtnIcon('paused');
      } else if (status.status === 'generating') {
        setPlayBtnIcon('generating');
        startPolling();
      } else {
        // none / failed / deleted — show play btn so user can tap to generate
        elPlayPause.disabled = false;
        setPlayBtnIcon('generate');
      }
    } catch {
      cachedStatus = { status: 'none' };
      elPlayPause.disabled = false;
      setPlayBtnIcon('generate');
    }
  }

  // ── Called synchronously from the play/pause button tap ─────────────────────
  // iOS constraint: audio.play() must be called in a synchronous user gesture handler.

  function handlePlayPause() {
    if (!currentId) return;

    if (cachedStatus && cachedStatus.status === 'ready') {
      if (audio.paused) {
        // If src is already set to this video, just resume
        if (audio.src && audio.src.endsWith('/audio/' + currentId + '.m4a')) {
          audio.play().catch(err => console.error('[player] play failed', err));
        } else {
          // Set src synchronously, then play — iOS allows this
          audio.src = cachedStatus.url;
          const speed = sourceSpeeds[currentMeta.source] || 1.0;
          audio.playbackRate = speed;
          // Restore saved position
          const saved = loadSavedPosition(currentId);
          audio.play().then(() => {
            if (saved && saved < audio.duration - 2) audio.currentTime = saved;
          }).catch(err => console.error('[player] play failed', err));
        }
        elSeekBack.disabled = false;
        updateNextBtn();
      } else {
        audio.pause();
        savePosition(currentId, audio.currentTime);
      }
    } else if (!cachedStatus || cachedStatus.status !== 'generating') {
      // Trigger audio generation
      triggerGenerate(currentId);
    }
  }

  async function triggerGenerate(id) {
    if (!currentId || currentId !== id) return;
    setPlayBtnIcon('generating');
    elPlayPause.disabled = true;
    try {
      const res = await fetch('/api/videos/' + id + '/audio', { method: 'POST' });
      const data = await res.json();
      cachedStatus = { status: 'generating' };
      if (data.status === 'ready') {
        cachedStatus = data;
        elPlayPause.disabled = false;
        setPlayBtnIcon('paused');
      } else {
        startPolling();
      }
    } catch {
      cachedStatus = { status: 'failed', error: 'Network error' };
      elPlayPause.disabled = false;
      setPlayBtnIcon('generate');
    }
  }

  function startPolling() {
    if (pollTimer) return;
    const targetId = currentId;
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 60 || currentId !== targetId) {
        clearInterval(pollTimer); pollTimer = null; return;
      }
      try {
        const data = await fetch('/api/videos/' + targetId + '/audio/status').then(r => r.json());
        if (data.status === 'ready') {
          clearInterval(pollTimer); pollTimer = null;
          cachedStatus = data;
          elPlayPause.disabled = false;
          setPlayBtnIcon('paused');
        } else if (data.status === 'failed') {
          clearInterval(pollTimer); pollTimer = null;
          cachedStatus = data;
          elPlayPause.disabled = false;
          setPlayBtnIcon('generate');
        }
      } catch {}
    }, 2000);
  }

  // ── Queue management ─────────────────────────────────────────────────────────

  function setQueue(videos) {
    queue = videos || [];
    updateNextBtn();
  }

  function nextInQueue() {
    if (!currentId || !queue.length) return;
    const idx = queue.findIndex(v => v.id === currentId);
    const next = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
    if (next) {
      load(next);
      // Navigate to reader view
      if (typeof navigate === 'function') navigate('#reader/' + next.id);
    }
  }

  function updateNextBtn() {
    if (!currentId || !queue.length) { elNextBtn.disabled = true; return; }
    const idx = queue.findIndex(v => v.id === currentId);
    elNextBtn.disabled = idx < 0 || idx >= queue.length - 1;
  }

  // ── Auto-advance on ended ────────────────────────────────────────────────────

  function onEnded() {
    updatePlayBtn();
    markFinished(currentId);
    clearSavedPosition(currentId);

    const autoplay = localStorage.getItem('v6-autoplay') !== 'false';
    if (!autoplay || !queue.length) return;

    const idx = queue.findIndex(v => v.id === currentId);
    const next = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
    if (!next) return;

    // Play beep to signal transition, then navigate
    const beep = new Audio('/beep.wav');
    beep.play().catch(() => {});
    beep.addEventListener('ended', () => {
      load(next);
      if (typeof navigate === 'function') navigate('#reader/' + next.id);
    });
  }

  function markFinished(id) {
    if (!id) return;
    fetch('/api/videos/' + id + '/finished', { method: 'POST' }).catch(() => {});
  }

  // ── Seek ─────────────────────────────────────────────────────────────────────

  function seekBack(secs) {
    if (!audio.src) return;
    audio.currentTime = Math.max(0, audio.currentTime - secs);
  }

  // ── Reader link ──────────────────────────────────────────────────────────────

  function openCurrentReader() {
    if (!currentId) return;
    if (typeof navigate === 'function') navigate('#reader/' + currentId);
  }

  // ── UI updates ───────────────────────────────────────────────────────────────

  function updateMiniPlayerMeta(meta) {
    elTitle.textContent   = (meta.emoji ? meta.emoji + ' ' : '') + (meta.title || '');
    elChannel.textContent = meta.channel_name || '';
  }

  function setPlayBtnIcon(state) {
    const icons = { idle: '▶', paused: '▶', playing: '⏸', generating: '…', generate: '⬇' };
    elPlayPause.textContent = icons[state] || '▶';
    elPlayPause.title = state === 'generating' ? 'Generating audio…'
      : state === 'generate'    ? 'Generate audio'
      : audio.paused ? 'Play' : 'Pause';
  }

  function updatePlayBtn() {
    setPlayBtnIcon(audio.paused ? 'paused' : 'playing');
  }

  function onTimeUpdate() {
    if (!audio.duration) return;
    elProgress.style.width = (audio.currentTime / audio.duration * 100) + '%';
    // Save position every ~5s (on timeupdate fires ~4/s, save every ~20)
    if (Math.round(audio.currentTime) % 5 === 0 && currentId) {
      savePosition(currentId, audio.currentTime);
    }
  }

  // ── Position persistence ─────────────────────────────────────────────────────

  function savePosition(id, t) {
    try { localStorage.setItem('pos-' + id, String(t)); } catch {}
  }

  function loadSavedPosition(id) {
    try { return parseFloat(localStorage.getItem('pos-' + id) || '') || 0; } catch { return 0; }
  }

  function clearSavedPosition(id) {
    try { localStorage.removeItem('pos-' + id); } catch {}
  }

  // ── MediaSession ─────────────────────────────────────────────────────────────

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play',  () => { audio.play().catch(() => {}); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBack(10));
    navigator.mediaSession.setActionHandler('seekforward',  () => seekBack(-10));
    navigator.mediaSession.setActionHandler('previoustrack', () => seekBack(10));
    navigator.mediaSession.setActionHandler('nexttrack', nextInQueue);

    audio.addEventListener('play', () => {
      if (!currentMeta) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  currentMeta.title,
        artist: currentMeta.channel_name,
      });
      navigator.mediaSession.playbackState = 'playing';
    });
    audio.addEventListener('pause', () => {
      navigator.mediaSession.playbackState = 'paused';
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.Player = {
    get currentId()   { return currentId; },
    get audio()       { return audio; },
    get isPlaying()   { return !audio.paused; },
    get queue()       { return queue; },

    load,
    setQueue,
    seekBack,
    nextInQueue,
    triggerGenerate,

    // Expose for reader view to check
    getCachedStatus: () => cachedStatus,
    getSourceSpeed:  (key) => sourceSpeeds[key] || 1.0,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
