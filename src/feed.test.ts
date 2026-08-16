import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { feedItemTitle } from './feed';

describe('feedItemTitle', () => {
  it('prefixes channel when the title does not already start with it', () => {
    assert.equal(
      feedItemTitle('All-In', "Anthropic's Model Attacked Two Strangers On GitHub"),
      "All-In · Anthropic's Model Attacked Two Strangers On GitHub",
    );
  });

  it('does not double-prefix', () => {
    assert.equal(
      feedItemTitle('All-In', 'All-In: E205'),
      'All-In: E205',
    );
    assert.equal(
      feedItemTitle('all-in', 'All-In weekly'),
      'All-In weekly',
    );
  });

  it('returns the title alone when there is no channel', () => {
    assert.equal(feedItemTitle('', 'Untitled'), 'Untitled');
    assert.equal(feedItemTitle('   ', 'Untitled'), 'Untitled');
  });
});
