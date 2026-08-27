import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, normalizeUrl } from './classify';
import { IngestError } from './errors';
import { parseXHtml, tweetRelayB64 } from './x';
import { findTypedObjectFields, firstJsStringField, readJsString } from './relay';

const ARTICLE_HTML = `
self.$R=self.$R||{};
screenName:"XFreeze",name:"X Freeze",
note_tweet:null,
legacy:$R[82]={full_text:"https://t.co/Ugkjhtwulb"},
QXJ0aWNsZUVudGl0eToyMDg0ODYwMjE2MzUzNDE1MTY4:$R[90]={__id:"art",__typename:"ArticleEntity",title:"Grok Build will rewrite how you use your laptop -A practical guide to your own Autonomous Employee",preview_text:"Grok Build: What It\\u2019s Actually For",cover_media_results:$R[91]={__ref:"media"},id:"art",rest_id:"2084860216353415168",plain_text:"Grok Build: What It\\u2019s Actually For\\nMost people underestimate it by an order of magnitude.\\nAsk someone what an AI coding agent is for, and they\\u2019ll probably tell you it builds apps.\\nThat\\u2019s true and it may be the least interesting thing about it.\\nThe much bigger opportunity is hidden in all the small, annoying tasks nobody writes about."};
`;

const TWEET_HTML = `
self.$R=self.$R||{};
screenName:"SomeUser",name:"Some User",
note_tweet:null,
legacy:$R[2]={full_text:"hello world this is a regular post"};
`;

const LONG_POST_HTML = `
self.$R=self.$R||{};
screenName:"LongWriter",name:"Long Writer",
note_tweet:$R[10]={__id:"nt",__typename:"NoteTweet",text:"${'A'.repeat(80)} This is a long Premium post that goes well past two hundred and eighty characters so we treat it as listen-worthy prose rather than a regular tweet. ${'B'.repeat(120)}"};
legacy:$R[2]={full_text:"A truncated preview…"};
`;

const VIDEO_STATUS = '2091091937298182231';
const VIDEO_B64 = tweetRelayB64(VIDEO_STATUS);
const VIDEO_CAPTION = 'One of the most eloquent explanations of immigration you’ll ever hear.\\n\\nMilton Friedman had an extraordinary ability to cut through the political bullshit and explain complicated issues with simple economic logic.';
const LONGER_REPLY = '@boot15_vu This reply is longer than the caption on purpose so a longest-full_text heuristic would steal the title and we must not do that because this is a conversation reply not the video post itself and it easily exceeds the original caption length.';

const VIDEO_HTML = `
self.$R=self.$R||{};
screenName:"boot15_vu",name:"Jamais Vu",
note_tweet:null,
"client:${VIDEO_B64}:details":$R[112]={__id:"client:${VIDEO_B64}:details",__typename:"TBirdData",full_text:"${VIDEO_CAPTION}"};
"client:${VIDEO_B64}:media_entities2:0:video_info":$R[85]={__id:"client:${VIDEO_B64}:media_entities2:0:video_info",__typename:"ApiMediaEntityVideoInfo",duration_millis:168063};
legacy:$R[2]={full_text:"${LONGER_REPLY}"};
`;

const VIDEO_PLUS_QUOTED_ARTICLE_HTML = VIDEO_HTML + `
QXJ0aWNsZUVudGl0eToyMDg5NjU1NDQyNjU3OTEwNzg0:$R[148]={__id:"art",__typename:"ArticleEntity",title:"Grok Bot Agents: how to automate your life in 10 Steps",preview_text:"Every AI tool you have used so far waits for you."};
legacy:$R[3]={full_text:"https://t.co/eDBs67VMq2"};
`;

const REPLY_STATUS = '2091480040714478074';
const REPLY_B64 = tweetRelayB64(REPLY_STATUS);
const REPLY_HTML = `
self.$R=self.$R||{};
screenName:"elonmusk",name:"Elon Musk",
note_tweet:null,
legacy:$R[1]={full_text:"${VIDEO_CAPTION}"};
"client:${REPLY_B64}:details":$R[10]={__id:"client:${REPLY_B64}:details",__typename:"TBirdData",full_text:"Precisely articulated"};
"client:${VIDEO_B64}:media_entities2:0:video_info":$R[85]={__id:"client:${VIDEO_B64}:media_entities2:0:video_info",__typename:"ApiMediaEntityVideoInfo",duration_millis:168063};
video.twimg.com/amplify_video/2091091772009033729/vid/foo.mp4
`;

describe('classifyUrl', () => {
  it('detects X status URLs including share junk', () => {
    const c = classifyUrl('https://x.com/xfreeze/status/2084975853272801623?s=46');
    assert.equal(c.source, 'x');
    assert.equal(c.statusId, '2084975853272801623');
    assert.equal(c.contentType, 'article');
  });

  it('detects twitter.com and /i/web/status', () => {
    assert.equal(classifyUrl('https://twitter.com/foo/status/123').statusId, '123');
    assert.equal(classifyUrl('https://x.com/i/web/status/456').statusId, '456');
  });

  it('captures the status id from /video/1 player paths', () => {
    const c = classifyUrl('https://x.com/boot15_vu/status/2091091937298182231/video/1?s=46');
    assert.equal(c.source, 'x');
    assert.equal(c.statusId, '2091091937298182231');
  });

  it('rejects Spaces and bare profiles', () => {
    assert.match(classifyUrl('https://x.com/i/spaces/1abc').unsupported ?? '', /Spaces/);
    assert.match(classifyUrl('https://x.com/xfreeze').unsupported ?? '', /post URL/);
  });

  it('still classifies youtube and ars', () => {
    assert.equal(classifyUrl('https://youtu.be/abc').source, 'youtube');
    assert.equal(classifyUrl('https://arstechnica.com/foo').source, 'ars_technica');
    assert.equal(classifyUrl('https://example.com/post').source, 'web');
  });
});

