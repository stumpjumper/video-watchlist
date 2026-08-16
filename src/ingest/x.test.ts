import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from './classify';
import { IngestError } from './errors';
import { parseXHtml } from './x';
import { findTypedObjectFields, readJsString } from './relay';

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

describe('relay string parser', () => {
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
});

describe('IngestError', () => {
  it('marks not_article as permanent', () => {
    const e = new IngestError('not_article');
    assert.equal(e.retryable, false);
    assert.match(e.toUserString(), /^not_article:/);
  });
});
