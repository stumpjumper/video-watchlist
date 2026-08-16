export type IngestCode =
  | 'bad_url'
  | 'unsupported'
  | 'timeout'
  | 'fetch_failed'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_429'
  | 'http_5xx'
  | 'login_wall'
  | 'paywall'
  | 'too_short'
  | 'not_article'
  | 'parse_failed'
  | 'extract_failed';

const RETRYABLE: ReadonlySet<IngestCode> = new Set([
  'timeout',
  'fetch_failed',
  'http_429',
  'http_5xx',
  'extract_failed',
]);

const MESSAGES: Record<IngestCode, string> = {
  bad_url:        "That doesn't look like a valid URL.",
  unsupported:    "This kind of link isn't supported yet.",
  timeout:        'Timed out fetching the page.',
  fetch_failed:   "Couldn't reach the site.",
  http_401:       'The site asked for a login (HTTP 401).',
  http_403:       'The site refused the request (HTTP 403) — often a login wall or bot block.',
  http_404:       'Page not found (HTTP 404).',
  http_429:       'The site rate-limited us. Try again in a few minutes.',
  http_5xx:       'The site returned a server error.',
  login_wall:     'Got a login/signup page instead of the article.',
  paywall:        'Looks like a paywall or cookie wall — not enough article text.',
  too_short:      'Extracted text is too short to be an article.',
  not_article:    'This looks like a regular X post, not an article or long post.',
  parse_failed:   "Fetched the page but couldn't find the article text. The page layout may have changed.",
  extract_failed: "Couldn't extract a readable article from this page.",
};

export class IngestError extends Error {
  readonly code: IngestCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(code: IngestCode, detail?: string) {
    const base = MESSAGES[code];
    const message = detail ? `${base} ${detail}` : base;
    super(message);
    this.name = 'IngestError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.detail = detail;
  }

  /** Stored in audio_error / shown in the UI. */
  toUserString(): string {
    return `${this.code}: ${this.message}`;
  }
}

export function ingestError(code: IngestCode, detail?: string): IngestError {
  return new IngestError(code, detail);
}

export function httpStatusError(status: number): IngestError {
  if (status === 401) return ingestError('http_401');
  if (status === 403) return ingestError('http_403');
  if (status === 404) return ingestError('http_404');
  if (status === 429) return ingestError('http_429');
  if (status >= 500) return ingestError('http_5xx', `(HTTP ${status})`);
  return ingestError('fetch_failed', `(HTTP ${status})`);
}

export function isRetryableFailure(err: unknown): boolean {
  if (err instanceof IngestError) return err.retryable;
  return true;
}

export function formatFailure(err: unknown): string {
  if (err instanceof IngestError) return err.toUserString();
  if (err instanceof Error) return err.message;
  return String(err);
}
