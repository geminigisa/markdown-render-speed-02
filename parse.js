// A fast, dependency-free Markdown parser that renders HTML byte-identical
// to marked 18.1.3 with its default options (GFM on, breaks off).
// Written as a clean-room reimplementation from the CommonMark 0.31.2 and
// GFM 0.29 specifications and from marked's observable behaviour.
//
// Architecture: a line-cursor block scanner collects blocks (and link
// reference definitions) in one pass; a second walk renders each block,
// running a delimiter-stack inline scanner that emits HTML directly.
// No token AST is built for ordinary text; blocks are rendered as they
// are walked.

const ASCII_PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// Character classes. `cls(c)` returns 0 = other, 1 = whitespace,
// 2 = punctuation/symbol, 3 = alphanumeric (Unicode letter or number).
// ASCII is decided by table, non-ASCII by a cached Unicode test.
const _clsCache = new Map();
const _reSpace = /\s/;
const _rePunct = /[\p{P}\p{S}]/u;
const _reAlphaNum = /[\p{L}\p{N}]/u;
function cls(ch) {
  if (ch === '') return 1; // beginning / end of a line counts as whitespace
  const code = ch.charCodeAt(0);
  if (code < 128) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return 1;
    if (ASCII_PUNCT.indexOf(ch) >= 0) return 2;
    return 3;
  }
  let v = _clsCache.get(code);
  if (v === undefined) {
    v = _reSpace.test(ch) ? 1 : _rePunct.test(ch) ? 2 : _reAlphaNum.test(ch) ? 3 : 0;
    _clsCache.set(code, v);
  }
  return v;
}
function isSpaceCh(ch) { return cls(ch) === 1; }
function isPunctCh(ch) { return cls(ch) === 2; }
function isAlphaNumCh(ch) { return cls(ch) === 3; }

// Is `ch` an ASCII punctuation character (the backslash-escape set)?
function isAsciiPunct(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && ASCII_PUNCT.indexOf(ch) >= 0;
}

// Escape text for HTML output, decoding numeric character references on
// the way (they stand for the character itself). A bare `&` that cannot
// start a valid reference becomes `&amp;`; a `&name;` reference is kept
// verbatim. `<`, `>`, `"` and `'` are always escaped.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // numeric character reference?
      if (i + 1 < n && s.charCodeAt(i + 1) === 35) { // #
        let j = i + 2;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const d0 = j;
        let code = 0;
        let ok = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          let v = -1;
          if (d >= 48 && d <= 57) v = d - 48;
          else if (hex && d >= 97 && d <= 102) v = d - 87;
          else if (hex && d >= 65 && d <= 70) v = d - 55;
          if (v < 0) break;
          code = code * (hex ? 16 : 10) + v;
          j++;
          if (j - d0 > (hex ? 6 : 7)) { ok = false; break; }
          ok = true;
        }
        if (ok && j < n && s.charCodeAt(j) === 59 && j > d0) { // ;
          if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out += '\uFFFD';
          else if (code === 38) out += '&amp;';
          else if (code === 60) out += '&lt;';
          else if (code === 62) out += '&gt;';
          else if (code === 34) out += '&quot;';
          else if (code === 39) out += '&#39;';
          else out += String.fromCodePoint(code);
          i = j + 1;
          continue;
        }
      }
      // named reference `&word;` is kept verbatim
      if (i + 1 < n) {
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95) j++;
          else break;
        }
        if (j > i + 1 && j < n && s.charCodeAt(j) === 59) {
          out += s.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    // copy a run of ordinary characters at once
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Replicates marked's anyPunctuationOutsideCode replacement: code
// spans keep their delimiter backticks but have inner backticks
// neutralised to '+'; an escaped punctuation char becomes '++';
// bare backtick runs are unchanged. This runs BEFORE blockSkip, so
// a backtick run inside a link label can pair with a distant run
// (the intervening backticks are now '+', so [^`]+ can cross them).
function applyAnyPunct(src) {
  const n = src.length;
  let out = '';
  let changed = false;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 96) { // backtick run: try a code span
      let k = 0;
      while (i + k < n && src.charCodeAt(i + k) === 96) k++;
      let j = i + k;
      if (j < n && src.charCodeAt(j) !== 96) {
        // Find the first run of exactly k backticks not followed by
        // a backtick (non-greedy content: starts and ends non-backtick).
        let found = -1;
        let p = j;
        while (p < n) {
          if (src.charCodeAt(p) === 96) {
            let m = 0;
            while (p + m < n && src.charCodeAt(p + m) === 96) m++;
            if (m === k && (p + m >= n || src.charCodeAt(p + m) !== 96) && p > j) { found = p; break; }
            p += m;
          } else p++;
        }
        if (found > 0) {
          const rawContent = src.slice(i + k, found);
          const content = rawContent.replace(/`/g, '+');
          if (rawContent.indexOf('`') >= 0) changed = true;
          out += src.slice(i, i + k) + content + src.slice(found, found + k);
          i = found + k;
          continue;
        }
      }
      out += src.slice(i, i + k);
      i += k;
      continue;
    }
    if (c === 92 && i + 1 < n && isAsciiPunct(src[i + 1])) { // escaped punct -> ++
      out += '++';
      changed = true;
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return changed ? out : src;
}

// Compute the spans masked by marked's inline blockSkip rule
// (link | code | html, scanned left to right). A code span inside a
// link label that does not close makes the whole link alternative
// fail, so the dangling backtick pairs with a later one and swallows
// any emphasis delims between them. Delims inside a masked span are
// not emphasis delims. Returns a sorted array of [start, end).
function computeMaskedSpans(src) {
  const spans = [];
  const n = src.length;
  let i = 0;
  const codeEnd = (s, p) => {
    // Match (?<b>`+)[^`]+\k<b>(?!`) at p. Returns end index or -1.
    let k = 0;
    while (p + k < n && s.charCodeAt(p + k) === 96) k++;
    if (k === 0) return -1;
    let j = p + k;
    const start = j;
    while (j < n && s.charCodeAt(j) !== 96) j++;
    if (j === start) return -1; // [^`]+ needs at least one char
    // j is at a backtick; count the run
    let m = 0;
    while (j + m < n && s.charCodeAt(j + m) === 96) m++;
    if (m !== k) return -1;
    if (j + m < n && s.charCodeAt(j + m) === 96) return -1; // (?!`) already covered by m
    return j + m;
  };
  const linkEnd = (s, p) => {
    // Match the blockSkip link alternative at p (s[p] === '[').
    // Returns end index (after the closing ')') or -1.
    let j = p + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 96) {
        const e = codeEnd(s, j);
        if (e < 0) return -1;
        j = e;
        continue;
      }
      if (c === 91) return -1; // '[' not allowed in the label
      if (c === 93) { // ']'
        if (j + 1 < n && s.charCodeAt(j + 1) === 40) { j += 2; break; }
        return -1;
      }
      j++;
    }
    if (j >= n) return -1;
    // Destination: (?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { if (j + 1 >= n) return -1; j += 2; continue; }
      if (c === 41) return j + 1; // ')'
      if (c === 40) {
        j++;
        let closed = false;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 92) { if (j + 1 >= n) return -1; j += 2; continue; }
          if (d === 41) { j++; closed = true; break; }
          if (d === 40) return -1; // only one level of nesting
          j++;
        }
        if (!closed) return -1;
        continue;
      }
      j++;
    }
    return -1;
  };
  const htmlEnd = (s, p) => {
    // Match <(?! )[^<>]*?> at p.
    if (p + 1 < n && s.charCodeAt(p + 1) === 32) return -1;
    let j = p + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 60) return -1;
      if (c === 62) return j + 1;
      j++;
    }
    return -1;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 91) { // [
      const e = linkEnd(src, i);
      if (e > 0) { spans.push([i, e]); i = e; continue; }
      i++;
      continue;
    }
    if (c === 96 && (i === 0 || src.charCodeAt(i - 1) !== 96)) { // ` not preceded by `
      const e = codeEnd(src, i);
      if (e > 0) { spans.push([i, e]); i = e; continue; }
      i++;
      continue;
    }
    if (c === 60) { // <
      const e = htmlEnd(src, i);
      if (e > 0) { spans.push([i, e]); i = e; continue; }
      i++;
      continue;
    }
    i++;
  }
  return spans;
}
function isMasked(spans, pos) {
  // spans is sorted and non-overlapping; binary search.
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s[0]) hi = mid - 1;
    else if (pos >= s[1]) lo = mid + 1;
    else return true;
  }
  return false;
}
// Build the masked source: each blockSkip span is replaced by '[' +
// 'a's + ']' (same length, so indices still line up). Mirrors
// marked's blockSkip replacement.
function maskSource(src, spans) {
  let out = '';
  let last = 0;
  for (const [s, e] of spans) {
    out += src.slice(last, s);
    out += '[' + 'a'.repeat(Math.max(0, e - s - 2)) + ']';
    last = e;
  }
  out += src.slice(last);
  return out;
}
// Marked's fe: for each of `*`, `_`, `~`, the start index of the
// LAST run of that char in the masked source whose preceding char is
// not whitespace. Computed directly from src + spans (no masked
// string built): a run start inside a span is invisible; the char
// before a run that starts right at a span end is ']' in the masked
// source, otherwise it is the source char.
function computeLastDelimIdx(src, spans) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = src.length;
  // span ends, sorted (spans are sorted and non-overlapping).
  const ends = new Set(spans.map(s => s[1]));
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      if (!isMasked(spans, i)) {
        // Preceding char in the masked source.
        let o;
        if (i === 0) o = '\n';
        else if (ends.has(i)) o = ']';
        else o = src[i - 1];
        if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') last[c] = i;
      }
      i = j;
      continue;
    }
    i++;
  }
  return last;
}

// Escape for contexts where every `&`, `<`, `>`, `"` and `'` is encoded
// (code spans, autolink text and hrefs).
function escEncode(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; continue; }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Clean a link destination the way marked does: percent-encode it, then
// restore any `%25` back to `%` (so an already-encoded sequence survives).
// Returns null when the destination cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label so definitions and references match: trim,
// collapse inner whitespace runs to one space, Unicode case fold.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove a backslash before an ASCII punctuation character (`\x` -> `x`).
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    let j = i + 1;
    while (j < n && !(s.charCodeAt(j) === 92 && j + 1 < n && isAsciiPunct(s[j + 1]))) j++;
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Find the index of the closing bracket that balances the brackets in
// `str` (starting just after an opening bracket), or -1 when there is
// none, or -2 when there are more opens than closes. Backslash escapes
// are skipped. `b` is the two-character bracket pair, e.g. '()'.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) < 0 && str.indexOf(b[1]) < 0) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Remove trailing `c` characters (equivalent to str.replace(/c*$/, '')).
function rtrimChar(str, c) {
  let e = str.length;
  while (e > 0 && str.charCodeAt(e - 1) === c.charCodeAt(0)) e--;
  return str.slice(0, e);
}

// Split a GFM table row into cells. Pipes escaped with a backslash do not
// split; a leading/trailing empty cell is dropped when the row has no
// leading/trailing pipe. When `count` is given the row is padded/truncated
// to that many cells. Cell text is trimmed and `\|` becomes `|`.
function splitCells(row, count) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < n && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch;
    i++;
  }
  cells.push(cur);
  // A row without a leading pipe has a first cell that is the text before
  // the first pipe; splitCells in marked drops a first/last cell only when
  // it is empty after trimming (which is exactly the no-pipe case).
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  return cells;
}

// Trim trailing blank lines the way marked does: when more than one
// trailing blank line is present, all of them are removed; a single one
// is kept.
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Expand tabs in the leading whitespace run of `line` only. Tabs after
// the first non-whitespace character (e.g. after a `>` blockquote
// marker) are left alone: the inner block parser expands them relative
// to the marker's column (marked's blockquoteMarkerWhitespace), and
// expanding them against the outer column is wrong there.
function expandLeadingTabs(line) {
  let col = 0;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { out += ch; col++; i++; }
    else if (ch === '\t') { const add = 4 - (col % 4); out += ' '.repeat(add); col += add; i++; }
    else break;
  }
  return out + line.slice(i);
}

