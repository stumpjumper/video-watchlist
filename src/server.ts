import express, { Request, Response } from 'express';
import path from 'path';
import { getUnplayed, getAll, addVideo, removeVideo, markPlayed } from './db';

const app = express();
const PORT = parseInt(process.env.PORT ?? '4000', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/videos', (req: Request, res: Response) => {
  const videos = req.query.all === 'true' ? getAll() : getUnplayed();
  res.json({ videos });
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

app.delete('/api/videos/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !removeVideo(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ success: true });
});

app.post('/api/videos/:id/played', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || !markPlayed(id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video watchlist running on port ${PORT}`);
});
