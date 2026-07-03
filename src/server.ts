import 'dotenv/config';
import express, { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import {
  getVideos, getVideoById, addVideo, hardDelete, markStarted, markFinished, saveSummary,
  getLabels, createLabel, deleteLabel, renameLabel,
  addLabelToVideo, removeLabelFromVideo, setVideoLabels, trashVideo, restoreFromTrash,
  getTrashCount, purgeTrash, getCategories,
  getSources, updateSourceSpeed, markAudioReady,
  getSettings, setSetting, getPlaylists, createPlaylist, updatePlaylist, deletePlaylist,
  getExpiredAudioIds, markAudioDeleted,
  setAudioPending, setAudioGenerating, setAudioFailed, getAudioStatus, getPendingAudioIds,
  setAudioVoice, setAudioDuration, getReadyIdsMissingDuration, getReadyArticleIdsMissingVoice,
  VideoFilter,
} from './db';
import { buildReaderHtml } from './reader';
import {
  generateAudio, downloadYouTubeAudio, audioExists, audioUrl, audioDirSizeBytes, AUDIO_DIR,
  readCachedText, audioPath, probeAudioDuration, SAY_VOICE,
} from './audio';
import { buildFeedXml } from './feed';

const execFileAsync = promisify(execFile);

function parseVtt(vtt: string): string {
  const seen = new Set<string>();
  const text: string[] = [];
  for (const line of vtt.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('WEBVTT') || l.startsWith('NOTE') || l.includes('-->') || /^\d+$/.test(l)) continue;
    const clean = l.replace(/<[^>]+>/g, '').trim();
    if (clean && !seen.has(clean)) { seen.add(clean); text.push(clean); }
  }
  return text.join(' ');
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be/.test(url);
}

// Mirrors autoDetectCategory() in public/app.js — keep in sync.
function detectSourceKey(url: string): string {
  if (isYouTubeUrl(url)) return 'youtube';
  if (/arstechnica\.com/.test(url)) return 'ars_technica';
  return 'web';
}

async function scrapeArticleMeta(url: string): Promise<{ title: string; channel_name: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const title = decodeHtmlEntities((ogTitle || titleTag || '').trim());

    const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const domain = new URL(url).hostname.replace(/^www\./, '');
    const sourceKey = detectSourceKey(url);
    const knownSource = getSources().find(s => s.source_key === sourceKey && sourceKey !== 'web');
    const channel_name = decodeHtmlEntities((siteName || knownSource?.display_name || domain).trim());

    return title ? { title, channel_name } : null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

async function fetchTranscript(url: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytdl-'));
  try {
    await execFileAsync('/opt/homebrew/bin/yt-dlp', [
      '--skip-download', '--write-auto-sub',
      '--sub-langs', 'en', '--sub-format', 'vtt',
      '--no-warnings', '-q',
      '-o', path.join(dir, '%(id)s'), url,
    ]);
    const files = await readdir(dir);
    const vttFile = files.find(f => f.endsWith('.vtt'));
    if (!vttFile) throw new Error('no transcript available for this video');
    const raw = await readFile(path.join(dir, vttFile), 'utf8');
    return parseVtt(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function summarizeWithOpenRouter(transcript: string, title: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
  const prompt = `Summarize this YouTube video using only these HTML tags: <h3>, <p>, <ul>, <li>, <strong>. Output raw HTML only — no markdown, no code fences. Use this structure:

<h3>Overview</h3>
<p>3-4 sentences describing the main topic, context, and why it matters.</p>
<h3>Key Points</h3>
<ul><li>6-8 specific, concrete points from the video</li></ul>
<h3>Takeaway</h3>
<p>2-3 sentences on the conclusion or what the viewer should do or think differently about.</p>

Video title: "${title}"

Transcript:
${transcript.slice(0, 30000)}`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim().replace(/^```html?\s*/i, '').replace(/\s*```$/, '');
}

const app = express();
const HTTP_PORT  = parseInt(process.env.PORT      ?? '4000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT ?? '443',  10);
const CERT_DIR   = process.env.CERT_DIR ?? '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Videos ──────────────────────────────────────────────────────────────────

app.get('/api/videos', (req: Request, res: Response) => {
  const { q, after, before, labels: labelsRaw, label_mode, source } = req.query as Record<string, string>;
  const filter: VideoFilter = {};
  if (q) filter.q = q;
  if (after) filter.after = after;
  if (before) filter.before = before;
  if (labelsRaw) {
    filter.labels = labelsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  }
  if (label_mode === 'and' || label_mode === 'or') filter.label_mode = label_mode;
  if (source) filter.source = source;
  const videos = getVideos(filter);
  const trash_count = getTrashCount();
  res.json({ videos, trash_count });
});

app.post('/api/videos', async (req: Request, res: Response) => {
  let { url, title = '', channel_name = '', emoji = '📺', summary,
        content_type = 'video', source = 'youtube', source_metadata } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'url is required' }); return;
  }
  url = url.trim();

  if (!title.trim() && content_type === 'video') {
    try {
      const oEmbed = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
      );
      if (oEmbed.ok) {
        const data = await oEmbed.json() as { title: string; author_name: string };
        title        = data.title       || '';
        channel_name = channel_name || data.author_name || '';
      }
    } catch {}
  } else if (!title.trim()) {
    const meta = await scrapeArticleMeta(url);
    if (meta) {
      title        = meta.title;
      channel_name = channel_name || meta.channel_name;
    }
  }

  if (!title.trim()) {
    res.status(400).json({ error: 'title is required' }); return;
  }

  const summaryStr = typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
  const video = addVideo(
    url, title.trim(), String(channel_name), String(emoji),
    summaryStr, String(source), String(content_type),
    typeof source_metadata === 'string' ? source_metadata : undefined,
  );
  res.status(201).json(video);

  const settings = getSettings();
  if (settings.audio_on_add === 'true') {
    queueAudioGen(video.id); // queueAudioGen filters to supported types
  }
});

app.get('/api/categories', (_req: Request, res: Response) => {
  res.json(getCategories());
});

app.get('/api/videos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(video);
});