// Expand tabs in `line` to spaces, tracking the column from `indent`.
function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Decode numeric character references only (and escape a bare `&`).
// Used for plain-text rendering (image alt text).
function decodeRefs(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c !== 38) {
      let j = i + 1;
      while (j < n && s.charCodeAt(j) !== 38) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (i + 1 < n && s.charCodeAt(i + 1) === 35) {
      let j = i + 2;
      let hex = false;
      if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
      const d0 = j;
      let code = 0;
      let ok = false;
      while (j < n) {
        const d = s.charCodeAt(j);
        let v = -1;
        if (d >= 48 && d <= 57) v = d - 48;
        else if (hex && d >= 97 && d <= 102) v = d - 87;
        else if (hex && d >= 65 && d <= 70) v = d - 55;
        if (v < 0) break;
        code = code * (hex ? 16 : 10) + v;
        j++;
        if (j - d0 > (hex ? 6 : 7)) { ok = false; break; }
        ok = true;
      }
      if (ok && j < n && s.charCodeAt(j) === 59 && j > d0) {
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out += '\uFFFD';
        else if (code === 38) out += '&amp;';
        else out += String.fromCodePoint(code);
        i = j + 1;
        continue;
      }
    }
    if (i + 1 < n) {
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95) j++;
        else break;
      }
      if (j > i + 1 && j < n && s.charCodeAt(j) === 59) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    out += '&amp;';
    i++;
  }
  return out;
}

// Flanking info for a delimiter run: `prev` is the character before the
// run ('' at the start), `next` the character after it ('' at the end).
// The beginning and end of the line count as whitespace. `forDel` selects
// the plain punctuation set (strikethrough); otherwise the GFM set used
// for emphasis, in which `~` is not punctuation.
function flankInfo(prev, next, forDel) {
  const prevCls = prev === '' ? 1 : cls(prev);
  const nextCls = next === '' ? 1 : cls(next);
  const prevPunct = forDel ? prevCls === 2 : (prevCls === 2 && prev !== '~');
  const nextPunct = forDel ? nextCls === 2 : (nextCls === 2 && next !== '~');
  // `~` is punctuation for the right/close side (a `*`/`_` run immediately
  // before `~~` is a closer, e.g. `**or large ©**~~`), but not for the
  // left side (a run before `~` can still open, e.g. `*~foo~*`).
  const nextPunctClose = nextCls === 2;
  const left = nextCls !== 1 && (!nextPunct || prevCls === 1 || prevPunct);
  const right = prevCls !== 1 && (!prevPunct || nextCls === 1 || nextPunctClose);
  return { left, right, prevPunct, nextPunct, nextPunctClose };
}

// A raw HTML tag starting at `i` in `src`: returns its length, or 0 when
// the text at `i` is not a tag. Covers comments, open/close tags,
// processing instructions, declarations and CDATA sections.
function matchTag(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== 60) return 0; // <
  if (i + 1 >= n) return 0;
  const c1 = src[i + 1];
  // comment <!-- ... -->
  if (c1 === '!' && src[i + 2] === '-' && src[i + 3] === '-') {
    // Abruptly closed comments: <!--> and <!---> are complete on
    // their own; the text after them is not part of the comment.
    if (src[i + 4] === '>') return 5;
    if (src[i + 4] === '-' && src[i + 5] === '>') return 6;
    const end = src.indexOf('-->', i + 4);
    if (end < 0) return 0;
    return end + 3 - i;
  }
  // CDATA <![CDATA[ ... ]]>
  if (c1 === '!' && src.startsWith('[CDATA[', i + 2)) {
    const end = src.indexOf(']]>', i + 9);
    if (end < 0) return 0;
    return end + 3 - i;
  }
  // declaration <!Letter ...>
  if (c1 === '!' && i + 2 < n) {
    const d = src.charCodeAt(i + 2);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) {
      const end = src.indexOf('>', i + 3);
      if (end < 0) return 0;
      return end + 1 - i;
    }
  }
  // processing instruction <? ... ?>
  if (c1 === '?') {
    const end = src.indexOf('?>', i + 2);
    if (end < 0) return 0;
    return end + 2 - i;
  }
  // closing tag </name>
  if (c1 === '/') {
    let j = i + 2;
    if (j >= n) return 0;
    const d = src.charCodeAt(j);
    if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122))) return 0;
    while (j < n) {
      const e = src.charCodeAt(j);
      if ((e >= 65 && e <= 90) || (e >= 97 && e <= 122) || (e >= 48 && e <= 57) || e === 45) j++;
      else break;
    }
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j < n && src.charCodeAt(j) === 62) return j + 1 - i;
    return 0;
  }
  // open tag <name ...>
  if ((c1 >= 'A' && c1 <= 'Z') || (c1 >= 'a' && c1 <= 'z')) {
    let j = i + 1;
    while (j < n) {
      const d = src.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
      else break;
    }
    // attributes: each one must be preceded by whitespace
    while (j < n) {
      // whitespace before an attribute or the close
      let sawWs = false;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) { j++; sawWs = true; }
      if (j >= n) return 0;
      if (src.charCodeAt(j) === 62) return j + 1 - i; // >
      if (src.charCodeAt(j) === 47 && j + 1 < n && src.charCodeAt(j + 1) === 62) return j + 2 - i; // />
      // An attribute name with no whitespace before it (e.g.
      // `<m:abc>` or `<a href='bar'title=title>`) is not a tag.
      if (!sawWs) return 0;
      // attribute name
      const a0 = j;
      const d0 = src.charCodeAt(j);
      if (!((d0 >= 65 && d0 <= 90) || (d0 >= 97 && d0 <= 122) || d0 === 95 || d0 === 58)) return 0;
      j++;
      while (j < n) {
        const d = src.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
        else break;
      }
      if (j === a0) return 0;
      // optional = value; if there is no `=`, restore the position
      // so the whitespace before the next attribute is still seen
      // (e.g. `<a _boolean zoop:33=...>`).
      const k0 = j;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
      if (j < n && src.charCodeAt(j) === 61) { // =
        j++;
        while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
        if (j < n && (src.charCodeAt(j) === 34 || src.charCodeAt(j) === 39)) {
          const q = src[j];
          const end = src.indexOf(q, j + 1);
          if (end < 0) return 0;
          j = end + 1;
        } else {
          let k = j;
          while (k < n) {
            const d = src.charCodeAt(k);
            if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
            k++;
          }
          if (k === j) return 0;
          j = k;
        }
      } else {
        j = k0;
      }
    }
    return 0;
  }
  return 0;
}

// An autolink `<scheme:...>` or `<email>` starting at `i`.
// Returns {len, href, text} or null.
function matchAutolink(src, i) {
  const n = src.length;
  if (src.charCodeAt(i) !== 60) return null; // <
  const end = src.indexOf('>', i + 1);
  if (end < 0 || end - i > 300) return null;
  const inner = src.slice(i + 1, end);
  if (inner.length === 0) return null;
  // scheme: letter, then 1-31 letters/digits/+/-/. , then ':', then no
  // whitespace, control chars or angle brackets
  const colon = inner.indexOf(':');
  if (colon > 0) {
    const scheme = inner.slice(0, colon);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme)) {
      const rest = inner.slice(colon + 1);
      if (rest.length > 0 && !/[\s\x00-\x1f<>]/.test(rest)) {
        return { len: end + 1 - i, href: inner, text: inner };
      }
    }
  }
  // email
  if (isEmail(inner)) {
    return { len: end + 1 - i, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

function isEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  // domain: labels separated by dots, at least one dot, labels start and
  // end alphanumerically, no trailing dash/underscore lookahead
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(domain)) return false;
  const last = domain.charCodeAt(domain.length - 1);
  if (last === 45 || last === 95) return false; // - _
  return true;
}

// GFM extended autolink starting at `i`: www./http(s)://ftp:// or an
// email address. Returns {len, href, text} or null. `prevCh` is the
// character before `i` ('' at the start).
// Relaxed bare-email match: marked's email regex with a trailing lookahead
// that excludes `_` and `*` as well. Marked tokenizes an emphasis span's
// inner text without the closing delimiter, so its email regex never sees
// the trailing `_`/`*`; ours scans the raw text and stops a domain label
// early (or fails outright). Only use the longer match when the char after
// it is `_`/`*` AND an open delimiter of that char is pending.
const _reEmailLong = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])/;
function relaxEmail(src, i, strictLen, delims) {
  if (!delims) return strictLen;
  const rel = _reEmailLong.exec(src.slice(i));
  if (!rel || rel[0].length <= strictLen) return strictLen;
  const after = src[i + rel[0].length];
  if ((after === '_' || after === '*') && delims.some(d => d.active && d.open && d.ch === after)) return rel[0].length;
  return strictLen;
}

function matchUrl(src, i, prevCh, delims) {
  const n = src.length;
  // mailto: / xmpp: + email
  if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) {
    const proto = src.startsWith('mailto:', i) ? 'mailto:' : 'xmpp:';
    const rest = src.slice(i + proto.length);
    const m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(rest);
    if (m) {
      let len = proto.length + relaxEmail(src, i + proto.length, m[0].length, delims);
      // xmpp: may carry a single resource path /[A-Za-z0-9@.]+
      // (one segment only; a second `/` is not part of the link).
      if (proto === 'xmpp:') {
        const rm = /^\/[A-Za-z0-9@.]+/.exec(src.slice(i + len));
        if (rm) len += rm[0].length;
      }
      return { len, href: src.slice(i, i + len), text: src.slice(i, i + len) };
    }
    return null;
  }
  // scheme:// or www.
  let schemeLen = 0;
  let isWww = false;
  const low = src.slice(i, i + 8).toLowerCase();
  if (low.startsWith('https://')) schemeLen = 8;
  else if (low.startsWith('http://')) schemeLen = 7;
  else if (low.startsWith('ftp://')) schemeLen = 6;
  // www. must be lowercase (schemes above are case-insensitive).
  else if (src.startsWith('www.', i)) {
    // www. only after the start, whitespace, *, _, ~ or (
    if (!(prevCh === '' || prevCh === ' ' || prevCh === '\t' || prevCh === '\n' || prevCh === '*' || prevCh === '_' || prevCh === '~' || prevCh === '(')) return null;
    isWww = true;
    schemeLen = 4;
  }
  if (schemeLen > 0) {
    let j = i + schemeLen;
    // domain: labels of [a-zA-Z0-9-]+ separated by dots, at least one char
    let labels = 0;
    while (j < n) {
      const s0 = j;
      while (j < n) {
        const d = src.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
        else break;
      }
      if (j === s0) break;
      labels++;
      if (j < n && src.charCodeAt(j) === 46) { j++; continue; } // .
      break;
    }
    if (labels === 0) return null;
    // path: any run of non-space, non-< characters
    while (j < n) {
      const d = src.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 60) break;
      j++;
    }
    let text = src.slice(i, j);
    text = backpedal(text);
    if (text.length === 0) return null;
    const href = isWww ? 'http://' + text : text;
    return { len: text.length, href, text };
  }
  // bare email
  const m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(src.slice(i));
  const len = relaxEmail(src, i, m ? m[0].length : 0, delims);
  if (len > 0) {
    const email = src.slice(i, i + len);
    return { len, href: 'mailto:' + email, text: email };
  }
  return null;
}

// Trim trailing punctuation from a GFM autolink the way marked's
// backpedal does: drop trailing `?!.,:;*_'"~)` runs, keep balanced
// parentheses, and never leave a trailing `&` that starts an entity.
function backpedal(text) {
  const re = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
  let prev = text;
  for (;;) {
    const m = re.exec(prev);
    const next = m ? m[0] : '';
    if (next === prev) return next;
    prev = next;
  }
}

// A code span starting at `i` (a backtick run). Returns {len, text} or
// null when there is no matching closer run.
function matchCodeSpan(src, i) {
  const n = src.length;
  let k = 0;
  while (i + k < n && src.charCodeAt(i + k) === 96) k++;
  // find a maximal backtick run of exactly length k
  let j = i + k;
  while (j < n) {
    if (src.charCodeAt(j) === 96) {
      let r = 0;
      while (j + r < n && src.charCodeAt(j + r) === 96) r++;
      if (r === k) {
        let text = src.slice(i + k, j);
        text = text.replace(/\n/g, ' ');
        if (text.length > 0 && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32 && /[^ ]/.test(text)) {
          text = text.substring(1, text.length - 1);
        }
        return { len: j + r - i, text };
      }
      j += r;
    } else {
      j++;
    }
  }
  return null;
}

