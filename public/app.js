// SPA router + list/reader views.
// Requires window.Player (loaded by player.js first).

(function () {
  'use strict';

  // ── Router ───────────────────────────────────────────────────────────────────

  function navigate(hash) {
    window.location.hash = hash;
  }
  window.navigate = navigate; // exposed for player.js

  function route() {
    const hash = window.location.hash || '#list';
    if (hash === '#list' || hash === '' || hash === '#') {
      showListView();
    } else if (hash.startsWith('#reader/')) {
      const id = parseInt(hash.slice(8), 10);
      if (!isNaN(id)) showReaderView(id);
      else showListView();
    } else {
      showListView();
    }
  }

  window.addEventListener('hashchange', route);

  // ── Shared utils ─────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateShort(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function openUrl(url) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:0;width:2em;height:2em;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    if (ok) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text).catch(() => Promise.resolve());
    return Promise.resolve();
  }

  const CATEGORY_NAMES = { youtube: 'YouTube', ars_technica: 'Ars Technica' };
  function categoryDisplayName(s) {
    return CATEGORY_NAMES[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── List view state ──────────────────────────────────────────────────────────

  let current        = null;
  let fetchTimer     = null;
  let sortBy         = 'added_at';
  let sortDir        = 'desc';
  let allLabels      = [];
  let selectedIds    = new Set();
  let trashActive    = false;
  let activeCategory = '';
  let filterText     = '';
  let filterLabels   = [];
  let filterMode     = 'or';
  let filterAfter    = '';
  let filterBefore   = '';
  let listVideos     = [];   // last loaded list (for player queue)

  const STATE_KEY = 'watchlist-state';

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        filterText, filterLabels, filterMode, filterAfter, filterBefore,
        sortBy, sortDir, activeCategory, trashActive, scrollY: window.scrollY,
      }));
    } catch {}
  }

  function restoreListState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (!saved) return 0;
      filterText     = saved.filterText     || '';
      filterLabels   = saved.filterLabels   || [];
      filterMode     = saved.filterMode     || 'or';
      filterAfter    = saved.filterAfter    || '';
      filterBefore   = saved.filterBefore   || '';
      sortBy         = saved.sortBy         || 'added_at';
      sortDir        = saved.sortDir        || 'desc';
      activeCategory = saved.activeCategory || '';
      trashActive    = !!saved.trashActive;
      return saved.scrollY || 0;
    } catch {}
    return 0;
  }

  // ── List view render ─────────────────────────────────────────────────────────

  function buildListHTML() {
    return `
<div class="list-container">
  <div class="list-header-row">
    <h1>📺 Watchlist</h1>
    <span class="count" id="count"></span>
    <button class="btn-ghost sm" id="btn-labels">Labels</button>
    <button class="btn-ghost sm trash-btn" id="btn-show-trash">Trash</button>
    <button class="btn-ghost sm add-btn" id="btn-show-add">+ Add</button>
  </div>

  <div class="filter-row">
    <input type="search" class="filter-search" id="filter-text" placeholder="Search title or channel…"
      autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(filterText)}">
    <select id="category-filter" class="category-select">
      <option value="">All</option>
    </select>
    <button class="btn-ghost" id="btn-filter-labels">Filter</button>
  </div>

  <div class="sort-row">
    <span class="sort-label">Sort</span>
    <select id="sort-field" class="sort-select">
      <option value="added_at"${sortBy === 'added_at' ? ' selected' : ''}>Date added</option>
      <option value="status"${sortBy === 'status' ? ' selected' : ''}>Status</option>
      <option value="channel_name"${sortBy === 'channel_name' ? ' selected' : ''}>Channel</option>
      <option value="title"${sortBy === 'title' ? ' selected' : ''}>Title</option>
    </select>
    <button class="sort-dir ${sortDir}" id="sort-dir" title="Toggle sort direction">${sortDir === 'asc' ? '↑' : '↓'}</button>
  </div>

  <div class="list-col-header" aria-hidden="true">
    <span>Channel</span><span>Title</span><span>Status</span><span>Added</span>
  </div>

  <div class="bulk-bar" id="bulk-bar" style="${trashActive ? '' : 'display:none'}">
    <button class="bulk-btn sel-all" id="btn-select-all">Select all</button>
    <span class="bulk-count" id="bulk-count">0 selected</span>
    <button class="bulk-btn restore" id="btn-bulk-restore" disabled>Restore</button>
    <button class="bulk-btn del"     id="btn-bulk-delete"  disabled>Delete</button>
  </div>

  <ul id="list"></ul>
  <div class="empty" id="empty" style="display:none">Nothing here.</div>
</div>`;
  }

  function wireListHandlers() {
    document.getElementById('btn-labels').addEventListener('click', openLabelsModal);
    document.getElementById('btn-show-trash').addEventListener('click', () => {
      trashActive = !trashActive; selectedIds.clear(); load();
    });
    document.getElementById('btn-show-add').addEventListener('click', openAddModal);
    document.getElementById('sort-field').addEventListener('change', e => { sortBy = e.target.value; load(); });
    document.getElementById('sort-dir').addEventListener('click', () => {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      const btn = document.getElementById('sort-dir');
      btn.textContent = sortDir === 'asc' ? '↑' : '↓';
      btn.className   = 'sort-dir ' + sortDir;
      load();
    });
    document.getElementById('btn-filter-labels').addEventListener('click', () => {
      buildFilterModal(); document.getElementById('filter-overlay').classList.add('open');
    });
    document.getElementById('filter-text').addEventListener('input', e => {
      clearTimeout(fetchTimer);
      filterText = e.target.value.trim();
      fetchTimer = setTimeout(load, 300);
    });
    document.getElementById('btn-select-all').addEventListener('click', () => {
      const cards = document.querySelectorAll('#list .video-card.selectable');
      const allSel = cards.length > 0 && [...cards].every(c => c.classList.contains('selected'));
      if (allSel) { cards.forEach(c => { c.classList.remove('selected'); selectedIds.delete(c.dataset.id); }); }
      else        { cards.forEach(c => { c.classList.add('selected');    selectedIds.add(c.dataset.id);    }); }
      updateBulkBar();
    });
    document.getElementById('btn-bulk-restore').addEventListener('click', function () {
      confirmBulkAction(this, async () => {
        await Promise.all([...selectedIds].map(id =>
          fetch('/api/videos/' + id + '/restore', { method: 'POST' })));
        selectedIds.clear(); load();
      });
    });
    document.getElementById('btn-bulk-delete').addEventListener('click', function () {
      confirmBulkAction(this, async () => {
        await Promise.all([...selectedIds].map(id =>
          fetch('/api/videos/' + id, { method: 'DELETE' })));
        selectedIds.clear(); load();
      });
    });
    document.getElementById('list').addEventListener('click', onListClick);
    document.getElementById('category-filter').addEventListener('change', e => {
      activeCategory = e.target.value;
      e.target.classList.toggle('active', !!activeCategory);
      load();
    });
  }

  let listEverMounted = false;

  function readSavedScrollY() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null')?.scrollY || 0; } catch { return 0; }
  }

  async function showListView() {
    const view = document.getElementById('view');
    const alreadyInDom = !!view.querySelector('.list-container');
    let scrollToY = 0;
    if (!alreadyInDom) {
      scrollToY = listEverMounted ? readSavedScrollY() : restoreListState();
      view.innerHTML = buildListHTML();
      wireListHandlers();
      listEverMounted = true;
    } else {
      scrollToY = readSavedScrollY();
    }

    updateFilterBtn();

    const trashBtn = document.getElementById('btn-show-trash');
    if (trashBtn) {
      trashBtn.classList.toggle('active', trashActive);
      document.getElementById('bulk-bar').style.display = trashActive ? '' : 'none';
    }

    await loadLabels();
    await loadCategories();
    await load();
    if (scrollToY) window.scrollTo(0, scrollToY);
  }

  function buildFilterParams() {
    const p = new URLSearchParams();
    const activeLabels = trashActive ? [2, ...filterLabels] : filterLabels;
    if (filterText)           p.set('q',         filterText);
    if (activeLabels.length)  p.set('labels',     activeLabels.join(','));
    if (activeLabels.length > 1) p.set('label_mode', trashActive ? 'and' : filterMode);
    if (filterAfter)          p.set('after',      filterAfter);
    if (filterBefore)         p.set('before',     filterBefore);
    if (activeCategory)       p.set('source',     activeCategory);
    return p;
  }

  async function loadLabels() {
    allLabels = await fetch('/api/labels').then(r => r.json());
  }

  function userLabels() {
    return allLabels.filter(l => l.id !== 1 && l.id !== 2);
  }

  async function loadCategories() {
    try {
      const cats = await fetch('/api/categories').then(r => r.json());
      const sel = document.getElementById('category-filter');
      if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      for (const cat of cats) {
        const opt = document.createElement('option');
        opt.value = cat.source;
        opt.textContent = categoryDisplayName(cat.source) + ' (' + cat.count + ')';
        sel.appendChild(opt);
      }
      if (activeCategory) { sel.value = activeCategory; sel.classList.add('active'); }
    } catch {}
  }

  async function load() {
    const params = buildFilterParams();
    const data = await fetch('/api/videos?' + params).then(r => r.json());
    listVideos = data.videos || [];
    render(listVideos);
    updateTrashBtn(data.trash_count || 0);
    Player.setQueue(listVideos);
    saveState();
  }

  function sortVideos(videos) {
    const statusOrder = { new: 0, started: 1 };
    return [...videos].sort((a, b) => {
      let va, vb;
      if (sortBy === 'added_at') {
        va = new Date(a.added_at).getTime(); vb = new Date(b.added_at).getTime();
      } else if (sortBy === 'status') {
        va = statusOrder[a.status] ?? 9; vb = statusOrder[b.status] ?? 9;
      } else {
        va = (a[sortBy] || '').toLowerCase(); vb = (b[sortBy] || '').toLowerCase();
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  function render(videos) {
    const listEl  = document.getElementById('list');
    const emptyEl = document.getElementById('empty');
    const countEl = document.getElementById('count');
    if (!listEl) return;

    if (!videos.length) {
      listEl.innerHTML = ''; emptyEl.style.display = ''; countEl.textContent = ''; return;
    }
    emptyEl.style.display = 'none';
    const nNew      = videos.filter(v => v.status === 'new').length;
    const nStarted  = videos.filter(v => v.status === 'started').length;
    const nFinished = videos.filter(v => v.status === 'finished').length;
    countEl.textContent = [
      nNew      && nNew      + ' new',
      nStarted  && nStarted  + ' started',
      nFinished && nFinished + ' finished',
    ].filter(Boolean).join(', ');

    const trash = trashActive;
    listEl.innerHTML = sortVideos(videos).map(v => {
      const badge = v.status === 'finished'
        ? '<span class="badge badge-finished">Finished</span>'
        : v.status === 'started'
          ? '<span class="badge badge-started">Started</span>'
          : '<span class="badge badge-new">New</span>';
      const displayLabels = trash
        ? (v.labels || [])
        : (v.labels || []).filter(l => l.label_id !== 2);
      const chipsHtml = displayLabels.length
        ? '<div class="card-chips-row label-chips">' +
          displayLabels.map(l =>
            '<span class="label-chip">' + esc(l.label_name) +
            ' <span class="label-chip-date">· ' + fmtDateShort(l.labeled_at) + '</span></span>'
          ).join('') + '</div>'
        : '';
      const labelsJson = esc(JSON.stringify(v.labels || []));
      const sel = selectedIds.has(String(v.id));
      return '<li class="video-card' + (trash ? ' selectable' : '') + (sel ? ' selected' : '') + '"' +
        ' data-id="' + v.id + '" data-title="' + esc(v.title) + '"' +
        ' data-url="' + esc(v.url) + '" data-status="' + v.status + '"' +
        ' data-content-type="' + esc(v.content_type || 'video') + '"' +
        ' data-source="' + esc(v.source || 'youtube') + '"' +
        ' data-emoji="' + esc(v.emoji || '') + '"' +
        ' data-channel="' + esc(v.channel_name || '') + '"' +
        ' data-summary="' + esc(v.summary || '') + '"' +
        ' data-labels="' + labelsJson + '">' +
        '<span class="card-channel">' + esc(v.emoji) + ' ' + esc(v.channel_name) + '</span>' +
        '<span class="card-title">' + esc(v.title) + '</span>' +
        '<div class="card-footer">' +
          '<span class="card-badge">' + badge + '</span>' +
          '<span class="card-date">' + fmtDate(v.published_at || v.added_at) + '</span>' +
          '<div class="card-actions">' +
            (trash ? '' : '<button class="card-menu-btn" data-id="' + v.id + '" title="More options">···</button>') +
            '<button class="card-trash-btn" data-id="' + v.id + '" title="Move to Trash">🗑</button>' +
          '</div>' +
        '</div>' +
        chipsHtml +
        '</li>';
    }).join('');
  }

  function updateTrashBtn(count) {
    const btn = document.getElementById('btn-show-trash');
    if (!btn) return;
    btn.textContent = trashActive ? 'Exit Trash' : (count > 0 ? 'Trash (' + count + ')' : 'Trash');
    btn.classList.toggle('has-items', !trashActive && count > 0);
    btn.classList.toggle('active', trashActive);
    const bar = document.getElementById('bulk-bar');
    if (bar) bar.style.display = trashActive ? '' : 'none';
    if (!trashActive) selectedIds.clear();
    updateBulkBar();
  }

  function updateTrashBtnClass(count) { updateTrashBtn(count); }

  function updateBulkBar() {
    const n = selectedIds.size;
    const el = document.getElementById('bulk-count');
    if (el) el.textContent = n === 0 ? '0 selected' : n + ' selected';
    const btnR = document.getElementById('btn-bulk-restore');
    const btnD = document.getElementById('btn-bulk-delete');
    if (btnR) btnR.disabled = n === 0;
    if (btnD) btnD.disabled = n === 0;
  }

  function confirmBulkAction(btn, onConfirm) {
    if (btn.dataset.confirm === 'pending') { onConfirm(); return; }
    btn.dataset.confirm = 'pending';
    const orig = btn.textContent;
    btn.textContent = 'Sure? (' + selectedIds.size + ')';
    btn.classList.add('confirming');
    btn._confirmTimer = setTimeout(() => {
      btn.dataset.confirm = ''; btn.textContent = orig;
    }, 3000);
  }

  // ── Card & action modal ──────────────────────────────────────────────────────

  async function onListClick(e) {
    const trashBtn = e.target.closest('.card-trash-btn');
    if (trashBtn) {
      await fetch('/api/videos/' + trashBtn.dataset.id + '/trash', { method: 'POST' });
      load(); return;
    }

    const menuBtn = e.target.closest('.card-menu-btn');
    if (menuBtn) {
      const card = menuBtn.closest('.video-card');
      if (!card) return;
      let labels = [];
      try { labels = JSON.parse(card.dataset.labels || '[]'); } catch {}
      current = {
        id: card.dataset.id, title: card.dataset.title, url: card.dataset.url,
        status: card.dataset.status, contentType: card.dataset.contentType || 'video',
        source: card.dataset.source || 'youtube', emoji: card.dataset.emoji || '',
        channel_name: card.dataset.channel || '', summary: card.dataset.summary || '', labels,
      };
      openMenuModal(current);
      return;
    }

    const card = e.target.closest('.video-card');
    if (!card) return;

    if (card.classList.contains('selectable')) {
      const id = card.dataset.id;
      if (selectedIds.has(id)) { selectedIds.delete(id); card.classList.remove('selected'); }
      else                     { selectedIds.add(id);    card.classList.add('selected');    }
      updateBulkBar(); return;
    }

    // Direct primary action — no modal
    const id          = card.dataset.id;
    const contentType = card.dataset.contentType || 'video';
    const url         = card.dataset.url;
    const status      = card.dataset.status;

    if (contentType === 'article') {
      if (status === 'new')
        fetch('/api/videos/' + id + '/started', { method: 'POST' }).catch(() => {});
      navigate('#reader/' + id);
    } else {
      openUrl(url);
      if (status === 'new')
        fetch('/api/videos/' + id + '/started', { method: 'POST' }).then(load);
    }
  }

  function openMenuModal(v) {
    document.getElementById('action-title').textContent       = v.title;
    document.getElementById('action-url').textContent         = v.url;
    document.getElementById('action-url-row').style.display   = '';
    document.getElementById('action-modal-label').textContent = (v.emoji ? v.emoji + ' ' : '') + v.channel_name;
    buildActionBtns(v.status, v.contentType);
    document.getElementById('action-overlay').classList.add('open');
  }

  function buildActionBtns(status, contentType) {
    const el = document.getElementById('action-btns');
    const isArticle = contentType === 'article';
    el.innerHTML =
      '<button class="btn btn-muted"   id="ab-source">Open original ↗</button>' +
      (!isArticle ? '<button class="btn btn-muted" id="ab-summary">Summary</button>' : '') +
      '<div class="modal-divider"></div>' +
      '<button class="btn btn-indigo"  id="ab-labels">Labels…</button>' +
      '<button class="btn btn-cancel"  id="ab-cancel">Cancel</button>';

    document.getElementById('ab-source').addEventListener('click', () => {
      if (!current) return;
      const url = current.url;
      openUrl(url); closeActionModal();
    });
    const summaryBtn = document.getElementById('ab-summary');
    if (summaryBtn) summaryBtn.addEventListener('click', () => {
      if (!current) return;
      const v = { ...current }; closeActionModal(); openSummaryOverlay(v);
    });
    document.getElementById('ab-labels').addEventListener('click', showLabelEditor);
    document.getElementById('ab-cancel').addEventListener('click', closeActionModal);
  }

  function showLabelEditor() {
    if (!current) return;
    document.getElementById('action-modal-label').textContent = 'Edit labels';
    document.getElementById('action-url-row').style.display = 'none';
    const currentLabelIds = (current.labels || []).map(l => l.label_id);
    const labeledAtMap = {};
    (current.labels || []).forEach(l => { labeledAtMap[l.label_id] = l.labeled_at; });
    const el = document.getElementById('action-btns');
    el.innerHTML =
      '<div class="label-picker" id="label-editor-picker">' +
      allLabels.map(l => {
        const on = currentLabelIds.includes(l.id);
        const since = on ? '<span class="label-picker-since">since ' + fmtDateShort(labeledAtMap[l.id]) + '</span>' : '';
        return '<div class="label-picker-item' + (on ? ' selected' : '') + '" data-label-id="' + l.id + '">' +
          '<span class="label-picker-check">' + (on ? '✓' : '') + '</span>' +
          '<span class="label-picker-name">' + esc(l.name) + '</span>' + since + '</div>';
      }).join('') +
      '</div>' +
      '<button class="btn btn-indigo" id="ab-labels-apply">Apply</button>' +
      '<button class="btn btn-cancel" id="ab-labels-back">Cancel</button>';

    document.getElementById('label-editor-picker').addEventListener('click', e => {
      const item = e.target.closest('.label-picker-item');
      if (!item) return;
      const on = item.classList.toggle('selected');
      item.querySelector('.label-picker-check').textContent = on ? '✓' : '';
    });
    document.getElementById('ab-labels-apply').addEventListener('click', async () => {
      if (!current) return;
      const selected = Array.from(
        document.querySelectorAll('#label-editor-picker .label-picker-item.selected')
      ).map(el => parseInt(el.dataset.labelId, 10));
      await fetch('/api/videos/' + current.id + '/labels', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelIds: selected }),
      });
      closeActionModal(); load();
    });
    document.getElementById('ab-labels-back').addEventListener('click', () => {
      document.getElementById('action-url-row').style.display = '';
      document.getElementById('action-modal-label').textContent =
        current ? (current.emoji ? current.emoji + ' ' : '') + current.channel_name : '';
      buildActionBtns(current.status, current.contentType);
    });
  }

  document.getElementById('btn-copy-url').addEventListener('click', () => {
    if (!current) return;
    copyText(current.url).then(() => {
      const btn = document.getElementById('btn-copy-url');
      btn.textContent = 'Copied!'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    });
  });
  document.getElementById('action-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('action-overlay')) closeActionModal();
  });

  function closeActionModal() {
    document.getElementById('action-overlay').classList.remove('open');
    current = null;
  }

  // ── Filter modal ─────────────────────────────────────────────────────────────

  function buildFilterModal() {
    const list = document.getElementById('filter-label-list');
    const nonSystem = allLabels.filter(l => l.id !== 2);
    list.innerHTML = nonSystem.map(l => {
      const sel = filterLabels.includes(l.id);
      return '<div class="filter-label-item' + (sel ? ' selected' : '') + '" data-label-id="' + l.id + '">' +
        '<span class="label-picker-check">' + (sel ? '✓' : '') + '</span>' +
        '<span class="filter-label-name">' + esc(l.name) + '</span></div>';
    }).join('');
    document.getElementById('filter-after').value  = filterAfter;
    document.getElementById('filter-before').value = filterBefore;
    updateFilterModeRow();
    list.querySelectorAll('.filter-label-item').forEach(item => {
      item.addEventListener('click', () => {
        const on = item.classList.toggle('selected');
        item.querySelector('.label-picker-check').textContent = on ? '✓' : '';
        updateFilterModeRow();
      });
    });
  }

  function updateFilterModeRow() {
    const selected = document.querySelectorAll('#filter-label-list .filter-label-item.selected');
    const row = document.getElementById('filter-mode-row');
    row.style.display = selected.length > 1 ? '' : 'none';
    document.getElementById('fmode-or').classList.toggle('active',  filterMode === 'or');
    document.getElementById('fmode-and').classList.toggle('active', filterMode === 'and');
  }

  document.getElementById('filter-mode-row').addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    filterMode = btn.dataset.mode;
    document.getElementById('fmode-or').classList.toggle('active',  filterMode === 'or');
    document.getElementById('fmode-and').classList.toggle('active', filterMode === 'and');
  });
  document.getElementById('filter-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('filter-overlay')) closeFilterModal();
  });
  document.getElementById('btn-filter-cancel').addEventListener('click', closeFilterModal);
  document.getElementById('btn-filter-apply').addEventListener('click', () => {
    filterLabels = Array.from(
      document.querySelectorAll('#filter-label-list .filter-label-item.selected')
    ).map(el => parseInt(el.dataset.labelId, 10));
    filterAfter  = document.getElementById('filter-after').value;
    filterBefore = document.getElementById('filter-before').value;
    closeFilterModal(); updateFilterBtn(); load();
  });
  document.getElementById('btn-filter-clear').addEventListener('click', () => {
    filterLabels = []; filterAfter = ''; filterBefore = '';
    document.querySelectorAll('#filter-label-list .filter-label-item.selected').forEach(el => {
      el.classList.remove('selected');
      el.querySelector('.label-picker-check').textContent = '';
    });
    document.getElementById('filter-after').value  = '';
    document.getElementById('filter-before').value = '';
    updateFilterModeRow(); updateFilterBtn(); closeFilterModal(); load();
  });

  function closeFilterModal() { document.getElementById('filter-overlay').classList.remove('open'); }

  function updateFilterBtn() {
    const hasFilter = filterLabels.length > 0 || filterAfter || filterBefore;
    const btn = document.getElementById('btn-filter-labels');
    if (!btn) return;
    btn.classList.toggle('active', hasFilter);
    const count = filterLabels.length + (filterAfter ? 1 : 0) + (filterBefore ? 1 : 0);
    btn.textContent = hasFilter ? 'Filter (' + count + ')' : 'Filter';
  }

  // ── Labels management modal ───────────────────────────────────────────────────

  async function openLabelsModal() {
    await loadLabels(); renderLabelsList();
    document.getElementById('labels-overlay').classList.add('open');
  }

  function renderLabelsList() {
    const list = document.getElementById('labels-list');
    const ul   = allLabels.filter(l => l.id !== 1 && l.id !== 2);
    if (!ul.length) {
      list.innerHTML = '<div style="color:var(--text-faint);font-size:14px;padding:8px 0">No labels yet.</div>';
      return;
    }
    list.innerHTML = ul.map(l =>
      '<div class="labels-list-item">' +
        '<span class="labels-list-name">' + esc(l.name) + '</span>' +
        '<button class="btn-del-label" data-label-id="' + l.id + '" title="Delete label">✕</button>' +
      '</div>'
    ).join('');
    list.querySelectorAll('.btn-del-label').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.labelId, 10);
        const res = await fetch('/api/labels/' + id, { method: 'DELETE' });
        if (!res.ok) {
          const { error } = await res.json();
          btn.style.color = 'var(--red)';
          setTimeout(() => { btn.style.color = ''; }, 1500);
          btn.title = error || 'cannot delete';
        } else { await loadLabels(); renderLabelsList(); load(); }
      });
    });
  }

  document.getElementById('btn-labels-close').addEventListener('click', () => {
    document.getElementById('labels-overlay').classList.remove('open');
  });
  document.getElementById('labels-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('labels-overlay'))
      document.getElementById('labels-overlay').classList.remove('open');
  });
  document.getElementById('new-label-input').addEventListener('input', e => {
    document.getElementById('btn-create-label').disabled = !e.target.value.trim();
  });
  document.getElementById('btn-create-label').addEventListener('click', async () => {
    const input = document.getElementById('new-label-input');
    const name  = input.value.trim();
    if (!name) return;
    const res = await fetch('/api/labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      input.value = ''; document.getElementById('btn-create-label').disabled = true;
      await loadLabels(); renderLabelsList();
    } else {
      input.style.borderColor = 'var(--red)';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
    }
  });

  // ── Add video modal ───────────────────────────────────────────────────────────

  function openAddModal() {
    ['add-url', 'add-title', 'add-channel'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('add-emoji').value = '📺';
    document.getElementById('add-category').value = 'youtube';
    document.getElementById('fetch-status').textContent = '';
    document.getElementById('fetch-status').className   = 'fetch-status';
    document.getElementById('btn-add-submit').disabled  = true;
    document.getElementById('btn-add-submit').textContent = 'Add to watchlist';
    document.getElementById('add-overlay').classList.add('open');
    loadCategorySelectOptions('add-category');
    setTimeout(() => document.getElementById('add-url').focus(), 100);
  }

  async function loadCategorySelectOptions(selectId) {
    const sel = document.getElementById(selectId);
    try {
      const cats = await fetch('/api/categories').then(r => r.json());
      const existing = new Set(Array.from(sel.options).map(o => o.value).filter(Boolean));
      for (const cat of cats) {
        if (!existing.has(cat.source)) {
          const opt = document.createElement('option');
          opt.value = cat.source;
          opt.textContent = categoryDisplayName(cat.source) + ' (' + cat.count + ')';
          sel.appendChild(opt);
        }
      }
    } catch {}
  }

  function updateAddBtn() {
    const url   = document.getElementById('add-url').value.trim();
    const title = document.getElementById('add-title').value.trim();
    document.getElementById('btn-add-submit').disabled = !(url && title);
  }

  function autoDetectCategory(url) {
    if (/youtube\.com|youtu\.be/.test(url))  return 'youtube';
    if (/arstechnica\.com/.test(url))        return 'ars_technica';
    return null;
  }

  document.getElementById('add-url').addEventListener('input', () => {
    clearTimeout(fetchTimer); updateAddBtn();
    const url = document.getElementById('add-url').value.trim();
    if (!url) { setFetchStatus('', ''); return; }
    const detected = autoDetectCategory(url);
    if (detected) document.getElementById('add-category').value = detected;
    if (/youtube\.com|youtu\.be/.test(url)) {
      setFetchStatus('Fetching title…', '');
      fetchTimer = setTimeout(() => fetchPreview(url), 600);
    }
  });
  document.getElementById('add-title').addEventListener('input', updateAddBtn);

  async function fetchPreview(url) {
    try {
      const res = await fetch('/api/preview?url=' + encodeURIComponent(url));
      if (!res.ok) { setFetchStatus('Could not fetch title — enter it manually', 'err'); return; }
      const { title, channel_name } = await res.json();
      document.getElementById('add-title').value   = title        || '';
      document.getElementById('add-channel').value = channel_name || '';
      setFetchStatus(title ? 'Title fetched ✓' : 'No title returned — enter it manually',
                     title ? 'ok' : 'err');
      updateAddBtn();
    } catch { setFetchStatus('Could not fetch title — enter it manually', 'err'); }
  }

  function setFetchStatus(msg, cls) {
    const el = document.getElementById('fetch-status');
    el.textContent = msg;
    el.className   = 'fetch-status' + (cls ? ' ' + cls : '');
  }

  document.getElementById('btn-add-submit').addEventListener('click', async () => {
    const url         = document.getElementById('add-url').value.trim();
    const title       = document.getElementById('add-title').value.trim();
    const channel     = document.getElementById('add-channel').value.trim();
    const emoji       = document.getElementById('add-emoji').value.trim() || '📺';
    const source      = document.getElementById('add-category').value || 'youtube';
    const content_type = source === 'youtube' ? 'video' : 'article';
    if (!url || !title) return;
    const btn = document.getElementById('btn-add-submit');
    btn.disabled = true; btn.textContent = 'Adding…';
    const res = await fetch('/api/videos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, channel_name: channel, emoji, source, content_type }),
    });
    if (res.ok) { closeAddModal(); load(); }
    else {
      btn.disabled = false; btn.textContent = 'Add to watchlist';
      setFetchStatus('Error adding — try again', 'err');
    }
  });
  document.getElementById('btn-add-cancel').addEventListener('click', closeAddModal);
  document.getElementById('add-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('add-overlay')) closeAddModal();
  });
  function closeAddModal() { document.getElementById('add-overlay').classList.remove('open'); }

  // ── Summary overlay ───────────────────────────────────────────────────────────

  function setCopyBtnsDisabled(disabled) {
    document.querySelectorAll('.btn-copy-opt').forEach(b => b.disabled = disabled);
  }

  async function openSummaryOverlay(video) {
    document.getElementById('summary-overlay-title').textContent = video.title;
    const contentEl = document.getElementById('summary-html-content');
    document.getElementById('summary-overlay').classList.add('open');
    if (video.summary) {
      contentEl.innerHTML = video.summary; setCopyBtnsDisabled(false); return;
    }
    contentEl.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Fetching transcript and generating summary…</p>';
    setCopyBtnsDisabled(true);
    try {
      const res  = await fetch('/api/videos/' + video.id + '/summary', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      const card = document.querySelector('.video-card[data-id="' + video.id + '"]');
      if (card) card.dataset.summary = data.summary;
      contentEl.innerHTML = data.summary; setCopyBtnsDisabled(false);
    } catch (err) {
      contentEl.innerHTML = '<p style="color:var(--red)">Could not generate summary: ' + err.message + '</p>';
      setCopyBtnsDisabled(false);
    }
  }

  function closeSummaryOverlay() { document.getElementById('summary-overlay').classList.remove('open'); }
  document.getElementById('summary-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('summary-overlay')) closeSummaryOverlay();
  });
  document.getElementById('btn-summary-overlay-close').addEventListener('click', closeSummaryOverlay);

  function htmlToMarkdown(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    function toMd(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      const inner = Array.from(node.childNodes).map(toMd).join('');
      switch (tag) {
        case 'h3': case 'h4': return '### ' + inner + '\n\n';
        case 'p':  return inner + '\n\n';
        case 'ul': return Array.from(node.children).map(li => '- ' + toMd(li).trim()).join('\n') + '\n\n';
        case 'ol': return Array.from(node.children).map((li, i) => (i + 1) + '. ' + toMd(li).trim()).join('\n') + '\n\n';
        case 'li': return inner;
        case 'strong': case 'b': return '**' + inner + '**';
        case 'em':     case 'i': return '*' + inner + '*';
        default: return inner;
      }
    }
    return Array.from(div.childNodes).map(toMd).join('').trim();
  }

  function flashCopyBtn(btn, original) {
    btn.textContent = 'Copied!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
  }

  document.getElementById('btn-copy-plain').addEventListener('click', () => {
    const text = document.getElementById('summary-html-content').innerText;
    copyText(text).then(() => flashCopyBtn(document.getElementById('btn-copy-plain'), 'Plain text'));
  });
  document.getElementById('btn-copy-html').addEventListener('click', () => {
    const html = document.getElementById('summary-html-content').innerHTML;
    copyText(html).then(() => flashCopyBtn(document.getElementById('btn-copy-html'), 'HTML'));
  });
  document.getElementById('btn-copy-md').addEventListener('click', () => {
    const md = htmlToMarkdown(document.getElementById('summary-html-content').innerHTML);
    copyText(md).then(() => flashCopyBtn(document.getElementById('btn-copy-md'), 'Markdown'));
  });

  // ── Reader view ──────────────────────────────────────────────────────────────

  async function showReaderView(id) {
    const view = document.getElementById('view');
    view.innerHTML = '<div class="reader-container"><div class="empty">Loading…</div></div>';

    let video, textData;
    try {
      [video, textData] = await Promise.all([
        fetch('/api/videos/' + id).then(r => r.json()),
        fetch('/api/videos/' + id + '/text').then(r => r.json()),
      ]);
    } catch {
      view.innerHTML = '<div class="reader-container"><div class="empty">Failed to load.</div></div>';
      return;
    }

    if (!video || video.error) {
      view.innerHTML = '<div class="reader-container"><div class="empty">Article not found.</div></div>';
      return;
    }

    // Load this video into the player
    Player.load({
      id:           video.id,
      title:        video.title,
      channel_name: video.channel_name,
      emoji:        video.emoji,
      source:       video.source,
      content_type: video.content_type,
    });

    const displayLabels = (video.labels || []).filter(l => l.label_id !== 1 && l.label_id !== 2);
    const labelChips = displayLabels.map(l =>
      '<span class="label-chip">' + esc(l.label_name) + '</span>'
    ).join('');

    const badge = video.status === 'finished'
      ? '<span class="badge badge-finished">Finished</span>'
      : video.status === 'started'
        ? '<span class="badge badge-started">Started</span>'
        : '<span class="badge badge-new">New</span>';

    let textSection;
    if (textData && textData.text) {
      textSection = '<pre class="article-text">' + esc(textData.text) + '</pre>';
    } else {
      textSection =
        '<div class="article-text-empty" id="reader-text-zone">' +
          '<p>Generate audio to load article text.</p>' +
          '<button class="btn btn-green" id="btn-reader-gen">Generate Audio</button>' +
        '</div>';
    }

    view.innerHTML =
      '<div class="reader-container">' +
        '<div class="reader-nav">' +
          '<button class="btn-back" id="btn-back">← Back</button>' +
          '<button class="btn-reader-menu" id="btn-reader-menu" title="More options">···</button>' +
        '</div>' +
        '<div class="reader-header">' +
          '<span class="reader-channel">' + esc(video.emoji) + ' ' + esc(video.channel_name) + '</span>' +
          (labelChips ? '<div class="reader-label-chips">' + labelChips + '</div>' : '') +
          '<h1 class="reader-title">' + esc(video.title) + '</h1>' +
          '<div class="reader-meta">' +
            '<span>' + fmtDate(video.published_at || video.added_at) + '</span>' +
            badge +
          '</div>' +
        '</div>' +
        textSection +
      '</div>';

    document.getElementById('btn-back').addEventListener('click', () => {
      navigate('#list');
    });

    document.getElementById('btn-reader-menu').addEventListener('click', () => {
      current = {
        id:           video.id,
        title:        video.title,
        url:          video.url,
        status:       video.status,
        contentType:  video.content_type || 'article',
        source:       video.source || '',
        emoji:        video.emoji || '',
        channel_name: video.channel_name || '',
        summary:      video.summary || '',
        labels:       video.labels || [],
      };
      openMenuModal(current);
    });

    const genBtn = document.getElementById('btn-reader-gen');
    if (genBtn) {
      genBtn.addEventListener('click', () => {
        const zone = document.getElementById('reader-text-zone');
        if (zone) zone.innerHTML = '<p class="reader-gen-status">Generating audio…</p>';
        Player.triggerGenerate(id);

        let textShown = false;
        const readerPoll = setInterval(async () => {
          if (!document.querySelector('.reader-container')) { clearInterval(readerPoll); return; }
          try {
            if (!textShown) {
              const td = await fetch('/api/videos/' + id + '/text').then(r => r.json());
              if (td && td.text) {
                textShown = true;
                const z = document.getElementById('reader-text-zone');
                if (z) z.insertAdjacentHTML('afterend', '<pre class="article-text">' + esc(td.text) + '</pre>');
              }
            }
            const sd = await fetch('/api/videos/' + id + '/audio/status').then(r => r.json());
            if (sd.status === 'ready' || sd.status === 'failed') {
              clearInterval(readerPoll);
              if (sd.status === 'ready') {
                const z = document.getElementById('reader-text-zone');
                if (z) z.remove();
                if (!textShown) {
                  const td = await fetch('/api/videos/' + id + '/text').then(r => r.json());
                  if (td && td.text) {
                    const c = document.querySelector('.reader-container');
                    if (c) c.insertAdjacentHTML('beforeend', '<pre class="article-text">' + esc(td.text) + '</pre>');
                  }
                }
              } else {
                const el = document.querySelector('.reader-gen-status');
                if (el) { el.textContent = 'Audio generation failed.'; el.style.color = 'var(--red)'; }
              }
            }
          } catch {}
        }, 2000);
      });
    }

    window.scrollTo(0, 0);
  }

  // ── Scroll + visibility state save ───────────────────────────────────────────

  window.addEventListener('pagehide', saveState);
  let scrollSaveTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveState, 250);
  }, { passive: true });

  // ── Init ─────────────────────────────────────────────────────────────────────

  restoreListState();
  route();
  setInterval(() => {
    if (window.location.hash === '#list' || !window.location.hash) load();
  }, 30000);
})();