// ── Sources ──────────────────────────────────────────────────────────────────

app.get('/api/sources', (_req: Request, res: Response) => {
  res.json(getSources());
});

app.put('/api/sources/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { default_speed } = req.body ?? {};
  if (isNaN(id) || typeof default_speed !== 'number') {
    res.status(400).json({ error: 'invalid' }); return;
  }
  if (!updateSourceSpeed(id, default_speed)) {
    res.status(404).json({ error: 'not found' }); return;
  }
  res.json({ success: true });
});

app.get('/reader/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).send('Invalid id'); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).send('Not found'); return; }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildReaderHtml(video.title, video.channel_name, video.added_at, video.url,
    await audioExists(id) ? audioUrl(id) : null,
    audioGenerating.has(id),
    audioFailed.get(id) ?? null,
    id,
    video.status,
    video.labels,
    video.published_at));
});

app.get('/api/videos/:id/text', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }

  const cached = await readCachedText(id);
  res.json({ text: cached ?? null });
});

// ── Audio ────────────────────────────────────────────────────────────────────

const audioGenerating = new Set<number>();
const audioFailed     = new Map<number, string>(); // id → error message

// ── Audio production ──────────────────────────────────────────────────────────
// Articles: fetch text → TTS → m4a.  YouTube videos: yt-dlp download → m4a.

function produceAudio(video: { id: number; url: string; title: string; published_at: string | null; content_type: string }): Promise<void> {
  return video.content_type === 'video'
    ? downloadYouTubeAudio(video.id, video.url)
    : generateAudio(video.id, video.url, video.title, video.published_at);
}

// ── Background audio generation queue ────────────────────────────────────────

const audioQueue: number[] = [];
let queueRunning = false;
const QUEUE_MAX_RETRIES = 5;
const QUEUE_RETRY_DELAY = 5 * 60 * 1000; // 5 minutes