// Parse a `[...]` label starting at `i` (src[i] === '[').
// Returns {end, text} where `end` is the index just after the closing
// `]` and `text` is the raw label content, or null when no label ends
// here. Brackets nest two levels deep; backslash escapes and code spans
// are skipped as units.
function parseLabel(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === 96) { // backtick: skip a code span if it closes
      let k = 0;
      while (j + k < n && src.charCodeAt(j + k) === 96) k++;
      // A run immediately before the label-ending `]` (depth 0, and
      // that `]` starts a link continuation) is label content, not
      // a code span opener: marked's `` `+(?=\]) `` alternative
      // wins over a code span that would swallow the label end.
      if (depth === 0 && j + k < n && src.charCodeAt(j + k) === 93) {
        const ab = j + k + 1;
        if (ab >= n || src.charCodeAt(ab) === 40 || src.charCodeAt(ab) === 91) {
          if (k >= 2) { j += k; continue; }
          return null;
        }
      }
      // Marked's label regex treats a backtick run + non-backtick
      // content + any backtick run as a code span (the closing run
      // need not match the opening length, e.g. `` ``url` ``), so
      // the first backtick run after the opener closes it.
      let m = j + k;
      let found = -1;
      while (m < n) {
        if (src.charCodeAt(m) === 96) {
          let r = 0;
          while (m + r < n && src.charCodeAt(m + r) === 96) r++;
          found = m + r;
          break;
        }
        m++;
      }
      if (found >= 0) { j = found; continue; }
      // No closer: a run of 2+ backticks right before `]` is label
      // content; anything else fails the label (marked's label
      // regex cannot match the backtick at all).
      if (k >= 2 && j + k < n && src.charCodeAt(j + k) === 93) { j += k; continue; }
      return null;
    }
    if (c === 91) { // [
      if (depth >= 2) return null;
      depth++;
      j++;
      continue;
    }
    if (c === 93) { // ]
      if (depth === 0) return { end: j + 1, text: src.slice(i + 1, j) };
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse a reference label `[...]` starting at `i` (for reflinks).
// No nested brackets, no blank line inside, at most 999 characters,
// and not empty or all whitespace. Returns {end, text} or null.
function parseRefLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  let firstNonSpace = -1;
  while (j < n && j - i - 1 < 999) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; if (firstNonSpace < 0) firstNonSpace = j - 2; continue; }
    if (c === 91 || c === 93) {
      if (c === 93) {
        if (firstNonSpace < 0) return null; // empty or all whitespace
        return { end: j + 1, text: src.slice(i + 1, j) };
      }
      return null;
    }
    if (c === 10) {
      // a newline not followed by a blank line is allowed
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src.charCodeAt(k) === 10) return null;
      if (k >= n) return null;
      j++;
      continue;
    }
    if (firstNonSpace < 0 && c !== 32 && c !== 9 && c !== 10) firstNonSpace = j;
    j++;
  }
  return null;
}

// Does the label at `labelStart` in `src` hold a `<` that opens a tag or
// autolink reaching past the label's end? Such a label cannot be a link.
function isLabelEndInsideToken(src, label, labelStart) {
  if (label.indexOf('<') < 0) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = matchCodeSpan(label, i);
      if (code) { i += code.len - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const tagLen = matchTag(tokenSrc, 0);
    const auto = tagLen === 0 ? matchAutolink(tokenSrc, 0) : null;
    const len = tagLen > 0 ? tagLen : (auto ? auto.len : 0);
    if (!len) continue;
    if (len > label.length - i) return true;
    i += len - 1;
  }
  return false;
}

// Parse the `(dest "title")` part of an inline link starting at `after`
// (the `(`). Returns {end, href, title} or null when it is not a valid
// inline destination. `end` is the index just past the closing `)`.
function parseInlineDest(src, after) {
  const n = src.length;
  let k = after + 1;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  if (k >= n) return null;
  let dest = null;
  let destEnd = -1;
  if (src.charCodeAt(k) === 60) { // < angle destination (required when present)
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const d = src.charCodeAt(m);
      if (d === 92) { m += 2; continue; }
      if (d === 10 || d === 60 || d === 62) break;
      m++;
    }
    if (m < n && src.charCodeAt(m) === 62) { dest = src.slice(k + 1, m); destEnd = m + 1; ok = true; }
    if (!ok) return null; // an angle destination never falls back to bare
  }
  if (dest === null) {
    // bare destination: non-space run with balanced parentheses
    let m = k;
    let depth = 0;
    let closed = -1;
    while (m < n) {
      const d = src.charCodeAt(m);
      if (d === 32 || d === 9 || d === 10 || d < 32) break;
      if (d === 92 && m + 1 < n) { m += 2; continue; }
      if (d === 40) { depth++; m++; continue; }
      if (d === 41) {
        if (depth === 0) { closed = m; break; }
        depth--;
        m++;
        continue;
      }
      m++;
    }
    if (closed < 0) {
      // The destination ended at whitespace (a title may follow) or
      // at end of input (the closing-paren check below then fails).
      dest = src.slice(k, m);
      destEnd = m;
    } else {
      dest = src.slice(k, closed);
      destEnd = closed;
    }
  }
  // optional title, then the closing paren
  let m = destEnd;
  let title = null;
  let w = m;
  while (w < n && (src[w] === ' ' || src[w] === '\t')) w++;
  if (w < n && src.charCodeAt(w) === 10) {
    w++;
    while (w < n && (src[w] === ' ' || src[w] === '\t')) w++;
  }
  if (w < n && (src.charCodeAt(w) === 34 || src.charCodeAt(w) === 39 || src.charCodeAt(w) === 40)) {
    const q = src.charCodeAt(w);
    const closeQ = q === 40 ? 41 : q;
    let t = w + 1;
    let ok = false;
    while (t < n) {
      const d = src.charCodeAt(t);
      if (d === 92) { t += 2; continue; }
      if (d === closeQ) { ok = true; break; }
      t++;
    }
    if (ok) {
      title = src.slice(w + 1, t);
      m = t + 1;
    } else {
      return null;
    }
  }
  while (m < n && (src[m] === ' ' || src[m] === '\t' || src[m] === '\n')) m++;
  if (m >= n || src.charCodeAt(m) !== 41) return null; // )
  // the closing paren must not be escaped
  let bs = 0;
  let b = m - 1;
  while (b >= 0 && src.charCodeAt(b) === 92) { bs++; b--; }
  if (bs % 2 === 1) return null;
  return { end: m + 1, href: dest, title };
}

// Try to parse a link or image starting at `i` in `src` (src[i] is `[`,
// or `!` followed by `[`). Returns a part object, or null when the text
// at `i` is not a link. `ctx` holds the definitions and the shared
// inline state.
function tryLink(src, i, ctx) {
  const n = src.length;
  const isImage = src.charCodeAt(i) === 33; // !
  const lb = isImage ? i + 1 : i;
  if (src.charCodeAt(lb) !== 91) return null; // [
  const label = parseLabel(src, lb);
  if (!label) return null;
  const labelStart = lb + 1;
  if (isLabelEndInsideToken(src, label.text, labelStart)) return null;
  const after = label.end;
  // --- inline link [text](dest "title") ---
  if (after < n && src.charCodeAt(after) === 40) { // (
    const inl = parseInlineDest(src, after);
    if (inl) return finishLink(src, i, inl.end, label.text, inl.href, inl.title, isImage, ctx);
    // A failed inline link falls through to the reference/shortcut
    // forms below (e.g. `[foo](not a link)` with a def for `foo`
    // is a shortcut reference link, not literal text).
  }
  // --- reference link [text][ref] ---
  if (after < n && src.charCodeAt(after) === 91) { // [
    // Collapsed reference [text][]: the ref label is the text itself.
    if (after + 1 < n && src.charCodeAt(after + 1) === 93) { // ]
      const def = ctx.defs.get(normalizeLabel(label.text));
      if (def) return finishLink(src, i, after + 2, label.text, def.href, def.title, isImage, ctx);
      return null;
    }
    const ref = parseRefLabel(src, after);
    if (ref) {
      const def = ctx.defs.get(normalizeLabel(ref.text));
      if (def) {
        return finishLink(src, i, ref.end, label.text, def.href, def.title, isImage, ctx);
      }
      // undefined reference: only the first character is text
      return null;
    }
    return null;
  }
  // --- shortcut / collapsed reference [text] / [text][] ---
  {
    let refText = label.text;
    let end = after;
    if (after + 1 < n && src.charCodeAt(after) === 91 && src.charCodeAt(after + 1) === 93) {
      end = after + 2;
    }
    const def = ctx.defs.get(normalizeLabel(refText));
    if (def) {
      return finishLink(src, i, end, label.text, def.href, def.title, isImage, ctx);
    }
    return null;
  }
}

// Build the link/image part for a matched link spanning src[i..end).
// The label text is parsed inline; when a non-image link's text holds
// another link, the outer link fails (null) and the caller treats the
// `[` as plain text.
function finishLink(src, i, end, labelText, href, title, isImage, ctx) {
  const text = labelText.replace(/\\([\[\]])/g, '$1');
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const parts = scanInline(text, ctx);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  const cleanHref = href ? unescapePunct(href) : href;
  const cleanTitle = title ? unescapePunct(title) : title;
  if (isImage) {
    return { t: 5, len: end - i, href: cleanHref, title: cleanTitle, alt: plainRender(parts) };
  }
  return { t: 4, len: end - i, href: cleanHref, title: cleanTitle, parts, auto: false };
}

// ---------------------------------------------------------------------------
// Inline scanner (chunk 2c)
// ---------------------------------------------------------------------------

const _reStartATag = /^<a /i;
const _reEndATag = /^<\/a>/i;
const _reStartPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const _reEndPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Escape for HTML output without decoding numeric character references:
// `<`, `>`, `"` and `'` are always escaped; `&` is escaped unless it
// starts a valid reference (`&#123;`, `&#x1f;` or `&word;`).
function escP(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      let j = i + 1;
      let ok = false;
      if (j < n && s.charCodeAt(j) === 35) { // # numeric reference
        j++;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x hex
          j++;
          const d0 = j;
          while (j < n) {
            const d = s.charCodeAt(j);
            if ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)) j++;
            else break;
          }
          ok = j > d0 && j - d0 <= 6 && j < n && s.charCodeAt(j) === 59;
        } else {
          const d0 = j;
          while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
          ok = j > d0 && j - d0 <= 7 && j < n && s.charCodeAt(j) === 59;
        }
      } else { // named reference &word;
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95) j++;
          else break;
        }
        ok = j > i + 1 && j < n && s.charCodeAt(j) === 59;
      }
      if (ok) { out += s.slice(i, j + 1); i = j + 1; continue; }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Scan inline content into parts. Part kinds:
// 0 text {s, raw} | 1 code span {s} | 2 raw HTML {s} | 3 autolink
// {href, s} | 4 link {href, title, parts} | 5 image {href, title, alt}
// | 6 delimiter run {ch, len} | 7 emphasis {tag, parts} | 8 hard break.
function scanInline(src, ctx) {
  const parts = [];
  const delims = [];
  // Marked's masking pipeline (#n): anyPunctuationOutsideCode first,
  // then blockSkip; fe (last visible delim run) is read off the
  // final masked source. All replacements preserve length, so the
  // indices still line up with src. Fast path: no emphasis delims
  // means no masking can matter.
  let masked = null;
  let lastIdx = null;
  if (src.indexOf('*') >= 0 || src.indexOf('_') >= 0 || src.indexOf('~') >= 0) {
    const intermediate = (src.indexOf('`') >= 0 || src.indexOf('\\') >= 0) ? applyAnyPunct(src) : src;
    // No backtick / [ / < means blockSkip can match nothing.
    if (intermediate.indexOf('`') >= 0 || intermediate.indexOf('[') >= 0 || intermediate.indexOf('<') >= 0) {
      masked = computeMaskedSpans(intermediate);
      lastIdx = computeLastDelimIdx(intermediate, masked);
    } else {
      masked = [];
      lastIdx = { '*': 1e9, '_': 1e9, '~': 1e9 };
    }
  } else {
    masked = [];
    lastIdx = { '*': 1e9, '_': 1e9, '~': 1e9 };
  }
  const n = src.length;
  let i = 0;
  let ts = 0;
  const flush = (end) => {
    if (end > ts) parts.push({ t: 0, s: src.slice(ts, end), raw: ctx.inRawBlock });
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const d = src[i + 1];
        // Backslash hard break: the leading spaces/tabs of the next
        // line are stripped.
        if (d === '\n') { flush(i); parts.push({ t: 8 }); i += 2; while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++; ts = i; continue; }
        if (isAsciiPunct(d)) { flush(i); parts.push({ t: 0, s: d, raw: false, lit: true }); i += 2; ts = i; continue; }
      }
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break when 2+ spaces precede it
      let k = i - 1;
      let spaces = 0;
      while (k >= ts && src.charCodeAt(k) === 32) { spaces++; k--; }
      // Two-space hard break: the leading spaces/tabs of the next
      // line are stripped.
      if (spaces >= 2) { flush(i - spaces); parts.push({ t: 8 }); i++; while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++; ts = i; continue; }
      i++;
      continue;
    }
    if (c === 96) { // backtick: code span
      const code = matchCodeSpan(src, i);
      if (code) { flush(i); parts.push({ t: 1, s: code.text }); i += code.len; ts = i; continue; }
      // No matching closer for this run: the whole run is literal
      // text (a shorter run starting inside it must not match).
      let k = 0;
      while (i + k < n && src.charCodeAt(i + k) === 96) k++;
      i += k;
      continue;
    }
    if (c === 60) { // <: autolink or raw tag
      const auto = matchAutolink(src, i);
      // An <...> autolink is still created inside a link (marked
      // nests it); only bare-URL/email autolinks are suppressed.
      if (auto) { flush(i); parts.push({ t: 3, href: auto.href, s: auto.text }); i += auto.len; ts = i; continue; }
      const tl = matchTag(src, i);
      if (tl > 0) {
        const tagText = src.slice(i, i + tl);
        flush(i);
        parts.push({ t: 2, s: tagText });
        if (!ctx.inLink && _reStartATag.test(tagText)) ctx.inLink = true;
        else if (ctx.inLink && _reEndATag.test(tagText)) ctx.inLink = false;
        if (!ctx.inRawBlock && _reStartPreScriptTag.test(tagText)) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && _reEndPreScriptTag.test(tagText)) ctx.inRawBlock = false;
        i += tl; ts = i; continue;
      }
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) { // [ or ![
      const part = tryLink(src, i, ctx);
      if (part) { flush(i); parts.push(part); i += part.len; ts = i; continue; }
      i++;
      continue;
    }
    if (c === 42 || c === 95) { // * or _: emphasis delimiter run
      let len = 0;
      while (i + len < n && src.charCodeAt(i + len) === c) len++;
      const ch = c === 42 ? '*' : '_';
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + len < n ? src[i + len] : '';
      const fl = flankInfo(prev, next, false);
      let open;
      let close;
      if (ch === '*') { open = fl.left; close = fl.right; }
      else { open = fl.left && (!fl.right || fl.prevPunct); close = fl.right && (!fl.left || fl.nextPunctClose); }
      if (open || close) {
        // pos is the RAW run start in the source (scanning back over
        // same-char chars, which may include an escaped one): the fe
        // bound compares raw run starts.
        let rawStart = i;
        while (rawStart > 0 && src.charCodeAt(rawStart - 1) === c) rawStart--;
        // A delimiter inside a masked span (link/code/html, after
        // the anyPunct + blockSkip pipeline) is not an emphasis
        // delimiter at all: marked's masked source hides it. Leave
        // it in the running text (do not flush; ts stays put).
        if (isMasked(masked, rawStart)) { i += len; continue; }
        flush(i);
        delims.push({ ch, idx: parts.length, len, olen: len, prev, next, open, close, active: true, pos: rawStart });
        parts.push({ t: 6, ch, len });
        i += len; ts = i; continue;
      }
      i += len;
      continue;
    }
    if (c === 126) { // ~: strikethrough delimiter run (1 or 2 tildes)
      let len = 0;
      while (i + len < n && src.charCodeAt(i + len) === 126) len++;
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + len < n ? src[i + len] : '';
      const fl = flankInfo(prev, next, true);
      if (fl.left || fl.right) {
        let rawStart = i;
        while (rawStart > 0 && src.charCodeAt(rawStart - 1) === 126) rawStart--;
        if (isMasked(masked, rawStart)) { i += len; continue; }
        flush(i);
        delims.push({ ch: '~', idx: parts.length, len, olen: len, prev, next, open: fl.left, close: fl.right, active: true, pos: rawStart });
        parts.push({ t: 6, ch: '~', len });
        i += len; ts = i; continue;
      }
      i += len;
      continue;
    }
    if (c === 119 || c === 104 || c === 102 || c === 109) { // w h f m: GFM autolink
      const prevCh = i > 0 ? src[i - 1] : '';
      const url = matchUrl(src, i, prevCh, delims);
      // No autolink inside a link (nested links are not allowed).
      if (url && !ctx.inLink) { flush(i); parts.push({ t: 3, href: url.href, s: url.text }); i += url.len; ts = i; continue; }
      i++;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { // email start?
      const prevCh = i > 0 ? src[i - 1] : '';
      if (prevCh === '' || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%+-'.indexOf(prevCh) < 0) {
        const url = matchUrl(src, i, prevCh, delims);
        // No autolink inside a link (nested links are not allowed).
        if (url && !ctx.inLink) { flush(i); parts.push({ t: 3, href: url.href, s: url.text }); i += url.len; ts = i; continue; }
      }
      i++;
      continue;
    }
    i++;
  }
  flush(n);
  resolveEmphasis(parts, delims, lastIdx);
  return parts;
}

// Forward scan from `opener` (a `*`/`_` delim at index oi): find the
// first later delimiter of the same char that pairs with it, using
// marked's emStrong counting. The opener is tried at each length
// from its current length down to 1 (marked's lexer retries at the
// next character when a longer run fails to match); `m` starts at
// the tried length and `y` at the opener's ORIGINAL length.
// Intermediate runs and the closer count at their full length:
// nothing past the opener has been consumed yet in this
// left-to-right pass. Returns { ci, k, m, f, b } (the closer's
// delim index, the opener length that matched, the final count,
// the odd-match accumulation, the closer run's length) or null.
function scanForward(opener, delims, oi, lastIdx) {
  const ch = opener.ch;
  const y = opener.olen;
  // R: the opener is a "right-flanking" opener (preceded by a
  // non-space and (followed by punctuation or (`*` and the preceding
  // char is not `*`/`_` or punctuation))): then every closer
  // candidate goes through the odd-match branch first. Computed
  // from the full run's context, so it is the same for every tried
  // length.
  const p = opener.prev;
  let R = false;
  if (p !== '' && !isSpaceCh(p)) {
    const nx = opener.next;
    const d = (nx !== '' && nx !== opener.ch && isPunctCh(nx) && nx !== '~') ? nx : '';
    const h = p === '*' || p === '_' || isPunctCh(p);
    R = d !== '' || (opener.ch === '*' && !h);
  }
  // Marked's emStrong RDelim regex skips one same-char run that sits
  // inside the opposite pair's span: a single `*` inside `__...__`
  // (for `*` scans), a single `_` inside `**...**` (for `_` scans).
  // The span must start at the first opposite-pair run after the
  // opener, contain exactly one same-char run of length 1, and close
  // at the next opposite-pair run; any other `*`/`_` run in between
  // breaks the pattern (the regex prefix cannot cross `*` or `_`).
  // The region is a property of the text after the opener, so it is
  // computed over all following delims, not just up to the closer:
  // if the closer itself is the skipped run, the scan never sees it.
  let skipIdx = -1;
  {
    const other = ch === '*' ? '_' : '*';
    for (let k = oi + 1; k < delims.length; k++) {
      const D = delims[k];
      if (D.ch !== '*' && D.ch !== '_') continue;
      if (D.ch === other && D.olen >= 2) {
        let s1 = -1;
        for (let j = k + 1; j < delims.length; j++) {
          const E = delims[j];
          if (E.ch !== '*' && E.ch !== '_') continue;
          if (E.ch === ch && E.olen === 1) s1 = j;
          break;
        }
        if (s1 >= 0) {
          for (let j = s1 + 1; j < delims.length; j++) {
            const E = delims[j];
            if (E.ch !== '*' && E.ch !== '_') continue;
            if (E.ch === other && E.olen >= 2) skipIdx = s1;
            break;
          }
        }
      }
      break; // the first `*`/`_` run after the opener decides
    }
  }
  for (let k = opener.len; k >= 1; k--) {
    let m = k;
    let f = 0;
    for (let j = oi + 1; j < delims.length; j++) {
      const D = delims[j];
      if (D.ch !== ch) continue;
      if (j === skipIdx) continue; // skipped by the opposite-pair span
      if (!D.active) continue;
      // Marked's emStrong closer search stops past the last visible
      // run of this char in the masked source (fe bound).
      if (lastIdx && D.pos !== undefined && D.pos > lastIdx[ch]) continue;
      if (!D.open && !D.close) continue;
      const b = D.olen;
      if (D.open && !D.close) { m += b; continue; }
      if (!D.close) continue;
      const followedByWs = D.next === '' || isSpaceCh(D.next);
      if ((D.open && D.close && !followedByWs) || R) {
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      // m <= 0: D is the match, unless rule 9 bars this length.
      const both = (opener.open && opener.close) || (D.open && D.close);
      if (both && (k + D.len) % 3 === 0 && k % 3 !== 0) continue;
      return { ci: j, k, m, f, b };
    }
    // No match at this length; retry with one fewer delimiter char.
  }
  return null;
}

// Forward scan for a `~` opener: marked's del counting. Only runs
// of the same length count; open runs add, close runs subtract; the
// match is the first closer where the count reaches <= 0. The
// opener is tried at each length from its current length down to 1
// (a run of 3+ never strikes, so lengths above 2 are skipped).
function scanForwardTilde(opener, delims, oi, lastIdx) {
  for (let k = opener.len; k >= 1; k--) {
    if (k > 2) continue;
    let p = k;
    for (let j = oi + 1; j < delims.length; j++) {
      const D = delims[j];
      if (D.ch !== '~') continue;
      if (!D.active) continue;
      // Marked's del closer search stops past the last visible `~`
      // run in the masked source (Me bound).
      if (lastIdx && D.pos !== undefined && D.pos > lastIdx['~']) continue;
      if (D.len !== k) continue;
      if (!D.open && !D.close) continue;
      if (D.open && !D.close) { p += D.len; continue; }
      if (!D.close) continue;
      p -= D.len;
      if (p > 0) continue;
      return { ci: j, k };
    }
  }
  return null;
}

// The first (or last) source character of parts[from..to] for
// flanking purposes. Returns '' when the range is empty.
function edgeChar(parts, from, to, first) {
  if (first) {
    for (let i = from; i <= to; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p.t === 0 && p.s.length) return p.s[0];
      if (p.t === 1) return '`';
      if (p.t === 2 && p.s.length) return p.s[0];
      if (p.t === 3) return '<';
      if (p.t === 4) return '[';
      if (p.t === 5) return '!';
      if (p.t === 6) return p.ch;
      if (p.t === 8) return ' ';
    }
    return '';
  }
  for (let i = to; i >= from; i--) {
    const p = parts[i];
    if (!p) continue;
    if (p.t === 0 && p.s.length) return p.s[p.s.length - 1];
    if (p.t === 1) return '`';
    if (p.t === 2 && p.s.length) return p.s[p.s.length - 1];
    if (p.t === 3) return '>';
    if (p.t === 4) return ']';
    if (p.t === 5) return ']';
    if (p.t === 6) return p.ch;
    if (p.t === 8) return ' ';
  }
  return '';
}

