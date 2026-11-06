import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { formatStoredDate, spokenPublishedDate } from './calendarDate';

const root = path.resolve(__dirname, '..');

describe('calendar date', () => {
  it('rejects a date-only value that is not a real day', () => {
    assert.equal(spokenPublishedDate('2026-02-31'), null);
    assert.equal(spokenPublishedDate('   '), null);
    assert.equal(formatStoredDate('not-a-date', { month: 'long', day: 'numeric' }), null);
  });

  it('speaks a date-only published_at as that calendar day in America/Denver', () => {
    const script = `
      const { spokenPublishedDate, formatStoredDate } = require('./src/calendarDate.ts');
      const naive = new Date('2026-10-29').toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      if (naive !== 'October 28, 2026') {
        console.error('expected America/Denver to shift a date-only parse, got ' + naive);
        process.exit(1);
      }
      const spoken = spokenPublishedDate('2026-10-29');
      if (spoken !== 'October 29, 2026') {
        console.error('spoken ' + spoken);
        process.exit(1);
      }
      const zoned = formatStoredDate('2026-10-29T03:00:00.000Z', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      if (zoned !== 'October 28, 2026') {
        console.error('timestamp with a time should stay local, got ' + zoned);
        process.exit(1);
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--require', 'tsx/cjs', '-e', script],
      { cwd: root, env: { ...process.env, TZ: 'America/Denver' }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