describe('normalizeUrl', () => {
  it('strips /video/N and share junk from X status URLs', () => {
    assert.equal(
      normalizeUrl('https://x.com/boot15_vu/status/2091091937298182231/video/1?s=46'),
      'https://x.com/boot15_vu/status/2091091937298182231',
    );
  });

  it('leaves non-X /video/ paths alone', () => {
    assert.equal(
      normalizeUrl('https://example.com/watch/video/1'),
      'https://example.com/watch/video/1',
    );
  });
});

describe('relay string parser', () => {
  it('does not treat __typename as a name field', () => {
    assert.equal(
      firstJsStringField('__typename:"__Root",name:"DogeDesigner"', 'name'),
      'DogeDesigner',
    );
    assert.equal(firstJsStringField('plain_text:"hello"', 'text'), null);
  });

  it('unescapes unicode and newlines', () => {
    const raw = `"What It\\u2019s For\\nNext"`;
    const got = readJsString(raw, 0);
    assert.ok(got);
    assert.equal(got.value, "What It’s For\nNext");
  });

  it('finds ArticleEntity fields past nested $R objects', () => {
    const fields = findTypedObjectFields(ARTICLE_HTML, 'ArticleEntity', ['title', 'plain_text']);
    assert.ok(fields);
    assert.match(fields.title ?? '', /Grok Build will rewrite/);
    assert.match(fields.plain_text ?? '', /Most people underestimate/);
  });
});

describe('parseXHtml', () => {
  it('extracts article title, author, and body', () => {
    const d = parseXHtml(ARTICLE_HTML);
    assert.equal(d.kind, 'article');
    assert.match(d.title, /Grok Build will rewrite/);
    assert.equal(d.author, 'X Freeze (@XFreeze)');
    assert.match(d.text, /Most people underestimate/);
    assert.ok(d.text.length > 150);
  });

  it('treats a regular tweet as kind=tweet', () => {
    const d = parseXHtml(TWEET_HTML);
    assert.equal(d.kind, 'tweet');
    assert.match(d.text, /hello world/);
  });

  it('extracts a long Premium post', () => {
    const d = parseXHtml(LONG_POST_HTML);
    assert.equal(d.kind, 'long_post');
    assert.equal(d.author, 'Long Writer (@LongWriter)');
    assert.ok(d.text.length > 281);
  });

  it('detects attached native video on this status', () => {
    const d = parseXHtml(VIDEO_HTML, VIDEO_STATUS);
    assert.equal(d.kind, 'native_video');
    assert.match(d.title, /eloquent explanations of immigration/);
    assert.doesNotMatch(d.title, /steal the title/);
    assert.equal(d.author, 'Jamais Vu (@boot15_vu)');
    assert.equal(d.text, '');
  });

  it('still treats a video that quotes an article as native_video', () => {
    const d = parseXHtml(VIDEO_PLUS_QUOTED_ARTICLE_HTML, VIDEO_STATUS);
    assert.equal(d.kind, 'native_video');
    assert.match(d.title, /eloquent explanations of immigration/);
    assert.doesNotMatch(d.title, /Grok Bot Agents/);
    assert.doesNotMatch(d.title, /t\.co/);
  });

  it('reads authorName and strips t.co from a native-video caption', () => {
    const status = '2092298224224919949';
    const b64 = tweetRelayB64(status);
    const html = `
__typename:"__Root",
authorName:"DogeDesigner",screenName:"cb_doge",
"client:${b64}:details":$R[1]={__id:"client:${b64}:details",__typename:"TBirdData",full_text:"BREAKING: SpaceX President and COO Gwynne Shotwell’s full keynote address during today’s official announcement of Starbase, Louisiana. https://t.co/YYNxBFDXeP"};
"client:${b64}:media_entities2:0:video_info":$R[2]={__id:"client:${b64}:media_entities2:0:video_info",__typename:"ApiMediaEntityVideoInfo",duration_millis:834066};
`;
    const d = parseXHtml(html, status);
    assert.equal(d.kind, 'native_video');
    assert.equal(d.author, 'DogeDesigner (@cb_doge)');
    assert.match(d.title, /Starbase, Louisiana/);
    assert.doesNotMatch(d.title, /https|t\.co/);
  });

  it('does not treat a reply that displays parent video as native_video', () => {
    const d = parseXHtml(REPLY_HTML, REPLY_STATUS);
    assert.equal(d.kind, 'tweet');
    assert.match(d.text, /Precisely articulated/);
    assert.doesNotMatch(d.text, /eloquent explanations/);
  });
});

describe('IngestError', () => {
  it('marks not_article as permanent', () => {
    const e = new IngestError('not_article');
    assert.equal(e.retryable, false);
    assert.match(e.toUserString(), /^not_article:/);
  });
});
