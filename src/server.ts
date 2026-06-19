import 'dotenv/config';
import express, { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import {
  getVideos, getVideoById, addVideo, hardDelete, markStarted, saveSummary,
  getLabels, createLabel, deleteLabel,
  addLabelToVideo, removeLabelFromVideo, setVideoLabels, trashVideo, restoreFromTrash,
  getTrashCount, purgeTrash, getCategories,
  VideoFilter,
} from './db';
import { buildReaderHtml } from './reader';
import {
  generateAudio, audioExists, audioUrl, audioDirSizeBytes, AUDIO_DIR,
} from './audio';

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
});

app.get('/api/categories', (_req: Request, res: Response) => {
  res.json(getCategories());
});

app.get('/reader/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).send('Invalid id'); return; }
  const video = getVideoById(id);
  if (!video) { res.status(404).send('Not found'); return; }

  let articleText = '';
  if (video.source_metadata) {
    try {
      // Replace bare control chars (unescaped newlines etc.) that make JSON.parse throw
      const sanitized = video.source_metadata.replace(/[\x00-\x1f]/g, c =>
        c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '',
      );
      const meta = JSON.parse(sanitized) as Record<string, unknown>;
      articleText = typeof meta.text === 'string' ? meta.text : '';
    } catch (e) {
      console.error('[reader] failed to parse source_metadata for video', id, e);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildReaderHtml(video.title, video.channel_name, video.added_at, video.url, articleText,
    await audioExists(id) ? audioUrl(id) : null));
});

// ── Audio ────────────────────────────────────────────────────────────────────

// Serve generated audio files
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '7d' }));

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

  if (video.content_type !== 'article') {
    res.status(422).json({ error: 'Audio generation is only supported for articles' });
    return;
  }

  res.json({ status: 'generating' });

  // Generate in background — client polls /api/videos/:id/audio/status
  generateAudio(id, video.url).catch(e =>
    console.error('[audio] generation failed for video', id, e),
  );
});

app.get('/api/videos/:id/audio/status', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (await audioExists(id)) {
    res.json({ status: 'ready', url: audioUrl(id) });
  } else {
    res.json({ status: 'generating' });
  }
});

app.get('/api/audio/stats', async (_req: Request, res: Response) => {
  const bytes = await audioDirSizeBytes();
  res.json({ bytes, mb: Math.round(bytes / 1024 / 1024 * 10) / 10 });
});

app.get('/api/preview', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
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

// ── Trash ────────────────────────────────────────────────────────────────────

app.get('/api/trash', (_req: Request, res: Response) => {
  const videos = getVideos({ labels: [2] });
  res.json({ videos });
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
