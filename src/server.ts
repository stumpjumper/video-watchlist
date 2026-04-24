import express, { Request, Response } from 'express';
import path from 'path';
import { getVideos, getRemoved, addVideo, hardDelete, markStarted, markRemoved, restoreVideo } from './db';

const app = express();
const PORT = parseInt(process.env.PORT ?? '4000', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/videos', (_req: Request, res: Response) => {
  res.json({ videos: getVideos() });
});

// must be registered before /:id routes
app.get('/api/videos/removed', (_req: Request, res: Response) => {
  res.json({ videos: getRemoved() });
});

app.post('/api/videos', (req: Request, res: Response) => {
  const { url, title, channel_name = '', emoji = '📺' } = req.body ?? {};
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const video = addVideo(url.trim(), title.trim(), String(channel_name), String(emoji));
  res.status(201).json(video);
});

// fetch YouTube title + channel via oEmbed (no API key needed)
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video watchlist running on port ${PORT}`);
});