// Resolve emphasis/delimiter runs in `parts` using marked's
// left-to-right model: scan openers in order, match each with the
// first closer its forward scan reaches, and resolve the inner
// content recursively (marked re-lexes the token's inner text).
// The token's tag comes from min(opener, closer) parity (odd = em,
// even = strong); the runs' unused chars join the inner content
// and are re-lexed there, the opener's retry-skipped chars stay
// literal before the node, and a closer overshoot stays literal
// after it. `~` pairs use marked's del counting (equal lengths).
function resolveEmphasis(parts, delims, lastIdx) {
  let oi = 0;
  while (oi < delims.length) {
    const opener = delims[oi];
    if (!opener.active || !opener.open) { oi++; continue; }
    let hit = null;
    let tag = '';
    let strip = 0;
    let innerOpenLen = 0;
    let innerCloseLen = 0;
    let afterCloseLen = 0;
    if (opener.ch === '~') {
      const h = scanForwardTilde(opener, delims, oi, lastIdx);
      if (h) { hit = h; tag = 'del'; strip = h.k; }
    } else {
      const h = scanForward(opener, delims, oi, lastIdx);
      if (h) {
        hit = h;
        const bEff = Math.min(h.b, h.b + h.m + h.f);
        strip = (Math.min(h.k, bEff) % 2 === 1) ? 1 : 2;
        tag = strip === 1 ? 'em' : 'strong';
        innerOpenLen = h.k - strip;
        innerCloseLen = bEff - strip;
        afterCloseLen = h.b - bEff;
      }
    }
    if (!hit) { oi++; continue; }
    const closer = delims[hit.ci];
    const oiIdx = opener.idx;
    const ciIdx = closer.idx;
    const contentFrom = oiIdx + 1;
    const contentTo = ciIdx - 1;
    const firstCh = edgeChar(parts, contentFrom, contentTo, true);
    const lastCh = edgeChar(parts, contentFrom, contentTo, false);
    // Inner content: the opener's unused chars, the text between
    // the runs, the closer's unused chars — all re-lexed by
    // recursion, as marked re-lexes the token text. The leading
    // and trailing leftover runs are fresh runs at the inner
    // text's edges (prev/next '' there).
    const inner = [];
    const innerDelims = [];
    if (innerOpenLen > 0) {
      const nx = firstCh !== '' ? firstCh : closer.ch;
      const fl = flankInfo('', nx, false);
      let open, close;
      if (opener.ch === '*') { open = fl.left; close = fl.right; }
      else { open = fl.left && (!fl.right || fl.prevPunct); close = fl.right && (!fl.left || fl.nextPunctClose); }
      inner.push({ t: 6, ch: opener.ch, len: innerOpenLen });
      innerDelims.push({ ch: opener.ch, idx: 0, len: innerOpenLen, olen: innerOpenLen, prev: '', next: nx, open, close, active: true, pos: opener.pos });
    }
    const innerShift = innerOpenLen > 0 ? 1 : 0;
    for (let k = oi + 1; k < hit.ci; k++) {
      const d = delims[k];
      innerDelims.push({ ch: d.ch, idx: d.idx - contentFrom + innerShift, len: d.len, olen: d.olen, prev: d.prev, next: d.next, open: d.open, close: d.close, active: d.active, pos: d.pos });
    }
    for (let i = contentFrom; i <= contentTo; i++) inner.push(parts[i]);
    if (innerCloseLen > 0) {
      const pv = lastCh !== '' ? lastCh : opener.ch;
      const fl = flankInfo(pv, '', false);
      let open, close;
      if (closer.ch === '*') { open = fl.left; close = fl.right; }
      else { open = fl.left && (!fl.right || fl.prevPunct); close = fl.right && (!fl.left || fl.nextPunctClose); }
      inner.push({ t: 6, ch: closer.ch, len: innerCloseLen });
      innerDelims.push({ ch: closer.ch, idx: inner.length - 1, len: innerCloseLen, olen: innerCloseLen, prev: pv, next: '', open, close, active: true, pos: closer.pos });
    }
    resolveEmphasis(inner, innerDelims, lastIdx);
    const node = { t: 7, tag, parts: inner };
    // Replace the span [oiIdx..ciIdx] with the retry-skipped
    // opener chars (literal), the node, and the closer overshoot
    // (literal, still active as a delimiter).
    const rep = [];
    const retrySkipped = opener.len - hit.k;
    if (retrySkipped > 0) rep.push({ t: 6, ch: opener.ch, len: retrySkipped });
    rep.push(node);
    if (afterCloseLen > 0) rep.push({ t: 6, ch: closer.ch, len: afterCloseLen });
    const removed = ciIdx - oiIdx + 1;
    parts.splice(oiIdx, removed, ...rep);
    const delta = rep.length - removed;
    opener.active = false;
    if (afterCloseLen > 0) { closer.len = afterCloseLen; closer.idx = oiIdx + rep.length - 1; }
    else closer.active = false;
    for (let k = 0; k < delims.length; k++) {
      const d = delims[k];
      if (d === opener || d === closer) continue;
      if (d.idx > ciIdx) d.idx += delta;
    }
    // Delimiters between the opener and the closer are now inside
    // the emphasis node; they can no longer pair with anything
    // outside it.
    for (let k = oi + 1; k < hit.ci; k++) delims[k].active = false;
    // Continue at the closer: a leftover closer stays active and
    // may open; otherwise the loop skips past it.
    oi = hit.ci;
  }
}

// Render parts to HTML.
function renderParts(parts) {
  let out = '';
  for (const p of parts) {
    switch (p.t) {
      case 0: out += p.raw ? p.s : (p.lit ? escEncode(p.s) : escText(p.s)); break;
      case 1: out += '<code>' + escEncode(p.s) + '</code>'; break;
      case 2: out += p.s; break;
      case 3: {
        const u = cleanUrl(p.href);
        if (u === null) { out += escEncode(p.s); break; }
        out += '<a href="' + escEncode(u) + '">' + escEncode(p.s) + '</a>';
        break;
      }
      case 4: {
        const u = cleanUrl(p.href);
        if (u === null) { out += renderParts(p.parts); break; }
        out += '<a href="' + escP(u) + '"';
        if (p.title) out += ' title="' + escP(p.title) + '"';
        out += '>' + renderParts(p.parts) + '</a>';
        break;
      }
      case 5: {
        const u = cleanUrl(p.href);
        if (u === null) { out += escP(p.alt); break; }
        out += '<img src="' + escP(u) + '" alt="' + escP(p.alt) + '"';
        if (p.title) out += ' title="' + escP(p.title) + '"';
        out += '>';
        break;
      }
      case 6: out += p.ch.repeat(p.len); break;
      case 7: out += '<' + p.tag + '>' + renderParts(p.parts) + '</' + p.tag + '>'; break;
      case 8: out += '<br>'; break;
    }
  }
  return out;
}

// Render parts to plain text (image alt text): no tags, no escaping
// beyond numeric-reference decoding of text runs.
function plainRender(parts) {
  let out = '';
  for (const p of parts) {
    switch (p.t) {
      case 0: out += (p.raw || p.lit) ? p.s : decodeRefs(p.s); break;
      case 1: out += p.s; break;
      case 2: out += p.s; break;
      case 3: out += p.s; break;
      case 4: out += plainRender(p.parts); break;
      case 5: out += p.alt; break;
      case 6: out += p.ch.repeat(p.len); break;
      case 7: out += plainRender(p.parts); break;
      case 8: break;
    }
  }
  return out;
}

// Scan inline content and render it straight to HTML.
function inlineHtml(src, ctx) {
  return renderParts(scanInline(src, ctx));
}

// ---------------------------------------------------------------------------
// Block parsing (chunk 3)
// ---------------------------------------------------------------------------

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading indent in columns (a tab advances to the next multiple of 4).
// Returns {n, end}: `end` is the index of the first non-space/tab char.
function countIndent(line) {
  let col = 0;
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return { n: col, end: k };
}

// Remove one indent level (4 columns) from a code line: a leading tab
// counts as the whole level, otherwise up to 4 leading spaces.
function dedentCode(line) {
  return stripColumns(line, 4);
}

function freshCtx(defs) {
  // Marked keeps `inLink` as document-wide state (it is only reset for
  // `inRawBlock`, never for `inLink`): an unclosed <a> suppresses every
  // later autolink in the document. Back it by the per-document defs map.
  return { defs, linkEmitted: false, inRawBlock: false,
    get inLink() { return !!defs._inLink; },
    set inLink(v) { defs._inLink = !!v; } };
}

// Fenced code start: ``` or ~~~ (3+), info string after it. A backtick
// fence's info must not contain a backtick.
function matchFence(line, ind) {
  if (ind.n > 3) return null;
  const c = line.charCodeAt(ind.end);
  if (c !== 96 && c !== 126) return null;
  let len = 0;
  while (ind.end + len < line.length && line.charCodeAt(ind.end + len) === c) len++;
  if (len < 3) return null;
  const info = line.slice(ind.end + len).trim();
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return { ch: c === 96 ? '`' : '~', len, info };
}

function matchAtx(line, ind) {
  if (ind.n > 3) return null;
  let k = ind.end;
  let depth = 0;
  while (k < line.length && line.charCodeAt(k) === 35) { depth++; k++; }
  if (depth === 0 || depth > 6) return null;
  if (k < line.length && line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9) return null;
  let text = line.slice(k).trim();
  const m = /#+$/.exec(text);
  if (m) {
    const before = text.slice(0, m.index);
    if (before === '' || before.charCodeAt(before.length - 1) === 32 || before.charCodeAt(before.length - 1) === 9) {
      text = before.trim();
    }
  }
  return { depth, text };
}

function isHr(line, ind) {
  if (ind.n > 3) return false;
  let k = ind.end;
  const c = line.charCodeAt(k);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let count = 0;
  while (k < line.length) {
    const d = line.charCodeAt(k);
    if (d === c) { count++; k++; }
    else if (d === 32 || d === 9) k++;
    else return false;
  }
  return count >= 3;
}

const _blockTags = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));
const _reHtml1 = /^<(pre|script|style|textarea)(\s|>|$)/i;
const _reHtml6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/;

// HTML block start type 1-7 (0 = not an HTML block start).
function htmlBlockType(line, ind) {
  if (ind.n > 3) return 0;
  const rest = line.slice(ind.end);
  if (rest.charCodeAt(0) !== 60) return 0;
  if (_reHtml1.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.length > 2 && rest[1] === '!' && ((rest.charCodeAt(2) >= 65 && rest.charCodeAt(2) <= 90) || (rest.charCodeAt(2) >= 97 && rest.charCodeAt(2) <= 122))) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = _reHtml6.exec(rest);
  if (m6 && _blockTags.has(m6[1].toLowerCase())) return 6;
  const tl = matchTag(line, ind.end);
  if (tl > 0) {
    let k = ind.end + tl;
    while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (k >= line.length) return 7;
  }
  return 0;
}

// A list marker at `ind`: bullet (-, +, *) or ordered (1-9 digits + . or )).
function matchListMarker(line, ind) {
  if (ind.n > 3) return null;
  const c = line.charCodeAt(ind.end);
  if (c === 45 || c === 43 || c === 42) {
    const nx = line[ind.end + 1];
    if (nx === ' ' || nx === '\t' || ind.end + 1 >= line.length) {
      return { ordered: false, bullet: line[ind.end], markerLen: 1, start: 0 };
    }
    return null;
  }
  if (c >= 48 && c <= 57) {
    let k = ind.end;
    let num = 0;
    let digits = 0;
    while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57 && digits < 9) {
      num = num * 10 + (line.charCodeAt(k) - 48);
      k++;
      digits++;
    }
    if (digits === 0) return null;
    if (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) return null;
    const d = line.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    const nx = line[k + 1];
    if (nx === ' ' || nx === '\t' || k + 1 >= line.length) {
      return { ordered: true, delim: d === 46 ? '.' : ')', markerLen: k + 1 - ind.end, start: num };
    }
    return null;
  }
  return null;
}

// Content indent after a list marker: the column where the item's
// content starts (-1 for an empty item). `at` is the source index of
// the first content character, `col` its column.
function listContentInfo(line, ind, marker) {
  let k = ind.end + marker.markerLen;
  let col = ind.n + marker.markerLen;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
    if (line.charCodeAt(k) === 32) col++;
    else col += 4 - (col % 4);
    k++;
  }
  if (k >= line.length) return { indent: -1, at: k, col };
  const ws = col - (ind.n + marker.markerLen);
  if (ws === 0) return { indent: -1, at: k, col };
  if (ws >= 5) return { indent: ind.n + marker.markerLen + 1, at: k, col };
  return { indent: col, at: k, col };
}

// Setext underline: 1 for `=`, 2 for `-`, 0 otherwise. The underline is
// a run of one repeated character, optionally indented up to 3 spaces,
// with only spaces/tabs after it.
function matchSetext(line, ind) {
  if (ind.n > 3) return 0;
  let k = ind.end;
  const c = line.charCodeAt(k);
  if (c !== 61 && c !== 45) return 0;
  let count = 0;
  while (k < line.length && line.charCodeAt(k) === c) { count++; k++; }
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k < line.length) return 0;
  return count >= 1 ? (c === 61 ? 1 : 2) : 0;
}

