#!/usr/bin/env node
// Sends a status email via the Gmail API, routed through the OneCLI gateway
// (must be run as: onecli run --agent videowatchlist -- node notify_cert_status.js <status> <detail>).
// Used by ~/bin/renew_tailscale_https_cert to report Tailscale HTTPS cert renewal outcomes.

const TO = 'alfred@thelorbers.com';

const [status, detail] = process.argv.slice(2);
if (status !== 'success' && status !== 'failure') {
  console.error('Usage: notify_cert_status.js <success|failure> "<detail>"');
  process.exit(1);
}

const subject = status === 'success'
  ? 'Success: Was able to renew Tailscale cert on Turbo'
  : 'Failure: Unable to renew Tailscale cert on Turbo';

const timestamp = new Date().toString();
const body =
  (status === 'success'
    ? 'The Tailscale HTTPS cert for turbo.taild6cb04.ts.net was renewed successfully.'
    : 'The Tailscale HTTPS cert renewal for turbo.taild6cb04.ts.net FAILED. The Video Watchlist app may become unreachable over HTTPS when the current cert expires.') +
  '\n\nTime: ' + timestamp +
  '\n\nDetails:\n' + (detail || '(none provided)') +
  '\n\n— sent by ~/bin/renew_tailscale_https_cert on Turbo';

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