const drainQueue = async (): Promise<void> => {
  if (queueRunning) return;
  queueRunning = true;
  while (audioQueue.length > 0) {
    const id = audioQueue.shift()!;
    const video = getVideoById(id);
    if (!video) continue;
    if (video.audio_status === 'ready') continue;
    if (video.audio_retry_count >= QUEUE_MAX_RETRIES) {
      setAudioFailed(id, 'max retries exceeded');
      console.error('[audio] queue: max retries reached for video', id);
      continue;
    }
    setAudioGenerating(id);
    try {
      await produceAudio(video);
      const duration = await probeAudioDuration(id);
      if (duration !== null) setAudioDuration(id, duration);
      if (video.content_type === 'article') setAudioVoice(id, SAY_VOICE);
      markAudioReady(id);
      console.log('[audio] queue: generated audio for video', id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAudioFailed(id, msg);
      console.error('[audio] queue: failed for video', id, msg);
      // Retry after delay if under limit
      setTimeout(() => {
        const v = getVideoById(id);
        if (v && v.audio_retry_count < QUEUE_MAX_RETRIES) {
          setAudioPending(id);
          audioQueue.push(id);
          drainQueue().catch(() => {});
        }
      }, QUEUE_RETRY_DELAY);
    }
  }
  queueRunning = false;
};

const queueAudioGen = (id: number): void => {
  const video = getVideoById(id);
  if (!video) return;
  const supported = video.content_type === 'article' ||
    (video.content_type === 'video' && video.source === 'youtube');
  if (!supported) return;
  if (video.audio_status === 'ready' || video.audio_status === 'generating' ||
      video.audio_status === 'pending') return;
  setAudioPending(id);
  if (!audioQueue.includes(id)) audioQueue.push(id);
  drainQueue().catch(e => console.error('[audio] queue error', e));
};

// ── Startup: sync audio_status with disk ─────────────────────────────────────

async function runAudioLifecycle(): Promise<void> {
  const expired = getExpiredAudioIds();
  for (const id of expired) {
    try { await unlink(audioPath(id)); } catch {}
    markAudioDeleted(id);
  }
  if (expired.length > 0) console.log(`[audio] lifecycle: deleted ${expired.length} expired file(s)`);
}

(async () => {
  // Delete expired audio files first, then mark remaining disk files as ready
  await runAudioLifecycle().catch(e => console.error('[audio] lifecycle error:', e));
  try {
    const files = await readdir(AUDIO_DIR);
    for (const f of files) {
      const m = f.match(/^(\d+)\.m4a$/);
      if (m) markAudioReady(parseInt(m[1], 10));
    }
  } catch {}
  // Re-queue any items that were pending when the server last stopped
  const pending = getPendingAudioIds();
  if (pending.length > 0) {
    console.log(`[audio] queue: re-queuing ${pending.length} pending item(s) from previous run`);
    for (const id of pending) audioQueue.push(id);
    drainQueue().catch(e => console.error('[audio] queue error', e));
  }
  // Backfill duration/voice for existing ready audio that predates these columns.
  // Voice is a best-effort assumption (current SAY_VOICE) — historical voice isn't
  // recoverable if it was ever changed, but it never has been.
  const missingDuration = getReadyIdsMissingDuration();
  for (const id of missingDuration) {
    const duration = await probeAudioDuration(id);
    if (duration !== null) setAudioDuration(id, duration);
  }
  if (missingDuration.length > 0) console.log(`[audio] backfill: probed duration for ${missingDuration.length} file(s)`);
  const missingVoice = getReadyArticleIdsMissingVoice();
  for (const id of missingVoice) setAudioVoice(id, SAY_VOICE);
  if (missingVoice.length > 0) console.log(`[audio] backfill: assumed voice "${SAY_VOICE}" for ${missingVoice.length} article(s)`);
})();

setInterval(() => {
  runAudioLifecycle().catch(e => console.error('[audio] lifecycle error:', e));
}, 24 * 60 * 60 * 1000);

// Serve generated audio files
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '7d' }));

// ── Podcast feed (Overcast) ─────────────────────────────────────────────────
// Token-gated, publicly exposed only via Tailscale Funnel on /feed/*.
// 404 (not 403) on a bad token so the route's existence isn't confirmed to scanners.
// Artwork is unguarded (not sensitive) but stays under /feed so it's covered
// by the same Funnel path scope, in case Overcast's crawlers fetch it directly.
app.use('/feed/icons', express.static(path.join(__dirname, '..', 'public', 'feed-icons'), { maxAge: '7d' }));

