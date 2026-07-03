// AudioEngine — owns the single <audio> element and mini-player DOM state.
// Exposed globally as window.Player.

(function () {
  'use strict';

  const audio = document.createElement('audio');
  audio.preload = 'none';
  document.body.appendChild(audio);

  // Mini-player DOM refs (set once after DOM ready)
  let elTitle, elChannel, elScrub, elTime, elPlayPause, elSeekBack, elSeekFwd, elSpeedBadge, elInfo, elSpeedPicker;

  const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

  // State
  let isDragging     = false;
  let currentId      = null;
  let currentMeta    = null;   // { id, title, channel_name, emoji, source, content_type }
  let cachedStatus   = null;   // last fetched { status, url, error }
  let pollTimer      = null;
  let queue          = [];     // array of full video meta objects, in display order
  let sourceSpeeds   = {};     // source_key → default_speed

  // ── Initialise ──────────────────────────────────────────────────────────────

  async function init() {
    elTitle       = document.getElementById('mp-title');
    elChannel     = document.getElementById('mp-channel');
    elScrub       = document.getElementById('mp-scrub');
    elTime        = document.getElementById('mp-time');
    elPlayPause   = document.getElementById('mp-play-pause');
    elSeekBack    = document.getElementById('mp-seek-back');
    elSpeedBadge  = document.getElementById('mp-speed-badge');
    elInfo        = document.getElementById('mp-info');
    elSpeedPicker = document.getElementById('mp-speed-picker');

    // Wire mini-player controls
    elPlayPause.addEventListener('click', handlePlayPause);
    elSeekBack.addEventListener('click', () => seekBack(10));
    elSeekFwd  = document.getElementById('mp-seek-fwd');
    elSeekFwd.addEventListener('click', () => seekBack(-30));
    elInfo.addEventListener('click', openCurrentReader);
    elSpeedBadge.addEventListener('click', toggleSpeedPicker);

    // Close speed picker on outside tap
    document.addEventListener('click', e => {
      if (elSpeedPicker.classList.contains('open') &&
          !elSpeedPicker.contains(e.target) && e.target !== elSpeedBadge) {
        elSpeedPicker.classList.remove('open');
      }
    }, true);

    // Scrub bar drag handling
    elScrub.addEventListener('input', () => {
      isDragging = true;
      if (audio.duration) {
        const t = (elScrub.value / 1000) * audio.duration;
        elTime.textContent = fmtTime(t) + ' / ' + fmtTime(audio.duration);
        updateScrubFill(elScrub.value / 10);
      }
    });
    elScrub.addEventListener('change', () => {
      isDragging = false;
      if (audio.duration) audio.currentTime = (elScrub.value / 1000) * audio.duration;
    });

    // Audio events
    audio.addEventListener('play',  updatePlayBtn);
    audio.addEventListener('pause', updatePlayBtn);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onTimeUpdate);
    audio.addEventListener('error', e => {
      if (!currentId) return;
      console.error('[player] audio error', e, audio.error);
      const code = audio.error ? audio.error.code : '?';
      speak('Audio error code ' + code + '.');
      audio.removeAttribute('src'); // clear error state so next play attempt starts fresh
      // If audio was already downloaded, keep ▶ so user can retry — not ⬇ which implies re-downloading
      if (cachedStatus && cachedStatus.status === 'ready') {
        setPlayBtnIcon('paused');
        elPlayPause.disabled = false;
      } else {
        setPlayBtnIcon('generate');
      }
    });

    setupMediaSession();

    // Load source speeds from server
    try {
      const sources = await fetch('/api/sources').then(r => r.json());
      for (const s of sources) sourceSpeeds[s.source_key] = s.default_speed;
    } catch {}

    // Register service worker for offline audio caching
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  function speak(msg) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(msg));
  }

  function preCacheAudio(ids) {
    if (!navigator.serviceWorker?.controller || !ids.length) return;
    navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE_AUDIO', ids });
  }

  function preCacheNext() {
    if (!queue.length || !currentId) return;
    const idx = queue.findIndex(v => v.id === currentId);
    const upcoming = queue.slice(idx + 1, idx + 4)
      .filter(v => v.content_type === 'article' && v.audio_status === 'ready')
      .map(v => v.id);
    preCacheAudio(upcoming);
  }

  // ── Load a video into the player ────────────────────────────────────────────

  async function load(meta) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

    // Autoplay path: audio already started for this id — just refresh UI/meta without disrupting playback
    if (!audio.paused && String(currentId) === String(meta.id)) {
      currentMeta = meta;
      const speed = sourceSpeeds[meta.source] || 1.0;
      audio.playbackRate = speed;
      updateSpeedBadge(speed);
      updateMiniPlayerMeta(meta);
      elPlayPause.disabled = false;
      elScrub.disabled     = false;
      elSeekBack.disabled  = false;
      elSeekFwd.disabled   = false;
      updatePlayBtn();
      fetch('/api/videos/' + meta.id + '/audio/status').then(r => r.json())
        .then(s => { cachedStatus = s; }).catch(() => {});
      return;
    }

    currentId   = meta.id;
    currentMeta = meta;
    cachedStatus = null;

    updateMiniPlayerMeta(meta);
    setPlayBtnIcon('idle');
    elTime.textContent   = '';
    elScrub.disabled     = true;
    elScrub.value        = 0;
    updateScrubFill(0);
    elSeekBack.disabled  = true;
    elSeekFwd.disabled   = true;
    elPlayPause.disabled = true;

    const speed = sourceSpeeds[meta.source] || 1.0;
    updateSpeedBadge(speed);

    try {
      const status = await fetch('/api/videos/' + meta.id + '/audio/status').then(r => r.json());
      cachedStatus = status;
      if (status.status === 'ready') {
        elPlayPause.disabled = false;
        elScrub.disabled     = false;
        elSeekBack.disabled  = audio.paused;
        elSeekFwd.disabled   = audio.paused;
        updatePlayBtn();
      } else if (status.status === 'generating') {
        setPlayBtnIcon('generating');
        startPolling();
      } else {
        // none / failed / deleted — audio not yet generated; reader button is the entry point
        elPlayPause.disabled = true;
        setPlayBtnIcon('generating');
      }
    } catch {
      cachedStatus = { status: 'none' };
      elPlayPause.disabled = true;
      setPlayBtnIcon('generating');
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
          audio.play().catch(err => { console.error('[player] play failed', err); speak('Play failed: ' + err.message); });
        } else {
          // Set src synchronously, then play — iOS allows this
          audio.src = cachedStatus.url;
          const speed = sourceSpeeds[currentMeta.source] || 1.0;
          audio.playbackRate = speed;
          // Restore saved position
          const saved = loadSavedPosition(currentId);
          audio.play().then(() => {
            if (saved && saved < audio.duration - 2) audio.currentTime = saved;
          }).catch(err => { console.error('[player] play failed', err); speak('Play failed: ' + err.message); });
        }
        elScrub.disabled    = false;
        elSeekBack.disabled = false;
        elSeekFwd.disabled  = false;
      } else {
        audio.pause();
        savePosition(currentId, audio.currentTime);
      }
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
        updatePlayBtn();
      } else {
        startPolling();
      }
    } catch {
      cachedStatus = { status: 'failed', error: 'Network error' };
      elPlayPause.disabled = false;
      setPlayBtnIcon('generate');
      speak('Audio generation failed: network error.');
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
          elScrub.disabled     = false;
          updatePlayBtn();
        } else if (data.status === 'failed') {
          clearInterval(pollTimer); pollTimer = null;
          cachedStatus = data;
          elPlayPause.disabled = false;
          setPlayBtnIcon('generate');
          speak('Audio generation failed' + (data.error ? ': ' + data.error : '') + '.');
        }
      } catch {}
    }, 2000);
  }

  // ── Queue management ─────────────────────────────────────────────────────────

  function setQueue(videos) {
    queue = videos || [];
  }

  function nextInQueue() {
    if (!currentId || !queue.length) return;
    const idx = queue.findIndex(v => v.id === currentId);
    const next = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
    if (next) {
      if (typeof navigate === 'function') navigate('#reader/' + next.id);
    }
  }

  // ── Auto-advance on ended ────────────────────────────────────────────────────

  function onEnded() {
    updatePlayBtn();
    markFinished(currentId);
    clearSavedPosition(currentId);

    const autoplay = localStorage.getItem('v6-autoplay') !== 'false';
    if (!autoplay) return;

    const idx = queue.findIndex(v => v.id === currentId);
    const next = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
    if (!next) {
      if (queue.length > 0) speak('End of playlist.');
      return;
    }

    // Pre-cache items after next before navigating
    preCacheNext();

    if (next.audio_status === 'ready') {
      // Start next audio synchronously while still in the audio ended event context (iOS allows this)
      currentId    = next.id;
      currentMeta  = next;
      cachedStatus = { status: 'ready', url: '/audio/' + next.id + '.m4a' };
      audio.src    = cachedStatus.url;
      audio.playbackRate = sourceSpeeds[next.source] || 1.0;
      audio.play().catch(() => {});
      updateMiniPlayerMeta(next);
      if (typeof navigate === 'function') navigate('#reader/' + next.id);
    } else {
      // Audio not ready — play beep, navigate, let user trigger generation from reader
      const beep = new Audio('/beep.wav');
      beep.play().catch(() => {});
      beep.addEventListener('ended', () => {
        if (typeof navigate === 'function') navigate('#reader/' + next.id);
      });
    }
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
    const icons = { idle: '▶', paused: '▶', playing: '⏸', generating: '…' };
    elPlayPause.textContent = icons[state] || '▶';
    elPlayPause.title = state === 'generating' ? 'Generating audio…'
      : state === 'generate'    ? 'Generate audio'
      : audio.paused ? 'Play' : 'Pause';
  }

  function updatePlayBtn() {
    setPlayBtnIcon(audio.paused ? 'paused' : 'playing');
  }

  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) return '--:--';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function onTimeUpdate() {
    if (!audio.duration) return;
    if (!isDragging) {
      const pct = audio.currentTime / audio.duration;
      elScrub.value = Math.round(pct * 1000);
      updateScrubFill(pct * 100);
    }
    elTime.textContent = fmtTime(audio.currentTime) + ' / ' + fmtTime(audio.duration);
    if (Math.round(audio.currentTime) % 5 === 0 && currentId) {
      savePosition(currentId, audio.currentTime);
    }
  }

  function updateScrubFill(pct) {
    const p = pct.toFixed(1);
    elScrub.style.background =
      'linear-gradient(to right, var(--accent) 0%, var(--accent) ' + p + '%, rgba(255,255,255,0.07) ' + p + '%, rgba(255,255,255,0.07) 100%)';
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

  // ── Speed picker ─────────────────────────────────────────────────────────────

  function updateSpeedBadge(speed) {
    const label = Number.isInteger(speed) ? speed + '×' : speed.toFixed(2).replace(/\.?0+$/, '') + '×';
    elSpeedBadge.textContent = label;
    elSpeedBadge.style.display = '';
  }

  function toggleSpeedPicker() {
    if (elSpeedPicker.classList.contains('open')) {
      elSpeedPicker.classList.remove('open'); return;
    }
    const cur = audio.playbackRate || 1.0;
    elSpeedPicker.innerHTML = SPEED_PRESETS.map(s => {
      const label = Number.isInteger(s) ? s + '×' : s + '×';
      return '<button class="mp-speed-opt' + (Math.abs(s - cur) < 0.01 ? ' current' : '') +
        '" data-speed="' + s + '">' + label + '</button>';
    }).join('');
    elSpeedPicker.querySelectorAll('.mp-speed-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        updateSpeedBadge(speed);
        elSpeedPicker.classList.remove('open');
      });
    });
    elSpeedPicker.classList.add('open');
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
