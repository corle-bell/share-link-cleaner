/**
 * Extract the first usable http(s) URL from messy Chinese-app share text.
 */

const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;

// Characters that often get glued onto the end of a copied URL.
// Keep path/query-safe endings: letters, digits, / - _ = & % ? # ~ +
const KEEP_ENDING = /[A-Za-z0-9/\-_=&%?#~+]/;

const SCHEMED_URL_RE =
  /https?:\/\/[^\s\u3000\u00a0\u200b<>"'`]+/gi;

// Bare host + path, e.g. v.douyin.com/abcXYZ/ or b23.tv/xxxxxx
const BARE_URL_RE =
  /(?<![A-Za-z0-9.+-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:com|cn|tv|net|cc|io|app|co|link|me|org|info|xyz|shop|vip|ly|to)\/[^\s\u3000\u00a0<>"'`]*)/gi;

const PROTOCOL_RELATIVE_RE =
  /(?<![A-Za-z0-9:])(\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}\/[^\s\u3000\u00a0<>"'`]*)/gi;

const PERCENT_SEQ = /%[0-9A-Fa-f]{2}/;
const HAS_SCHEME = /https?:\/\//i;

function trimTrailingJunk(url) {
  let out = url;
  while (out.length && !KEEP_ENDING.test(out.charAt(out.length - 1))) {
    out = out.slice(0, -1);
  }
  return out;
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function firstValid(matches, prefix) {
  if (!matches) return null;
  for (const raw of matches) {
    const cleaned = trimTrailingJunk(prefix ? prefix + raw : raw);
    if (isValidHttpUrl(cleaned)) return cleaned;
  }
  return null;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _;
      }
    });
}

function decodePercentChunk(chunk) {
  try {
    return decodeURIComponent(chunk);
  } catch {
    let out = '';
    for (let i = 0; i < chunk.length; ) {
      if (chunk[i] === '%' && i + 2 < chunk.length && /[0-9A-Fa-f]{2}/.test(chunk.slice(i + 1, i + 3))) {
        const trip = chunk.slice(i, i + 3);
        try {
          out += decodeURIComponent(trip);
        } catch {
          out += trip;
        }
        i += 3;
      } else {
        out += chunk[i];
        i += 1;
      }
    }
    return out;
  }
}

function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, decodePercentChunk);
  }
}

function decodePercentRepeated(text, maxTimes = 3) {
  let current = text;
  for (let i = 0; i < maxTimes; i += 1) {
    if (!PERCENT_SEQ.test(current)) break;
    const next = safeDecodeURIComponent(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Extract a URL from already-normalized plain text (no further decoding).
 * @param {string} source
 * @returns {string|null}
 */
function extractFromPlain(source) {
  const schemed = firstValid(source.match(SCHEMED_URL_RE), '');
  if (schemed) return schemed;

  const protocolRelative = source.match(PROTOCOL_RELATIVE_RE);
  if (protocolRelative) {
    const found = firstValid(
      protocolRelative.map((m) => m.replace(/^\/\//, '')),
      'https://'
    );
    if (found) return found;
  }

  const bare = source.match(BARE_URL_RE);
  if (bare) {
    const found = firstValid(bare, 'https://');
    if (found) return found;
  }

  return null;
}

/**
 * @param {string} text
 * @returns {string|null} The first extracted http(s) URL, or null.
 */
export function extractUrl(text) {
  if (text == null) return null;
  let source = String(text).replace(ZERO_WIDTH, '').trim();
  if (!source) return null;

  source = decodeHtmlEntities(source);

  // If the text already contains a literal http(s):// URL, extract it as-is
  // so legitimate percent-encoded query/path segments are preserved.
  if (HAS_SCHEME.test(source)) {
    const found = extractFromPlain(source);
    if (found) return found;
  }

  // Otherwise (or if extraction failed), try decoding %XX sequences and retry.
  if (PERCENT_SEQ.test(source)) {
    const decoded = decodePercentRepeated(source, 3);
    if (decoded !== source) {
      const decodedEntities = decodeHtmlEntities(decoded);
      const found = extractFromPlain(decodedEntities);
      if (found) return found;
    }
  }

  return extractFromPlain(source);
}

export {
  trimTrailingJunk,
  isValidHttpUrl,
  decodeHtmlEntities,
  safeDecodeURIComponent,
  decodePercentRepeated,
  extractFromPlain
};
