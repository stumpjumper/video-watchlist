(function () {
  const { videoId, title, channelName, initialLabelIds, isGenerating } = window.READER_DATA;
  const VIDEO_ID     = videoId;
  const AUTOPLAY_KEY = 'reader-autoplay';
  const POS_KEY      = 'reader-pos-' + VIDEO_ID;

  // ── Audio player ──────────────────────────────────────────────────────────
  const audio = document.getElementById('audio');
  if (audio) {
    const playBtn     = document.getElementById('play-btn');
    const skipBack    = document.getElementById('skip-back');
    const skipFwd     = document.getElementById('skip-fwd');
    const speedSelect = document.getElementById('speed-select');
    const timeLbl     = document.getElementById('time-display');
    const bar         = document.getElementById('progress-bar');
    const fill        = document.getElementById('progress-fill');
    const autoplayBtn = document.getElementById('autoplay-btn');
    const nextStatus  = document.getElementById('next-status');

    // ── Autoplay toggle ──────────────────────────────────────────────────
    let autoplay = localStorage.getItem(AUTOPLAY_KEY) !== 'false';
    function renderAutoplay() {
      autoplayBtn.textContent = '↻ Auto';
      autoplayBtn.className   = 'btn-ghost' + (autoplay ? ' active' : '');
      autoplayBtn.title       = autoplay ? 'Autoplay on — click to disable' : 'Autoplay off — click to enable';
    }
    renderAutoplay();
    autoplayBtn.addEventListener('click', () => {
      autoplay = !autoplay;
      localStorage.setItem(AUTOPLAY_KEY, String(autoplay));
      renderAutoplay();
    });

    // ── Auto-mode hint on page load ──────────────────────────────────────
    if (autoplay) {
      nextStatus.textContent = 'Auto-mode · tap ▶ on headphones to play';
      audio.addEventListener('play', () => { nextStatus.textContent = ''; }, { once: true });
    }

    // ── Position save / restore ──────────────────────────────────────────
    function savePos() {
      if (audio.currentTime > 5 && !audio.ended)
        localStorage.setItem(POS_KEY, String(Math.floor(audio.currentTime)));
    }
    const savedPos = parseFloat(localStorage.getItem(POS_KEY) || '0');
    audio.addEventListener('loadedmetadata', () => {
      if (savedPos > 5 && audio.duration && savedPos < audio.duration - 2)
        audio.currentTime = savedPos;
      updateTime();
    });
    audio.addEventListener('pause', savePos);
    document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });
    setInterval(() => { if (!audio.paused && !audio.ended) savePos(); }, 5000);

    // ── Playback helpers ─────────────────────────────────────────────────
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
      navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: channelName });
      navigator.mediaSession.setActionHandler('play',          () => audio.play());
      navigator.mediaSession.setActionHandler('pause',         () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
      navigator.mediaSession.setActionHandler('seekbackward',  () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
      navigator.mediaSession.setActionHandler('nexttrack',     () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
      navigator.mediaSession.setActionHandler('seekforward',   () => { audio.currentTime = Math.min(audio.duration, audio.currentTime + 30); });
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

    // ── Ready beep (uses existing audio element — already has iOS permission) ──
    async function playReadyBeep() {
      try {
        audio.src = '/beep.wav';
        audio.currentTime = 0;
        await audio.play();
        await new Promise(function(resolve) {
          audio.addEventListener('ended', resolve, { once: true });
        });
      } catch (e) {}
    }

    // ── Ended: mark done + autoplay next ────────────────────────────────
    audio.addEventListener('ended', async () => {
      updatePlay();
      localStorage.removeItem(POS_KEY);

      fetch('/api/videos/' + VIDEO_ID + '/finished', { method: 'POST' }).catch(() => {});

      if (!autoplay) return;

      try {
        const r    = await fetch('/api/videos/' + VIDEO_ID + '/next' + location.search);
        const next = await r.json();
        if (!next) { nextStatus.textContent = 'End of list'; return; }

        nextStatus.textContent = (next.has_audio ? 'Next: ' : 'Generating: ') + next.title + '…';

        if (!next.has_audio) {
          const gr = await fetch('/api/videos/' + next.id + '/audio', { method: 'POST' });
          const gd = await gr.json();
          if (gd.status !== 'ready') {
            const waitResult = await new Promise(function (resolve) {
              var attempts = 0;
              var timer = setInterval(async function () {
                attempts++;
                if (attempts > 30) { clearInterval(timer); resolve('timeout'); return; }
                try {
                  var sr = await fetch('/api/videos/' + next.id + '/audio/status');
                  var sd = await sr.json();
                  if (sd.status === 'ready')       { clearInterval(timer); resolve('ready'); }
                  else if (sd.status === 'failed') { clearInterval(timer); resolve('failed'); }
                } catch (e) {}
              }, 4000);
            });
            if (waitResult !== 'ready') {
              nextStatus.textContent = 'Generation failed: ' + next.title;
              return;
            }
          }
        }

        localStorage.removeItem('reader-pos-' + next.id);
        nextStatus.textContent = 'Tap ▶ on headphones · ' + next.title;
        await playReadyBeep();
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
    function poll(id) {
      var attempts = 0;
      function tick() {
        setTimeout(async function () {
          attempts++;
          if (attempts > 30) {
            genStatus.className  = 'action-status error';
            genStatus.textContent = 'Timed out waiting for audio — try again';
            genBtn.disabled      = false;
            genBtn.textContent   = '🎧 Retry';
            return;
          }
          try {
            const r = await fetch('/api/videos/' + id + '/audio/status');
            const d = await r.json();
            if (d.status === 'ready') {
              location.replace('/reader/' + id + location.search);
            } else if (d.status === 'failed') {
              genStatus.className   = 'action-status error';
              genStatus.textContent = 'Failed: ' + (d.error || 'unknown error');
              genBtn.disabled       = false;
              genBtn.textContent    = '🎧 Retry';
            } else {
              tick();
            }
          } catch (e) { tick(); }
        }, 4000);
      }
      tick();
    }

    if (isGenerating) poll(VIDEO_ID);

    genBtn.addEventListener('click', async () => {
      genBtn.disabled       = true;
      genBtn.textContent    = '🎧 Generating…';
      genStatus.className   = 'action-status';
      genStatus.textContent = 'Fetching article & generating audio…';
      try {
        const res  = await fetch('/api/videos/' + VIDEO_ID + '/audio', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'ready')      { location.reload(); return; }
        if (data.status === 'generating') { poll(VIDEO_ID); return; }
        genStatus.className   = 'action-status error';
        genStatus.textContent = 'Error: ' + (data.error || 'unknown');
        genBtn.disabled       = false;
        genBtn.textContent    = '🎧 Retry';
      } catch (e) {
        genStatus.className   = 'action-status error';
        genStatus.textContent = 'Network error — try again';
        genBtn.disabled       = false;
        genBtn.textContent    = '🎧 Retry';
      }
    });
  }

  // ── Article text ──────────────────────────────────────────────────────────
  const bodyEl = document.getElementById('article-body');
  fetch('/api/videos/' + VIDEO_ID + '/text')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.text) {
        bodyEl.innerHTML = d.text
          .split(/\n{2,}/)
          .map(function (p) { return '<p>' + p.replace(/\n/g, ' ').trim() + '</p>'; })
          .filter(function (p) { return p !== '<p></p>'; })
          .join('');
      } else {
        bodyEl.innerHTML = '<p class="article-body-loading">Generate audio to load article text.</p>';
      }
    })
    .catch(function () {
      bodyEl.innerHTML = '<p class="article-body-loading">Could not load article text.</p>';
    });

  // ── Labels modal ──────────────────────────────────────────────────────────
  var currentLabelIds = initialLabelIds;
  var allLabels       = [];
  var labelsOverlay   = document.getElementById('labels-overlay');
  var labelList       = document.getElementById('label-picker-list');
  var applyBtn        = document.getElementById('labels-apply-btn');
  var cancelBtn       = document.getElementById('labels-cancel-btn');
  var btnLabels       = document.getElementById('btn-reader-labels');

  btnLabels.addEventListener('click', async function () {
    try {
      var r  = await fetch('/api/labels');
      allLabels = await r.json();
      var html = '';
      allLabels.forEach(function (lbl) {
        var sel = currentLabelIds.includes(lbl.id);
        html += '<div class="label-picker-item' + (sel ? ' selected' : '') + '" data-id="' + lbl.id + '">'
          + '<div class="label-picker-check">' + (sel ? '✓' : '') + '</div>'
          + '<span class="label-picker-name">' + lbl.name + '</span>'
          + '</div>';
      });
      labelList.innerHTML = html;
      labelList.querySelectorAll('.label-picker-item').forEach(function (item) {
        item.addEventListener('click', function () {
          var sel = item.classList.contains('selected');
          item.classList.toggle('selected', !sel);
          item.querySelector('.label-picker-check').textContent = sel ? '' : '✓';
        });
      });
      labelsOverlay.classList.add('open');
    } catch (e) {
      alert('Could not load labels');
    }
  });

  applyBtn.addEventListener('click', async function () {
    var selected = Array.from(labelList.querySelectorAll('.label-picker-item.selected'))
      .map(function (el) { return parseInt(el.dataset.id, 10); });
    try {
      await fetch('/api/videos/' + VIDEO_ID + '/labels', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ labelIds: selected }),
      });
      currentLabelIds = selected;
      labelsOverlay.classList.remove('open');
    } catch (e) {
      alert('Failed to update labels');
    }
  });

  cancelBtn.addEventListener('click', function () { labelsOverlay.classList.remove('open'); });
  labelsOverlay.addEventListener('click', function (e) {
    if (e.target === labelsOverlay) labelsOverlay.classList.remove('open');
  });
})();