// GFM table delimiter row: array of aligns ('left'|'right'|'center'|null)
// or null when the line is not a delimiter row.
function matchTableDelimiter(line, ind) {
  if (ind.n > 3) return null;
  let s = line.slice(ind.end).trim();
  if (s.indexOf('|') < 0) return null;
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.charCodeAt(0) === 58 ? (t.charCodeAt(t.length - 1) === 58 ? 'center' : 'left') : (t.charCodeAt(t.length - 1) === 58 ? 'right' : null));
  }
  return aligns.length ? aligns : null;
}

// Does this line start a block (used for paragraph interruption and for
// lazy-continuation decisions)? `forPara` applies the paragraph rules:
// an ordered list interrupts only when it starts at 1, and an empty
// list item never interrupts.
function isBlockStart(line, ind, forPara, inList) {
  if (ind.n > 3) return false;
  const c = line.charCodeAt(ind.end);
  if (c === 35) return !!matchAtx(line, ind);
  if (c === 96 || c === 126) return !!matchFence(line, ind);
  if (c === 42 || c === 45 || c === 95) {
    if (isHr(line, ind)) return true;
    // otherwise fall through: - and * may be list markers
  }
  if (c === 60) {
    const t = htmlBlockType(line, ind);
    return t >= 1 && t <= 6;
  }
  if (c === 62) return true;
  if (c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57)) {
    const m = matchListMarker(line, ind);
    if (!m) return false;
    if (!forPara) return true;
    const ci = listContentInfo(line, ind, m);
    if (ci.indent < 0) return false; // empty item never interrupts
    // An ordered list interrupts a paragraph only when it starts at
    // 1 — except inside a list item, where any start number does.
    if (m.ordered && m.start !== 1 && !inList) return false;
    return true;
  }
  return false;
}

// Parse a link reference definition starting at `pos` in `text`
// (text[pos] === '['). Returns {end, label, href, title} or null.
function parseDef(text, pos) {
  const label = parseRefLabel(text, pos);
  if (!label) return null;
  let k = label.end;
  if (k >= text.length || text.charCodeAt(k) !== 58) return null;
  k++;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  if (k >= text.length) return null;
  let href;
  if (text.charCodeAt(k) === 60) { // <...> destination
    let m = k + 1;
    while (m < text.length) {
      const d = text.charCodeAt(m);
      if (d === 92) { m += 2; continue; }
      if (d === 10 || d === 60 || d === 62) break;
      m++;
    }
    if (m >= text.length || text.charCodeAt(m) !== 62) return null;
    href = text.slice(k + 1, m);
    k = m + 1;
  } else { // bare destination: non-space run, balanced parens
    let m = k;
    let depth = 0;
    while (m < text.length) {
      const d = text.charCodeAt(m);
      if (d === 32 || d === 9 || d === 10 || d < 32) break;
      if (d === 92 && m + 1 < text.length) { m += 2; continue; }
      if (d === 40) { depth++; m++; continue; }
      if (d === 41) { if (depth === 0) break; depth--; m++; continue; }
      m++;
    }
    if (m === k) return null;
    href = text.slice(k, m);
    k = m;
  }
  let w = k;
  while (w < text.length && (text[w] === ' ' || text[w] === '\t')) w++;
  let title = null;
  let titleEnd = w;
  if (w < text.length && text.charCodeAt(w) === 10) {
    let w2 = w + 1;
    while (w2 < text.length && (text[w2] === ' ' || text[w2] === '\t')) w2++;
    if (w2 < text.length && (text.charCodeAt(w2) === 34 || text.charCodeAt(w2) === 39 || text.charCodeAt(w2) === 40)) w = w2;
  }
  // A title must be separated from the destination by whitespace
  // (on the same line, w > k) or sit on the next line (w moved past
  // a newline, so w > k as well). A quote glued directly to the
  // destination (`<bar>(baz)`) is not a title at all.
  if (w > k && w < text.length && (text.charCodeAt(w) === 34 || text.charCodeAt(w) === 39 || text.charCodeAt(w) === 40)) {
    const q = text.charCodeAt(w);
    const closeQ = q === 40 ? 41 : q;
    let t = w + 1;
    let ok = false;
    while (t < text.length) {
      const d = text.charCodeAt(t);
      if (d === 92) { t += 2; continue; }
      if (d === closeQ) { ok = true; break; }
      t++;
    }
    if (ok) {
      title = text.slice(w + 1, t);
      titleEnd = t + 1;
    }
  }
  // What follows the title (or the destination, when there is no
  // title) must be only spaces/tabs and then a newline or the end.
  // If a title was parsed but junk follows it (`"title" ok`), the
  // definition is still valid without the title: fall back to the
  // destination alone and leave the title line as paragraph text.
  let e = title === null ? k : titleEnd;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  if (e < text.length && text.charCodeAt(e) !== 10) {
    if (title !== null) {
      title = null;
      e = k;
      while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e < text.length && text.charCodeAt(e) !== 10) return null;
    } else {
      return null;
    }
  }
  if (e < text.length) e++;
  return { end: e, label: label.text, href, title };
}

// Strip leading link reference definitions from paragraph `text`,
// registering them in `defs` (first definition wins). Returns the
// offset where the remaining text starts.
function stripDefs(text, defs) {
  let p = 0;
  const n = text.length;
  while (p < n) {
    let k = p;
    let col = 0;
    while (k < n && (text[k] === ' ' || text[k] === '\t')) {
      if (text[k] === ' ') col++;
      else col += 4 - (col % 4);
      k++;
      if (col > 3) break;
    }
    if (col > 3 || k >= n || text.charCodeAt(k) !== 91) break;
    const d = parseDef(text, k);
    if (!d) break;
    const key = normalizeLabel(d.label);
    if (!defs.has(key)) defs.set(key, { href: d.href, title: d.title });
    p = d.end;
  }
  return p;
}

// Do the collected lines end with an open paragraph? Used for lazy
// continuation: a line without a container prefix belongs to the
// container only while its last block is a paragraph.
function endsWithOpenParagraph(ls) {
  let state = 0; // 0 = start/other, 1 = paragraph
  let idx = 0;
  while (idx < ls.length) {
    const line = ls[idx];
    if (isBlank(line)) { state = 0; idx++; continue; }
    const ind = countIndent(line);
    if (state === 1) {
      if (matchSetext(line, ind)) { state = 0; idx++; continue; }
      if (matchTableDelimiter(line, ind)) { state = 0; idx++; continue; }
      if (isBlockStart(line, ind, true)) {
        const m = matchListMarker(line, ind);
        // A fence after a paragraph ends the paragraph: skip the
        // whole fenced block (its content lines are not paragraph
        // text, so a later lazy line must not be accepted).
        const fence = matchFence(line, ind);
        if (fence) {
          idx++;
          while (idx < ls.length) {
            const l2 = ls[idx];
            const ind2 = countIndent(l2);
            if (ind2.n <= 3) {
              const c = fence.ch.charCodeAt(0);
              let k = ind2.end;
              let run = 0;
              while (k < l2.length && l2.charCodeAt(k) === c) { run++; k++; }
              if (run >= fence.len) {
                let k2 = k;
                while (k2 < l2.length && (l2.charCodeAt(k2) === 32 || l2.charCodeAt(k2) === 9)) k2++;
                if (k2 >= l2.length) { idx++; break; }
              }
            }
            idx++;
          }
          state = 0;
          continue;
        }
        state = (m && listContentInfo(line, ind, m).indent >= 0) ? 1 : 0;
        idx++;
        continue;
      }
      idx++;
      continue;
    }
    // state === 0 here.
    // Blockquote: recurse into its inner content — a blockquote
    // whose inner content ends with an open paragraph can still
    // take a lazy continuation line (e.g. `> 1. > Blockquote`
    // followed by `continued here.`).
    if (ind.n <= 3 && line.charCodeAt(ind.end) === 62) {
      const q = collectBlockquote(ls, idx, ls.length, false);
      state = endsWithOpenParagraph(q.lines) ? 1 : 0;
      idx = q.next;
      continue;
    }
    const fence = matchFence(line, ind);
    if (fence) {
      idx++;
      while (idx < ls.length) {
        const l2 = ls[idx];
        const ind2 = countIndent(l2);
        if (ind2.n <= 3) {
          const c = fence.ch.charCodeAt(0);
          let k = ind2.end;
          let run = 0;
          while (k < l2.length && l2.charCodeAt(k) === c) { run++; k++; }
          if (run >= fence.len) {
            let k2 = k;
            while (k2 < l2.length && (l2.charCodeAt(k2) === 32 || l2.charCodeAt(k2) === 9)) k2++;
            if (k2 >= l2.length) { idx++; break; }
          }
        }
        idx++;
      }
      state = 0;
      continue;
    }
    if (isBlockStart(line, ind, false)) {
      const m = matchListMarker(line, ind);
      state = (m && listContentInfo(line, ind, m).indent >= 0) ? 1 : 0;
      idx++;
      continue;
    }
    if (ind.n >= 4) { state = 0; idx++; continue; }
    state = 1;
    idx++;
  }
  return state === 1;
}

// Remove up to `n` leading whitespace CHARACTERS from a fenced code
// content line (marked's indentCodeCompensation: it slices
// min(leadingWs.length, fenceIndent.length) characters, so a tab counts
// as one character, not as a column advance). Only backtick fences get
// this compensation; tilde fences get none.
function stripFenceIndent(line, n) {
  let k = 0;
  while (k < line.length && k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return line.slice(k);
}

// Remove `n` columns of leading whitespace (a tab that straddles the
// boundary leaves the excess as spaces).
function stripColumns(line, n) {
  let col = 0;
  let k = 0;
  while (k < line.length && col < n) {
    const c = line.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      if (col + adv > n) return ' '.repeat(col + adv - n) + line.slice(k + 1);
      col += adv; k++;
    } else break;
  }
  return line.slice(k);
}

// Join lines[i..j) back into source text. The trailing newline is kept
// when line j-1 is followed by another line, or when the source ends
// with a newline (`lastNl`).
function blockText(lines, i, j, end, lastNl) {
  let text = lines.slice(i, j).join('\n');
  // A single trailing newline is kept when the next line is non-blank
  // (or blank-with-spaces, whose spaces stop the match's \n* run), or
  // at EOF when the source ends with a newline. An empty next line
  // means the match swallowed 2+ newlines, which ge strips.
  if ((j < end && lines[j] !== '') || (j === end && lastNl)) text += '\n';
  return text;
}

// Collect an HTML block of `type` starting at line `i`.
function collectHtmlBlock(lines, i, end, type, lastNl) {
  if (type === 6 || type === 7) {
    // Types 6 and 7 both consume lines until a blank line or EOF
    // (marked 18.1.3 GFM regex). A whitespace-only line at EOF with
    // no final newline belongs to the block (the regex's $ ending).
    let j = i + 1;
    while (j < end && !isBlank(lines[j])) j++;
    if (j < end && j === end - 1 && !lastNl && isBlank(lines[j])) j++;
    let text = lines.slice(i, j).join('\n');
    if (j === end && lastNl) text += '\n';
    return { text, next: j };
  }
  let marker;
  if (type === 1) {
    const rest = lines[i].slice(countIndent(lines[i]).end);
    const m = /^<(pre|script|style|textarea)/i.exec(rest);
    marker = '</' + m[1].toLowerCase();
  } else if (type === 2) marker = '-->';
  else if (type === 3) marker = '?>';
  else if (type === 4) marker = '>';
  else marker = ']]>';
  const low = marker.toLowerCase();
  let j = i;
  while (j < end) {
    if (lines[j].toLowerCase().indexOf(low) >= 0) { j++; break; }
    j++;
  }
  return { text: trimTrailingBlankLines(blockText(lines, i, j, end, lastNl)), next: j };
}

// Collect a blockquote starting at line `i` (lines with the `>` prefix
// stripped, plus lazy continuation lines and blank lines between
// quoted lines). Returns the inner lines, the next outer line, and
// whether the inner lines' last line is followed by a newline.
// The content of a blockquote line after its `>` marker. `ind` is
// countIndent(line); line[ind.end] is '>'. The whitespace after '>'
// is expanded to spaces counted from the column after '>' (a tab
// advances to the next multiple of 4), and one space of separator is
// removed — marked's blockquoteMarkerWhitespace + SetextReplace2.
// (Skipping a single raw character is wrong for tabs: `>\t\tfoo`
// leaves six spaces, i.e. an indented code block holding `  foo`.)
function stripBlockquoteMarker(line, ind) {
  let k = ind.end + 1;
  let col = ind.n + 1;
  let spaces = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32) { spaces++; col++; k++; }
    else if (c === 9) { const r = 4 - (col % 4); spaces += r; col += r; k++; }
    else break;
  }
  const keep = Math.max(0, spaces - 1);
  return ' '.repeat(keep) + line.slice(k);
}

