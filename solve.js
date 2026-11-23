// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from the spec (README.md) and the reference behaviour; single-pass
// Markdown, index-scanned front matter, precompiled templates, bulk HTML
// escaping. No cross-case state: every cache lives in the per-run context.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const WS_RE = /\s/;
const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const RESERVED = ['posts', 'tags', 'page'];
// backslash-escapable char codes: \ ` * _ [ ] ( ) # + - . ! >
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isDigit = (c) => c >= 48 && c <= 57; // char code
const isAlphaNum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isLowerAlnum = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122); // a-z0-9
const isLangChar = (c) => isAlphaNum(c) || c === 95 || c === 43 || c === 45; // A-Za-z0-9_+-
const isKeyChar = (c) => (c >= 97 && c <= 122) || c === 95; // a-z_
// JS \s: \t\n\v\f\r space + U+00A0 U+1680 U+2000-200A U+2028 U+2029 U+202F U+205F U+3000 U+FEFF
function isWSCode(c) {
  if (c <= 32) return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function isWSChar(ch) { return ch !== undefined && isWSCode(ch.charCodeAt(0)); }

/** Escaped `s` as one string. */
const escRep = (c) => ESC[c];
function escStr(s) { return s.replace(ESC_RE, escRep); }
/** Escaped slice s[a..b) pushed into `out`. */
function escRange(s, a, b, out) {
  if (a < b) out.push(s.slice(a, b).replace(ESC_RE, escRep));
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Slug of `text`, cached per run in ctx.slugCache. */
function slugify(text, ctx) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  ctx.slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date, ctx) {
  const hit = ctx.dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  ctx.dateCache.set(date, out);
  return out;
}

/** Word count: runs of non-whitespace (JS \s set, incl. non-ASCII whitespace). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 33) ws = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
    else if (c < 160) ws = false;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const parts = [];
    let run = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        if (run < i) parts.push(raw.slice(run, i));
        parts.push(n);
        i++;
        run = i + 1;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
    }
    if (run < raw.length - 1) parts.push(raw.slice(run, raw.length - 1));
    return { value: parts.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let start = 0;
      for (let i = 0; i <= inner.length; i++) {
        if (i === inner.length || inner[i] === ',') {
          const t = inner.slice(start, i).trim();
          if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          for (let j = 0; j < t.length; j++) {
            const c = t[j];
            if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
          tags.push(t);
          start = i + 1;
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      if (ok) for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (!isLowerAlnum(c) && c !== 45) { ok = false; break; } }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64 && isLowerAlnum(raw.charCodeAt(0));
      if (ok) {
        let prevDash = false;
        for (let i = 1; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) { if (prevDash) { ok = false; break; } prevDash = true; }
          else if (isLowerAlnum(c)) prevDash = false;
          else { ok = false; break; }
        }
        if (ok && raw.charCodeAt(raw.length - 1) === 45) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** { data, body } or { error }; `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let close = -1;
  let closeEnd = -1;
  let p = nl0 === -1 ? text.length : nl0;
  while (true) {
    const i = text.indexOf('\n---', p);
    if (i === -1) break;
    const after = i + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { close = i + 1; closeEnd = after; break; }
    p = i + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let ls = nl0 === -1 ? text.length : nl0 + 1;
  while (ls < close) {
    let le = text.indexOf('\n', ls);
    if (le === -1 || le > close) le = close;
    lineNo++;
    // blank (spaces/tabs only) or comment (# first)
    let j = ls;
    let blank = true;
    while (j < le) { const c = text.charCodeAt(j); if (c !== 32 && c !== 9) { blank = false; break; } j++; }
    if (!blank && text.charCodeAt(ls) !== 35) {
      // key: [a-z_]+ ':' (' ' rest)? — else `line ${lineNo} is not "key: value"`
      let k = ls;
      while (k < le && isKeyChar(text.charCodeAt(k))) k++;
      if (k === ls || k >= le || text.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = text.slice(ls, k);
      k++;
      let raw;
      if (k >= le) raw = '';
      else if (text.charCodeAt(k) !== 32) return { error: `line ${lineNo} is not "key: value"` };
      else {
        raw = text.slice(k + 1, le);
        let e = raw.length;
        while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
        if (e < raw.length) raw = raw.slice(0, e);
      }
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    ls = le + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!isAlphaNum(c) && c !== 43 && c !== 45 && c !== 46) return false;
  }
  return false;
}

function linkTarget(ctx, target) {
  if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(ctx.curDir, rel);
  if (path !== null && ctx.bySource.has(path)) return ctx.bySource.get(path).url + frag;
  if (path !== null && ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  ctx.broken.add(`broken-link ${ctx.curPath} -> ${target}`);
  return target;
}

/** First index >= `from` where `s` holds `what` outside a backslash escape, or -1; bounded by `end`. */
function findUnescaped(s, what, from, end) {
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1; bounded by `end`. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Inline rendering of s[a..b) into `out`. */
function inlineInto(s, a, b, out, ctx) {
  let run = a;
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < b && isEscapableCode(s.charCodeAt(i + 1))) {
      if (run < i) escRange(s, run, i, out);
      out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
      i += 2; run = i; continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (run < i) escRange(s, run, i, out);
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1; run = i; continue;
      }
      i++; continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (run < i) escRange(s, run, i, out);
          out.push('<strong>');
          inlineInto(s, i + 2, j, out, ctx);
          out.push('</strong>');
          i = j + 2; run = i; continue;
        }
        i += 2; continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        if (run < i) escRange(s, run, i, out);
        out.push('<em>');
        inlineInto(s, i + 1, j, out, ctx);
        out.push('</em>');
        i = j + 1; run = i; continue;
      }
      i++; continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < b) m = mm;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          if (run < i) escRange(s, run, i, out);
          out.push('<a href="');
          out.push(escStr(linkTarget(ctx, target)));
          out.push('">');
          inlineInto(s, i + 1, k, out, ctx);
          out.push('</a>');
          i = m + 1; run = i; continue;
        }
      }
      i++; continue;
    }
    i++;
  }
  if (run < b) escRange(s, run, b, out);
}

