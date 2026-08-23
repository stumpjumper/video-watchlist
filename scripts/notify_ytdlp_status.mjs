#!/usr/bin/env node
// Sends a status email via the Gmail API, routed through the OneCLI gateway
// (must be run as: onecli run --agent videowatchlist -- node notify_ytdlp_status.mjs <status> <detail>).
// Used by scripts/upgrade_ytdlp. Same agent/gateway as cert renew — do not install a second OneCLI.

const TO = 'alfred@thelorbers.com';

const [status, detail] = process.argv.slice(2);
if (status !== 'success' && status !== 'failure') {
  console.error('Usage: notify_ytdlp_status.mjs <success|failure> "<detail>"');
  process.exit(1);
}

const subject = status === 'success'
  ? 'Success: yt-dlp upgraded on Turbo'
  : 'Failure: yt-dlp upgrade on Turbo failed';

const timestamp = new Date().toString();
const body =
  (status === 'success'
    ? 'Homebrew upgraded yt-dlp on turbo. YouTube audio downloads in Video Watchlist use this binary.'
    : 'The daily yt-dlp Homebrew upgrade FAILED. YouTube (and X native video) audio downloads may start 403ing again until it is current.') +
  '\n\nTime: ' + timestamp +
  '\n\nDetails:\n' + (detail || '(none provided)') +
  '\n\n— sent by scripts/upgrade_ytdlp on Turbo';

const message =
  'To: ' + TO + '\r\n' +
  'Subject: ' + subject + '\r\n' +
  'Content-Type: text/plain; charset="UTF-8"\r\n' +
  '\r\n' +
  body;

const raw = Buffer.from(message).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ raw }),
});

if (!resp.ok) {
  console.error('Gmail send failed:', resp.status, await resp.text());
  process.exit(1);
}

console.log('Notification email sent:', subject);