function collectBlockquote(lines, i, end, lastNl) {
  const qlines = [];
  const lazy = new Set();
  let j = i;
  let lastContentOrig = -1;
  while (j < end) {
    const line = lines[j];
    const ind = countIndent(line);
    if (ind.n <= 3 && line.charCodeAt(ind.end) === 62) { // >
      qlines.push(stripBlockquoteMarker(line, ind));
      lastContentOrig = j;
      j++;
      continue;
    }
    if (isBlank(line)) {
      // A truly blank line (no `>` marker) ends the blockquote. A
      // blank line WITH a `>` marker is handled by the first branch
      // above, which pushes '' and continues.
      break;
    }
    if (qlines.length > 0 && endsWithOpenParagraph(qlines)) {
      const indL = countIndent(line);
      const lm = matchListMarker(line, indL);
      // A list marker (even an empty one, `-`) is never a lazy
      // continuation: it ends the blockquote and starts a list.
      if (!lm) {
        const isSetext = matchSetext(line, indL);
        // A `-` underline of 3+ dashes is also a thematic break: it
        // ends the blockquote (an <hr>), it is not paragraph text.
        if (isSetext && !isHr(line, indL)) {
          // A setext underline as a lazy line stays paragraph text
          // (marked's blockquoteSetextReplace). It is indented by 4
          // spaces only when it follows another lazy line (same
          // group); after a `>` line it is kept as-is. Either way it
          // is marked lazy so it is not read as a heading underline.
          const prevLazy = lazy.has(qlines.length - 1);
          lazy.add(qlines.length);
          // Indented (after another lazy line): 4 spaces + underline,
          // leading spaces dropped. Not indented (after a `>` line):
          // the line is kept as-is, leading spaces included.
          qlines.push(prevLazy ? '    ' + line.slice(indL.end) : line);
          lastContentOrig = j;
          j++;
          continue;
        }
        const lazyOk = !matchTableDelimiter(line, indL)
          && !isBlockStart(line, indL, true)
          && !isDefLine(line, indL);
        if (lazyOk) {
          // Lazy line: strip 4 columns iff its indent is >= 4 columns,
          // else keep as-is (verified by oracle: 1-3 spaces kept, 4+
          // stripped by exactly 4, tabs counted in columns).
          const pushed = indL.n >= 4 ? stripColumns(line, 4) : line;
          lazy.add(qlines.length);
          qlines.push(pushed);
          lastContentOrig = j;
          j++;
          continue;
        }
      }
    }
    break;
  }
  const innerLastNl = qlines.length > 0 && qlines[qlines.length - 1] === '';
  return { lines: qlines, next: j, lastNl: innerLastNl, lazy };
}

// Render a fenced code block: `info` is the fence info string,
// `content` the raw content lines.
function renderFenced(info, content) {
  const lang = info ? unescapePunct(info).split(/\s+/)[0] : '';
  // The text is the content lines joined with '\n' (no extra trailing
  // newline added); the renderer then normalises the ending to one
  // '\n' via replace(/\n$/, '') + '\n'. Adding a '\n' here would
  // give one newline too many when the content ends with blank lines.
  const text = content.join('\n');
  const r = text ? text.replace(/\n$/, '') + '\n' : '';
  if (lang) return '<pre><code class="language-' + escP(lang) + '">' + escEncode(r) + '</code></pre>\n';
  return '<pre><code>' + escEncode(r) + '</code></pre>\n';
}

// Render an indented code block from dedented content lines.
function renderIndented(content) {
  let text = content.join('\n');
  if (content.length) text += '\n';
  text = trimTrailingBlankLines(text);
  const r = text ? text.replace(/\n$/, '') + '\n' : '';
  return '<pre><code>' + escEncode(r) + '</code></pre>\n';
}

// Do lines[i..j) (after leading link reference definitions) start
// with a GFM table header + delimiter row with matching cell counts?
function isTableRegion(lines, i, j) {
  const text = lines.slice(i, j).join('\n');
  const tmp = new Map();
  const rest = text.slice(stripDefs(text, tmp));
  const restLines = rest.split('\n');
  if (restLines.length < 2) return false;
  const aligns = matchTableDelimiter(restLines[1], countIndent(restLines[1]));
  if (!aligns) return false;
  const headerCells = splitCells(restLines[0]);
  return headerCells.length === aligns.length;
}

// Collect the lines of a paragraph starting at line `i`: consecutive
// non-blank lines that do not start an interrupting block. A setext
// underline line is collected and ends the paragraph.
function collectParagraphLines(lines, i, end, lazy, lastNl, inList) {
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // A trailing whitespace-only line (non-empty) that is the last
      // line and is not followed by a newline in the text being
      // parsed is absorbed into the paragraph (e.g. `> foo\n>  `
      // leaves a ` ` line inside the blockquote, giving `foo\n `).
      // An empty last line, or one followed by a newline, is a
      // separator and ends the paragraph.
      if (line !== '' && j === end - 1 && lastNl === false) { j++; continue; }
      // Inside a table body, a whitespace-only line that is not
      // spaces-only (e.g. a lone tab) is a body row, not a
      // separator: marked's table body regex excludes only ` *\n`
      // lines. A spaces-only or empty line still ends the table.
      if (line !== '' && !/^[ ]+$/.test(line) && isTableRegion(lines, i, j)) { j++; continue; }
      break;
    }
    // A lazy continuation line (from a blockquote) is already known
    // to be part of this paragraph; it must not interrupt it even
    // when, after its 4-column dedent, it looks like a block start
    // (e.g. `- bar`).
    if (lazy && lazy.has(j)) { j++; continue; }
    const ind = countIndent(line);
    if (matchSetext(line, ind)) {
      // A setext underline does not end the paragraph when the lines
      // so far are all link reference definitions: after stripping
      // the defs there is no paragraph text for it to underline, so
      // it is ordinary paragraph text (e.g. `[foo]: /url\n===\n[foo]`
      // is one paragraph `===\n[foo]`, not a heading).
      const head = lines.slice(i, j).join('\n');
      const tmp = new Map();
      const stripped = stripDefs(head, tmp);
      if (head.slice(stripped).trim() === '') { j++; continue; }
      j++; break;
    }
    if (isBlockStart(line, ind, true, inList)) break;
    j++;
  }
  return j;
}

// Render the paragraph region lines[i..j): strip link reference
// definitions, then try a table, a setext heading, or a plain
// paragraph. Returns {html, next}: `next` is the first line not
// consumed (a table may leave trailing lines for a new block).
function renderParagraphRegion(lines, i, j, defs, opts) {
  const firstInd = countIndent(lines[i]);
  let text = lines[i];
  for (let k = i + 1; k < j; k++) text += '\n' + lines[k];
  const defEnd = stripDefs(text, defs);
  const rest = text.slice(defEnd);
  if (rest.trim() === '') return { html: '', next: j };
  const restLines = rest.split('\n');
  if (restLines.length >= 2) {
    const aligns = matchTableDelimiter(restLines[1], countIndent(restLines[1]));
    // The header must have exactly as many cells as the delimiter
    // row; otherwise this is not a table at all.
    const headerCells = aligns ? splitCells(restLines[0]) : null;
    if (aligns && headerCells && headerCells.length === aligns.length) {
      const body = [];
      let used = 2;
      // Every following line is a body row, even a whitespace-only
      // one with a tab (marked's table body excludes only
      // spaces-only lines); the region already ends at a
      // spaces-only/empty line or a block start.
      while (used < restLines.length && !/^[ ]*$/.test(restLines[used])) { body.push(restLines[used]); used++; }
      let html = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < headerCells.length; c++) {
        html += aligns[c] ? '<th align="' + aligns[c] + '">' : '<th>';
        html += inlineHtml(headerCells[c], freshCtx(defs)) + '</th>\n';
      }
      html += '</tr>\n</thead>\n';
      if (body.length) {
        html += '<tbody>';
        for (const row of body) {
          const cells = splitCells(row, aligns.length);
          html += '<tr>\n';
          for (let c = 0; c < cells.length; c++) {
            html += aligns[c] ? '<td align="' + aligns[c] + '">' : '<td>';
            html += inlineHtml(cells[c], freshCtx(defs)) + '</td>\n';
          }
          html += '</tr>\n';
        }
        html += '</tbody>';
      }
      html += '</table>\n';
      const restStartLine = text.slice(0, defEnd).split('\n').length - 1;
      return { html, next: i + restStartLine + used };
    }
  }
  if (restLines.length >= 2) {
    const lastInd = countIndent(restLines[restLines.length - 1]);
    const st = matchSetext(restLines[restLines.length - 1], lastInd);
    // A lazy continuation line (e.g. a setext underline absorbed
    // from a blockquote) is paragraph text, not a heading underline.
    if (st && !(opts.lazy && opts.lazy.has(j - 1))) {
      const headText = restLines.slice(0, -1).join('\n').trim();
      return { html: '<h' + st + '>' + inlineHtml(headText, freshCtx(defs)) + '</h' + st + '>\n', next: j };
    }
  }
  if (opts.checkbox && opts.firstBlock) {
    const m = /^\[( |x|X)\][ \t]/.exec(rest);
    if (m) {
      const cb = '<input ' + (m[1] !== ' ' ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      const inner = inlineHtml(rest.slice(m[0].length), freshCtx(defs));
      opts.checkbox = false;
      opts.firstBlock = false;
      return { html: opts.tight ? cb + inner : '<p>' + cb + inner + '</p>\n', next: j };
    }
  }
  return { html: opts.tight ? inlineHtml(rest, freshCtx(defs)) : '<p>' + inlineHtml(rest, freshCtx(defs)) + '</p>\n', next: j };
}

// Collect the items of a list starting at line `i`. Returns
// {items, next, looseBetween}: `items` are {lines, lastNl},
// `next` is the first line after the list, and `looseBetween` is
// true when a blank line separates two items.
// Does `line` (whose indent is `ind`) start a link reference
// definition? Used to keep a def line from being swallowed as a
// lazy continuation of a list item's paragraph: a def ends the
// list item so it can be parsed as a top-level definition.
function isDefLine(line, ind) {
  if (ind.n > 3) return false;
  return parseDef(line, ind.end) !== null;
}

// Is `stripped` (a line already stripped of the list item's content
// indent) the closing fence for a fence of `fenceCh`/`fenceLen`?
function isFenceClose(stripped, fenceCh, fenceLen) {
  const ind = countIndent(stripped);
  if (ind.n > 3) return false;
  const c = fenceCh.charCodeAt(0);
  let k = ind.end;
  let run = 0;
  while (k < stripped.length && stripped.charCodeAt(k) === c) { run++; k++; }
  if (run < fenceLen) return false;
  while (k < stripped.length && (stripped.charCodeAt(k) === 32 || stripped.charCodeAt(k) === 9)) k++;
  return k >= stripped.length;
}

