/** Parse Relay-dehydrated JS that X embeds in status-page HTML. Not JSON. */

export function readJsString(s: string, quoteIndex: number): { value: string; end: number } | null {
  const quote = s[quoteIndex];
  if (quote !== '"' && quote !== "'") return null;
  let i = quoteIndex + 1;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === quote) return { value: out, end: i + 1 };
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) return null;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === quote || n === '\\' || n === '/') out += n;
      else if (n === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 4;
      } else {
        out += n;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return null;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function skipBalanced(s: string, i: number, open: string, close: string): number {
  if (s[i] !== open) return i;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const str = readJsString(s, i);
      if (!str) return s.length;
      i = str.end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

function skipRelayValue(s: string, i: number): number {
  i = skipWs(s, i);
  if (s[i] === '"' || s[i] === "'") {
    const str = readJsString(s, i);
    return str ? str.end : s.length;
  }
  if (s.startsWith('null', i)) return i + 4;
  if (s.startsWith('true', i)) return i + 4;
  if (s.startsWith('false', i)) return i + 5;
  if (s[i] === '{') return skipBalanced(s, i, '{', '}');
  if (s[i] === '[') return skipBalanced(s, i, '[', ']');

  while (i < s.length && /[A-Za-z0-9_$.]/.test(s[i])) i++;
  i = skipWs(s, i);
  if (s[i] === '[') i = skipBalanced(s, i, '[', ']');
  i = skipWs(s, i);
  if (s[i] === '=') {
    i = skipWs(s, i + 1);
    if (s[i] === '{') i = skipBalanced(s, i, '{', '}');
    else if (s[i] === '[') i = skipBalanced(s, i, '[', ']');
    else if (s[i] === '"' || s[i] === "'") {
      const str = readJsString(s, i);
      if (str) i = str.end;
    }
  }
  return i;
}

export function readObjectStringFields(
  s: string,
  braceIndex: number,
  keys: string[],
): Record<string, string | null> {
  const want = new Set(keys);
  const out: Record<string, string | null> = {};
  if (s[braceIndex] !== '{') return out;
  let i = braceIndex + 1;
  while (i < s.length) {
    i = skipWs(s, i);
    if (s[i] === '}') break;
    if (s[i] === ',') { i++; continue; }

    const keyStart = i;
    while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    i = skipWs(s, i);
    if (s[i] !== ':') {
      i = skipRelayValue(s, i);
      continue;
    }
    i = skipWs(s, i + 1);

    if (want.has(key)) {
      if (s.startsWith('null', i)) {
        out[key] = null;
        i += 4;
      } else if (s[i] === '"' || s[i] === "'") {
        const str = readJsString(s, i);
        if (str) {
          out[key] = str.value;
          i = str.end;
        } else {
          i = skipRelayValue(s, i);
        }
      } else {
        i = skipRelayValue(s, i);
      }
    } else {
      i = skipRelayValue(s, i);
    }

    if (keys.every(k => k in out)) break;
  }
  return out;
}

export function findTypedObjectFields(
  html: string,
  typeName: string,
  keys: string[],
): Record<string, string | null> | null {
  const marker = `__typename:"${typeName}"`;
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const brace = html.lastIndexOf('{', idx);
  if (brace < 0) return null;
  return readObjectStringFields(html, brace, keys);
}

export function firstJsStringField(html: string, key: string): string | null {
  const needle = `${key}:"`;
  const idx = html.indexOf(needle);
  if (idx < 0) return null;
  const str = readJsString(html, idx + key.length + 1);
  return str?.value ?? null;
}

/** First note_tweet that is an object (not null) — returns its text field. */
export function findNoteTweetText(html: string): string | null {
  const typed = findTypedObjectFields(html, 'NoteTweet', ['text']);
  if (typed?.text) return typed.text;

  let from = 0;
  while (from < html.length) {
    const idx = html.indexOf('note_tweet:', from);
    if (idx < 0) return null;
    const i = idx + 'note_tweet:'.length;
    if (html.startsWith('null', i)) {
      from = i + 4;
      continue;
    }
    const brace = html.indexOf('{', i);
    if (brace < 0 || brace - i > 80) {
      from = i + 1;
      continue;
    }
    const fields = readObjectStringFields(html, brace, ['text']);
    if (fields.text) return fields.text;
    from = brace + 1;
  }
  return null;
}