// One feed per source_key (youtube/ars_technica/web/...) rather than per
// content_type — matches the sources table's independent per-source speed
// settings. Adding a future source (new `sources` row + a matching icon
// file at public/feed-icons/<source_key>.png) needs no route changes here.
app.get('/feed/:token/:sourceKey.xml', (req: Request, res: Response) => {
  if (req.params.token !== process.env.FEED_TOKEN) { res.sendStatus(404); return; }
  const source = getSources().find(s => s.source_key === req.params.sourceKey);
  if (!source) { res.sendStatus(404); return; }
  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(buildFeedXml(source.source_key, source.display_name, `${source.source_key}.png`));
});

// Check / trigger audio generation
app.post('/api/videos/:id/audio', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }

  if (await audioExists(id)) {
    res.json({ status: 'ready', url: audioUrl(id) });
    return;
  }

  const supported = video.content_type === 'article' ||
    (video.content_type === 'video' && video.source === 'youtube');
  if (!supported) {
    res.status(422).json({ error: 'Audio not supported for this content type' });
    return;
  }

  if (audioGenerating.has(id)) {
    res.json({ status: 'generating' });
    return;
  }

  // Clear any previous failure so user can retry
  audioFailed.delete(id);
  audioGenerating.add(id);
  setAudioGenerating(id);
  res.json({ status: 'generating' });

  produceAudio(video)
    .then(() => { audioGenerating.delete(id); markAudioReady(id); })
    .catch(e => {
      audioGenerating.delete(id);
      const msg = e instanceof Error ? e.message : String(e);
      audioFailed.set(id, msg);
      setAudioFailed(id, msg);
      console.error('[audio] production failed for video', id, e);
    });
});

app.get('/api/videos/:id/next', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const { q, after, before, labels: labelsRaw, label_mode, source } = req.query as Record<string, string>;
  const filter: VideoFilter = {};
  if (q) filter.q = q;
  if (after) filter.after = after;
  if (before) filter.before = before;
  if (labelsRaw) filter.labels = labelsRaw.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  if (label_mode === 'and' || label_mode === 'or') filter.label_mode = label_mode;
  if (source) filter.source = source;
  const videos = getVideos(filter);
  const idx = videos.findIndex(v => v.id === id);
  const next = idx >= 0 && idx < videos.length - 1 ? videos[idx + 1] : null;
  if (!next) { res.json(null); return; }
  res.json({ id: next.id, title: next.title, channel_name: next.channel_name, has_audio: await audioExists(next.id) });
});

app.get('/api/videos/:id/audio/status', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (await audioExists(id)) {
    res.json({ status: 'ready', url: audioUrl(id) }); return;
  }
  // Check in-memory state first (user-triggered generation)
  if (audioGenerating.has(id)) {
    res.json({ status: 'generating' }); return;
  }
  if (audioFailed.has(id)) {
    res.json({ status: 'failed', error: audioFailed.get(id) }); return;
  }
  // Fall back to DB status (background queue)
  const dbSt = getAudioStatus(id);
  if (dbSt?.audio_status === 'generating' || dbSt?.audio_status === 'pending') {
    res.json({ status: 'generating' }); return;
  }
  if (dbSt?.audio_status === 'failed') {
    res.json({ status: 'failed', error: dbSt.audio_error }); return;
  }
  res.json({ status: 'none' });
});

app.get('/api/audio/stats', async (_req: Request, res: Response) => {
  const bytes = await audioDirSizeBytes();
  res.json({ bytes, mb: Math.round(bytes / 1024 / 1024 * 10) / 10 });
});

app.get('/api/preview', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  if (isYouTubeUrl(url)) {
    try {
      const oEmbed = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
      );
      if (!oEmbed.ok) { res.status(422).json({ error: 'not a recognised YouTube URL' }); return; }
      const data = await oEmbed.json() as { title: string; author_name: string };
      res.json({ title: data.title, channel_name: data.author_name });
    } catch {
      res.status(502).json({ error: 'could not reach YouTube' });
    }
    return;
  }

  const meta = await scrapeArticleMeta(url);
  if (!meta) { res.status(422).json({ error: 'could not fetch page metadata' }); return; }
  res.json(meta);
});

app.delete('/api/videos/purge', (_req: Request, res: Response) => {
  const count = purgeTrash();
  res.json({ deleted: count });
});

