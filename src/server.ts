import express, { Request, Response } from 'express';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import {
  getVideos, getRemoved, getPurgeReadyCount,
  addVideo, hardDelete, purgeReady,
  markStarted, markRemoved, restoreVideo, resetClock,
  getVideoById, saveSummary,
} from './db';

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
const PORT = parseInt(process.env.PORT ?? '4000', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/videos', (_req: Request, res: Response) => {
  const videos = getVideos();
  const purge_ready_count = getPurgeReadyCount();
  res.json({ videos, purge_ready_count });
});

// must be registered before /:id routes
app.get('/api/videos/removed', (_req: Request, res: Response) => {
  res.json(getRemoved());
});

app.post('/api/videos', (req: Request, res: Response) => {
  const { url, title, channel_name = '', emoji = '📺', summary } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'url is required' }); return;
  }
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' }); return;
  }
  const summaryStr = typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
  const video = addVideo(url.trim(), title.trim(), String(channel_name), String(emoji), summaryStr);
  res.status(201).json(video);
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
  const count = purgeReady();
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

app.post('/api/videos/:id/removed', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !markRemoved(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/restore', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !restoreVideo(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
});

app.post('/api/videos/:id/reset-clock', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !resetClock(id)) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ success: true });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video watchlist running on port ${PORT}`);
});