function collectListItems(lines, i, end, firstInd, firstMarker, lastNl) {
  const ordered = firstMarker.ordered;
  const items = [];
  let looseBetween = false;
  let j = i;
  const sameMarker = (line, ind) => {
    const m = matchListMarker(line, ind);
    if (!m || m.ordered !== ordered) return false;
    if (ordered ? m.delim !== firstMarker.delim : m.bullet !== firstMarker.bullet) return false;
    return ind.n <= firstInd.n + 3;
  };
  while (j < end) {
    const line = lines[j];
    const ind = countIndent(line);
    // A thematic break ends the list: `* * *` is an <hr>, not a new
    // list item, even though it starts with a bullet marker.
    if (isHr(line, ind)) break;
    if (!sameMarker(line, ind)) break;
    const m = matchListMarker(line, ind);
    const ci = listContentInfo(line, ind, m);
    const contentIndent = ci.indent < 0 ? ind.n + m.markerLen + 1 : ci.indent;
    const itemLines = [];
    const itemLazy = new Set();
    let lastContentOrig = -1;
    // A fenced code block inside an item swallows its content lines
    // regardless of their indent — but only once the fence has real
    // content and the previous line was not blank. A below-indent
    // line as the fence's first content, or right after a blank
    // line, ends the item instead (the fence stays empty / ends
    // there): marked's list loop treats those as non-lazy.
    let inFence = null;
    let fenceContent = false;
    let fenceAfterBlank = false;
    if (ci.indent >= 0) {
      const first = ' '.repeat(Math.max(0, ci.col - contentIndent)) + line.slice(ci.at);
      itemLines.push(first);
      const f0 = matchFence(first, countIndent(first));
      if (f0) inFence = { ch: f0.ch, len: f0.len };
      lastContentOrig = j;
    }
    j++;
    while (j < end) {
      const l2 = lines[j];
      // Inside a fenced code block: content lines at/above the item
      // indent are always fence content; a line below the item
      // indent is fence content only as a lazy continuation (fence
      // already has content and the previous line was not blank).
      // Otherwise the line ends the item and the fence with it.
      if (inFence) {
        if (isBlank(l2)) {
          itemLines.push('');
          fenceAfterBlank = true;
          lastContentOrig = j;
          j++;
          continue;
        }
        const stripped = stripColumns(expandLeadingTabs(l2), contentIndent);
        if (isFenceClose(stripped, inFence.ch, inFence.len)) {
          itemLines.push(stripped);
          lastContentOrig = j;
          j++;
          inFence = null;
          continue;
        }
        const indF = countIndent(l2);
        if (indF.n < contentIndent && (!fenceContent || fenceAfterBlank)) break;
        itemLines.push(stripped);
        fenceContent = true;
        fenceAfterBlank = false;
        lastContentOrig = j;
        j++;
        continue;
      }
      if (isBlank(l2)) {
        let k = j + 1;
        while (k < end && isBlank(lines[k])) k++;
        if (k >= end) { j = k; break; }
        const ind2 = countIndent(lines[k]);
        // A marker after a blank line starts a new item only when it is
        // not indented enough to belong to this item's content.
        if (sameMarker(lines[k], ind2) && ind2.n < contentIndent) { looseBetween = true; j = k; break; }
        // An empty item ends at a blank line: following indented lines
        // are a new block, not this item's content.
        if (itemLines.length === 0) break;
        // Only keep the blank lines when the following line actually
        // belongs to this item, i.e. it is indented to the content
        // indent. A line after a blank line is never a lazy
        // continuation (the blank closes the paragraph), so a
        // non-indented following line means the blank is a separator
        // between this item's blocks and the next top-level block:
        // the item ends here without it (this is what makes a list
        // loose when a blank separates a nested list from a paragraph).
        const nkInd = countIndent(lines[k]);
        if (nkInd.n < contentIndent) break;
        while (j < k) { itemLines.push(''); j++; }
        continue;
      }
      const ind2 = countIndent(l2);
      if (ind2.n >= contentIndent) {
        const stripped = stripColumns(expandLeadingTabs(l2), contentIndent);
        itemLines.push(stripped);
        const f = matchFence(stripped, countIndent(stripped));
        if (f) { inFence = { ch: f.ch, len: f.len }; fenceContent = false; fenceAfterBlank = false; }
        lastContentOrig = j;
        j++;
        continue;
      }
      if (sameMarker(l2, ind2)) break;
      if (itemLines.length > 0 && endsWithOpenParagraph(itemLines)) {
        const indL = countIndent(l2);
        // A lazy continuation line cannot start a new block, and a
        // list marker with content is never lazy (even an ordered
        // marker that cannot interrupt a paragraph, e.g. `3)`).
        // A link reference definition line is never lazy either: it
        // ends the list item so it can be parsed as a definition.
        const lm = matchListMarker(l2, indL);
        const lmContent = lm ? listContentInfo(l2, indL, lm).indent >= 0 : false;
        if (!lmContent && !isBlockStart(l2, indL, true) && !matchSetext(l2, indL) && !matchTableDelimiter(l2, indL) && !isDefLine(l2, indL)) {
          itemLazy.add(itemLines.length);
          // A lazy continuation line keeps its leading spaces, except
          // that a line indented 4+ loses 4 (marked's indented-code
          // compensation on the paragraph text): e.g. `+ A\n lazy`
          // keeps the space, `  1.  A\n    with` (cm-291) loses all
          // four, and `  1.  A\n     with` keeps one.
          itemLines.push(indL.n >= 4 ? stripColumns(l2, 4) : l2);
          lastContentOrig = j;
          j++;
          continue;
        }
      }
      break;
    }
    const itemLastNl = itemLines.length > 0 && itemLines[itemLines.length - 1] === '';
    items.push({ lines: itemLines, lastNl: itemLastNl, lazy: itemLazy });
  }
  return { items, next: j, looseBetween };
}

// Does `lines` contain a blank line between two top-level blocks?
// Blank lines inside a nested block (sublist, blockquote, fence)
// do not count: they are consumed as part of that block's extent.
function hasBlankBetweenTopBlocks(lines) {
  let i = 0;
  let seenBlock = false;
  let seenBlank = false;
  const end = lines.length;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { seenBlank = true; i++; continue; }
    const ind = countIndent(line);
    let next;
    const fence = matchFence(line, ind);
    if (fence) {
      let j = i + 1;
      while (j < end) {
        const l2 = lines[j];
        const ind2 = countIndent(l2);
        if (ind2.n <= 3) {
          const c = fence.ch.charCodeAt(0);
          let k = ind2.end;
          let run = 0;
          while (k < l2.length && l2.charCodeAt(k) === c) { run++; k++; }
          if (run >= fence.len) {
            let k2 = k;
            while (k2 < l2.length && (l2.charCodeAt(k2) === 32 || l2.charCodeAt(k2) === 9)) k2++;
            if (k2 >= l2.length) break;
          }
        }
        j++;
      }
      next = j < end ? j + 1 : j;
    } else if (matchAtx(line, ind) || isHr(line, ind)) {
      next = i + 1;
    } else if (htmlBlockType(line, ind)) {
      next = collectHtmlBlock(lines, i, end, htmlBlockType(line, ind), false).next;
    } else if (ind.n <= 3 && line.charCodeAt(ind.end) === 62) {
      next = collectBlockquote(lines, i, end, false).next;
    } else if (matchListMarker(line, ind)) {
      const fm = matchListMarker(line, ind);
      next = collectListItems(lines, i, end, ind, fm, false).next;
    } else {
      // These lines are a list item's content, parsed with inList:
      // an ordered list with any start number interrupts the
      // paragraph here, so the blank line inside that nested list
      // must not count as a blank between this item's top blocks.
      next = collectParagraphLines(lines, i, end, undefined, undefined, true);
    }
    if (seenBlock && seenBlank) return true;
    seenBlock = true;
    seenBlank = false;
    i = next;
  }
  return false;
}

// Parse a list starting at line `i`. Returns {html, next}.
function parseList(lines, i, end, defs, lastNl, collectOnly) {
  const firstInd = countIndent(lines[i]);
  const firstMarker = matchListMarker(lines[i], firstInd);
  const ordered = firstMarker.ordered;
  const start = firstMarker.start;
  const { items, next: listNext, looseBetween } = collectListItems(lines, i, end, firstInd, firstMarker, lastNl);
  let loose = looseBetween;
  if (!loose) {
    for (const it of items) {
      if (hasBlankBetweenTopBlocks(it.lines)) { loose = true; break; }
    }
  }
  const tight = !loose;
  let html = ordered ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>\n' : '<ul>\n';
  for (const it of items) {
    const itemOpts = { tight, checkbox: true, firstBlock: true, lazy: it.lazy, inList: true, collectOnly };
    const inner = parseBlocks(it.lines, 0, it.lines.length, defs, itemOpts, it.lastNl);
    if (!collectOnly) html += '<li>' + inner + '</li>\n';
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  return { html, next: listNext };
}

// Parse blocks in lines[start..end) to HTML. `defs` collects link
// reference definitions. `opts` carries the tight-list flag, the
// task-list checkbox allowance (first paragraph only) and whether the
// next block is the first one. `lastNl` says whether the last line in
// the range is followed by a newline in the source.
function parseBlocks(lines, start, end, defs, opts, lastNl) {
  opts = opts || { tight: false, checkbox: false, firstBlock: true };
  let out = '';
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const ind = countIndent(line);
    const fence = matchFence(line, ind);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < end) {
        const l2 = lines[j];
        const ind2 = countIndent(l2);
        if (ind2.n <= 3) {
          const c = fence.ch.charCodeAt(0);
          let k = ind2.end;
          let run = 0;
          while (k < l2.length && l2.charCodeAt(k) === c) { run++; k++; }
          if (run >= fence.len) {
            let k2 = k;
            while (k2 < l2.length && (l2.charCodeAt(k2) === 32 || l2.charCodeAt(k2) === 9)) k2++;
            if (k2 >= l2.length) break;
          }
        }
        content.push(fence.ch === '`' && ind.end > 0 ? stripFenceIndent(l2, ind.end) : l2);
        j++;
      }
      if (!opts.collectOnly) out += renderFenced(fence.info, content);
      i = j < end ? j + 1 : j;
      opts.firstBlock = false;
      continue;
    }
    const atx = matchAtx(line, ind);
    if (atx) {
      if (!opts.collectOnly) out += '<h' + atx.depth + '>' + inlineHtml(atx.text, freshCtx(defs)) + '</h' + atx.depth + '>\n';
      i++;
      opts.firstBlock = false;
      continue;
    }
    if (isHr(line, ind)) { if (!opts.collectOnly) out += '<hr>\n'; i++; opts.firstBlock = false; continue; }
    const ht = htmlBlockType(line, ind);
    if (ht) {
      const r = collectHtmlBlock(lines, i, end, ht, lastNl);
      if (!opts.collectOnly) out += r.text;
      i = r.next;
      opts.firstBlock = false;
      continue;
    }
    if (ind.n <= 3 && line.charCodeAt(ind.end) === 62) { // blockquote
      const q = collectBlockquote(lines, i, end, lastNl);
      const inner = parseBlocks(q.lines, 0, q.lines.length, defs, { tight: false, checkbox: false, firstBlock: true, lazy: q.lazy, collectOnly: opts.collectOnly }, q.lastNl);
      if (!opts.collectOnly) out += '<blockquote>\n' + inner + '</blockquote>\n';
      i = q.next;
      opts.firstBlock = false;
      continue;
    }
    const marker = matchListMarker(line, ind);
    if (marker) {
      const r = parseList(lines, i, end, defs, lastNl, opts.collectOnly);
      if (!opts.collectOnly) out += r.html;
      i = r.next;
      opts.firstBlock = false;
      continue;
    }
    if (ind.n >= 4) { // indented code
      const content = [];
      let j = i;
      while (j < end) {
        const l2 = lines[j];
        if (isBlank(l2)) {
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && countIndent(lines[k]).n >= 4) {
            while (j < k) { content.push(stripColumns(lines[j], 4)); j++; }
            continue;
          }
          break;
        }
        if (countIndent(l2).n < 4) break;
        content.push(dedentCode(l2));
        j++;
      }
      if (!opts.collectOnly) out += renderIndented(content);
      i = j;
      opts.firstBlock = false;
      continue;
    }
    const j = collectParagraphLines(lines, i, end, opts.lazy, lastNl, opts.inList);
    if (opts.collectOnly) {
      // Def-collection pass: register leading link reference
      // definitions without any inline parsing or rendering.
      let text = lines[i];
      for (let k = i + 1; k < j; k++) text += '\n' + lines[k];
      stripDefs(text, defs);
      i = j;
      continue;
    }
    const r = renderParagraphRegion(lines, i, j, defs, opts);
    out += r.html;
    if (r.html !== '') opts.firstBlock = false;
    i = r.next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point (chunk 4)
// ---------------------------------------------------------------------------

function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lastNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (lastNl) lines.pop(); // the trailing '' is the terminator, not a line
  const defs = new Map();
  // First pass: walk every block to register all link reference
  // definitions, without rendering anything (collectOnly). Marked
  // makes defs visible document-wide, even to links that appear
  // before the definition, so a single pass that renders as it goes
  // would miss them.
  parseBlocks(lines, 0, lines.length, defs, { tight: false, checkbox: false, firstBlock: true, collectOnly: true }, lastNl);
  return parseBlocks(lines, 0, lines.length, defs, { tight: false, checkbox: false, firstBlock: true }, lastNl);
}

export { parse };