app.delete('/api/videos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !hardDelete(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/started', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !markStarted(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/finished', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !markFinished(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.put('/api/videos/:id/labels', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { labelIds } = req.body ?? {};
  if (isNaN(id) || !Array.isArray(labelIds)) {
    res.status(400).json({ error: 'labelIds array required' }); return;
  }
  if (!setVideoLabels(id, labelIds.map(Number))) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/trash', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !trashVideo(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/restore', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !restoreFromTrash(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/labels/:labelId', (req: Request, res: Response) => {
  const id      = parseInt(req.params.id, 10);
  const labelId = parseInt(req.params.labelId, 10);
  if (isNaN(id) || isNaN(labelId) || !addLabelToVideo(id, labelId)) {
    res.status(404).json({ error: 'not found' }); return;
  }
  res.json({ success: true });
});

app.delete('/api/videos/:id/labels/:labelId', (req: Request, res: Response) => {
  const id      = parseInt(req.params.id, 10);
  const labelId = parseInt(req.params.labelId, 10);
  if (isNaN(id) || isNaN(labelId)) { res.status(400).json({ error: 'invalid id' }); return; }
  const result = removeLabelFromVideo(id, labelId);
  if (!result.ok) { res.status(409).json({ error: 'cannot remove last label' }); return; }
  res.json({ success: true, restoredInbox: result.restoredInbox });
});

app.post('/api/videos/:id/summary', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).json({ error: 'not found' }); return; }
  if (video.summary) { res.json({ summary: video.summary }); return; }
  try {
    const transcript = await fetchTranscript(video.url);
    const summary = await summarizeWithOpenRouter(transcript, video.title);
    saveSummary(id, summary);
    res.json({ summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    res.status(502).json({ error: msg });
  }
});

// ── Labels ──────────────────────────────────────────────────────────────────

app.get('/api/labels', (_req: Request, res: Response) => {
  res.json(getLabels());
});

app.post('/api/labels', (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const label = createLabel(name);
  if (!label) { res.status(409).json({ error: 'label name already exists' }); return; }
  res.status(201).json(label);
});

app.delete('/api/labels/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const result = deleteLabel(id);
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.json({ success: true });
});

app.put('/api/labels/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body ?? {};
  if (isNaN(id) || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name required' }); return;
  }
  const result = renameLabel(id, name);
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.json({ success: true });
});

// ── Trash ────────────────────────────────────────────────────────────────────

app.get('/api/trash', (_req: Request, res: Response) => {
  const videos = getVideos({ labels: [2] });
  res.json({ videos });
});

// ── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(getSettings());
});

app.put('/api/settings', (req: Request, res: Response) => {
  const updates = req.body ?? {};
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    res.status(400).json({ error: 'body must be an object' }); return;
  }
  for (const [key, value] of Object.entries(updates)) setSetting(key, String(value));
  res.json(getSettings());
});

// ── Playlists ─────────────────────────────────────────────────────────────────

app.get('/api/playlists', (_req: Request, res: Response) => {
  res.json(getPlaylists());
});

app.post('/api/playlists', (req: Request, res: Response) => {
  const { name, filter_json } = req.body ?? {};
  if (!name || typeof name !== 'string') { res.status(400).json({ error: 'name required' }); return; }
  const playlist = createPlaylist(name, typeof filter_json === 'string' ? filter_json : '{}');
  if (!playlist) { res.status(409).json({ error: 'name already exists' }); return; }
  res.status(201).json(playlist);
});

app.put('/api/playlists/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { name, filter_json } = req.body ?? {};
  if (isNaN(id) || !name || typeof name !== 'string') { res.status(400).json({ error: 'invalid' }); return; }
  if (!updatePlaylist(id, name, typeof filter_json === 'string' ? filter_json : '{}')) {
    res.status(404).json({ error: 'not found' }); return;
  }
  res.json({ success: true });
});

app.delete('/api/playlists/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !deletePlaylist(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

// ── Servers ──────────────────────────────────────────────────────────────────

http.createServer(app).listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`HTTP  listening on http://localhost:${HTTP_PORT}`);
});

if (CERT_DIR) {
  try {
    const key  = readFileSync(`${CERT_DIR}/server.key`);
    const cert = readFileSync(`${CERT_DIR}/server.crt`);
    https.createServer({ key, cert }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS listening on port ${HTTPS_PORT}`);
    });
  } catch (err) {
    console.error('HTTPS cert load failed — running HTTP only:', err);
  }
}