/** Inline rendering of s[a..b) as a string. */
function inlineStr(s, a, b, ctx) {
  const out = [];
  inlineInto(s, a, b, out, ctx);
  return out.join('');
}

// line helpers over s[ls..le): all operate on indices, no slicing
function lineIsBlank(s, ls, le) {
  for (let i = ls; i < le; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
/** Fence-open language, or null; '' when no language. */
function fenceLang(s, ls, le) {
  if (le - ls < 3 || s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) return null;
  let i = ls + 3;
  while (i < le && isLangChar(s.charCodeAt(i))) i++;
  const lang = s.slice(ls + 3, i);
  while (i < le) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function fenceClose(s, ls, le) {
  if (le - ls < 3 || s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) return false;
  for (let i = ls + 3; i < le; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
/** Heading { depth, ts, te } (text range) or null. */
function headingOf(s, ls, le) {
  let h = 0;
  while (ls + h < le && s.charCodeAt(ls + h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let t = ls + h;
  if (t >= le) return null;
  const c = s.charCodeAt(t);
  if (c !== 32 && c !== 9) return null;
  while (t < le) { const cc = s.charCodeAt(t); if (cc !== 32 && cc !== 9) break; t++; }
  let e = le;
  while (e > t) { const cc = s.charCodeAt(e - 1); if (cc !== 32 && cc !== 9) break; e--; }
  if (e <= t) return null;
  return { depth: h, ts: t, te: e };
}
function isHr(s, ls, le) {
  if (le - ls < 3) return false;
  const c = s.charCodeAt(ls);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(ls + 1) !== c || s.charCodeAt(ls + 2) !== c) return false;
  for (let i = ls + 3; i < le; i++) { const cc = s.charCodeAt(i); if (cc !== 32 && cc !== 9) return false; }
  return true;
}
/** Trim [ls..le) of spaces/tabs at both ends -> [ts, te). */
function trimRange(s, ls, le) {
  while (ls < le) { const c = s.charCodeAt(ls); if (c !== 32 && c !== 9) break; ls++; }
  while (le > ls) { const c = s.charCodeAt(le - 1); if (c !== 32 && c !== 9) break; le--; }
  return [ls, le];
}

/** Rendered Markdown: { html, toc, excerpt }. */
function renderMarkdown(src, ctx) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = src.length;
  let ls = 0;
  while (ls < n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    const c0 = src.charCodeAt(ls);
    if (le === ls) { ls = le + 1; continue; } // blank (empty line)
    if (c0 === 32 || c0 === 9) {
      // only blank or paragraph can start on space/tab
      if (lineIsBlank(src, ls, le)) { ls = le + 1; continue; }
    } else if (c0 === 96) { // '`': fence or paragraph
      const lang = fenceLang(src, ls, le);
      if (lang !== null) {
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        ls = le + 1;
        while (ls < n) {
          let le2 = src.indexOf('\n', ls);
          if (le2 === -1) le2 = n;
          if (fenceClose(src, ls, le2)) { ls = le2 + 1; break; }
          escRange(src, ls, le2, out);
          out.push('\n');
          ls = le2 + 1;
          if (le2 === n) break;
        }
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // '#': heading or paragraph
      const hd = headingOf(src, ls, le);
      if (hd !== null) {
        const id = uniqueSlug(slugify(src.slice(hd.ts, hd.te), ctx), ids);
        const html = inlineStr(src, hd.ts, hd.te, ctx);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        ls = le + 1; continue;
      }
    } else if (c0 === 62) { // '>': blockquote
      const parts = [];
      while (ls < n) {
        let le2 = src.indexOf('\n', ls);
        if (le2 === -1) le2 = n;
        if (src.charCodeAt(ls) !== 62) break;
        let cs = ls + 1;
        if (cs < le2 && src.charCodeAt(cs) === 32) cs++;
        const [ts, te] = trimRange(src, cs, le2);
        if (ts < te) parts.push(src.slice(ts, te));
        ls = le2 + 1;
        if (le2 === n) break;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const q = parts.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(q, 0, q.length, out, ctx);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': hr, list or paragraph
      if (isHr(src, ls, le)) { out.push('<hr>\n'); ls = le + 1; continue; }
    }
    // list? (bullet '- '/'* ' or ordered digits '. ')
    const bullet = (c0 === 45 || c0 === 42) && src.charCodeAt(ls + 1) === 32;
    let ordStart = -1;
    if (!bullet && isDigit(c0)) {
      let d = ls;
      while (d < le && isDigit(src.charCodeAt(d))) d++;
      if (d > ls && d - ls <= 9 && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) ordStart = Number(src.slice(ls, d));
    }
    if (bullet || ordStart !== -1) {
      const ordered = ordStart !== -1;
      const items = [];
      while (ls < n) {
        let le2 = src.indexOf('\n', ls);
        if (le2 === -1) le2 = n;
        let content = null;
        if (ordered) {
          let d = ls;
          while (d < le2 && isDigit(src.charCodeAt(d))) d++;
          if (d > ls && d - ls <= 9 && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) content = [d + 2, le2];
        } else if ((src.charCodeAt(ls) === 45 || src.charCodeAt(ls) === 42) && src.charCodeAt(ls + 1) === 32) {
          content = [ls + 2, le2];
        }
        if (content !== null) {
          const [ts, te] = trimRange(src, content[0], content[1]);
          items.push([src.slice(ts, te)]);
          ls = le2 + 1;
          if (le2 === n) break;
          continue;
        }
        // continuation: 2+ spaces then a non-space (non-whitespace) char
        let sp = ls;
        while (sp < le2 && src.charCodeAt(sp) === 32) sp++;
        if (sp - ls >= 2 && sp < le2 && !isWSChar(src[sp]) && items.length > 0) {
          const [ts, te] = trimRange(src, ls, le2);
          items[items.length - 1].push(src.slice(ts, te));
          ls = le2 + 1;
          if (le2 === n) break;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && ordStart !== 1 ? `<ol start="${ordStart}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        out.push('<li>');
        if (parts.length === 1) {
          const t = parts[0];
          inlineInto(t, 0, t.length, out, ctx);
        } else {
          const t = parts.join('\n');
          inlineInto(t, 0, t.length, out, ctx);
        }
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // paragraph: lines until blank / fence / heading / hr
    const parts = [];
    {
      const [ts, te] = trimRange(src, ls, le);
      parts.push(src.slice(ts, te));
      ls = le + 1;
      while (ls < n) {
        let le2 = src.indexOf('\n', ls);
        if (le2 === -1) le2 = n;
        if (le2 === ls) break; // blank (empty line)
        const d0 = src.charCodeAt(ls);
        if (d0 === 32 || d0 === 9) { if (lineIsBlank(src, ls, le2)) break; }
        else if (d0 === 96) { if (fenceLang(src, ls, le2) !== null) break; }
        else if (d0 === 35) { if (headingOf(src, ls, le2) !== null) break; }
        else if (d0 === 45 || d0 === 42) { if (isHr(src, ls, le2)) break; }
        const [ts2, te2] = trimRange(src, ls, le2);
        parts.push(src.slice(ts2, te2));
        ls = le2 + 1;
        if (le2 === n) break;
      }
    }
    out.push('<p>');
    if (parts.length === 1) {
      const t = parts[0];
      const mark = out.length;
      inlineInto(t, 0, t.length, out, ctx);
      if (excerpt === null) excerpt = out.slice(mark).join('');
    } else {
      const t = parts.join('\n');
      const mark = out.length;
      inlineInto(t, 0, t.length, out, ctx);
      if (excerpt === null) excerpt = out.slice(mark).join('');
    }
    out.push('</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escStr(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const frame = { vars: { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } }, parent: scope };
        const loop = frame.vars.loop;
        // A loop named "loop" is shadowed by the loop object itself, as in the
        // reference (its per-iteration vars literal puts `loop` after `[name]`).
        const loopWins = n.name === 'loop';
        for (let k = 0; k < xs.length; k++) {
          frame.vars[n.name] = xs[k];
          if (loopWins) frame.vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, frame, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

function linkOf(s, ctx) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx) };
}

function cardOf(s, ctx) {
  if (s._card !== undefined) return s._card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s._card = card;
  return card;
}

export function run(input) {
  const ctx = {
    slugCache: new Map(),
    dateCache: new Map(),
    templates: new Map(),
    bySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
    base: '',
    curDir: '',
    curPath: '',
  };
  const report = [];
  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  ctx.base = base;

  // templates, in code-unit order of name
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      ctx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // sources, in code-unit order of path
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  for (const f of statics) ctx.staticPaths.add(f.path);

  // front matter + checks, in order
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ctx.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, ctx), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    ctx.bySource.set(s.path, s);
  }

  // markdown
  for (const s of kept) {
    ctx.curDir = dirOf(s.path);
    ctx.curPath = s.path;
    const md = renderMarkdown(s.body, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, ctx);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, ctx);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, ctx);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // layouts
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p, ctx));
  // One vars object per render kind, mutated per render (no spread per page).
  const pageVars = { site, tags: allTags, recent, page: null };
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagsVars = { site, tags: allTags, recent };
  const pageScope = { vars: pageVars, parent: null };
  const indexScope = { vars: indexVars, parent: null };
  const tagScope = { vars: tagVars, parent: null };
  const tagsScope = { vars: tagsVars, parent: null };
  const renderWith = (name, scope) => {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s, ctx),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null, ctx),
      older: linkOf(s.older ?? null, ctx),
      is_post: s.post,
    };
    pageVars.page = page;
    output[`${s.outDir}/index.html`] = renderWith(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cardOf(p, ctx));
    indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderWith('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p, ctx)) };
    const html = renderWith('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderWith('tags', tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // report
  const lines = [...report, ...ctx.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
