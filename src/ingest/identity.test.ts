import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPageUrl, externalIdFor, youtubeVideoId } from './classify';

describe('youtubeVideoId', () => {
  const id = '5eTNnyqKHbc';

  it('reads watch, youtu.be, shorts, embed, and live forms', () => {
    assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${id}&t=12s`), id);
    assert.equal(youtubeVideoId(`https://youtu.be/${id}?si=abc`), id);
    assert.equal(youtubeVideoId(`https://m.youtube.com/shorts/${id}`), id);
    assert.equal(youtubeVideoId(`https://www.youtube.com/embed/${id}?feature=share`), id);
    assert.equal(youtubeVideoId(`https://www.youtube.com/live/${id}`), id);
  });

  it('rejects a non-id path segment', () => {
    assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=short'), null);
    assert.equal(youtubeVideoId('https://www.youtube.com/@channel'), null);
  });
});

describe('externalIdFor', () => {
  it('treats YouTube URL forms of one video as the same id', () => {
    const watch = externalIdFor('youtube', 'https://www.youtube.com/watch?v=cy_KQor_wgE&t=30');
    const short = externalIdFor('youtube', 'https://youtu.be/cy_KQor_wgE');
    const shorts = externalIdFor('youtube', 'https://www.youtube.com/shorts/cy_KQor_wgE');
    assert.equal(watch, 'cy_KQor_wgE');
    assert.equal(short, watch);
    assert.equal(shorts, watch);
  });

  it('uses the X status id, including /video/N and twitter.com', () => {
    const a = externalIdFor('x', 'https://x.com/cb_doge/status/2092298224224919949/video/1?s=46');
    const b = externalIdFor('x', 'https://twitter.com/cb_doge/status/2092298224224919949');
    assert.equal(a, '2092298224224919949');
    assert.equal(b, a);
  });

  it('canonicalizes article URLs that differ only by tracking and www', () => {
    const a = canonicalPageUrl('https://www.arstechnica.com/science/story/?utm_source=rss&utm_medium=feed');
    const b = canonicalPageUrl('https://arstechnica.com/science/story');
    assert.equal(a, 'https://arstechnica.com/science/story');
    assert.equal(b, a);
    assert.equal(externalIdFor('ars_technica', 'https://www.arstechnica.com/science/story/'), a);
    assert.equal(externalIdFor('web', 'https://example.com/post?b=2&a=1'), 'https://example.com/post?a=1&b=2');
  });
});
