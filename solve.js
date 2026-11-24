// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output
// tree, byte for byte, for every generated site. It re-implements the
// reference behaviour (front matter, Markdown subset, template dialect,
// slug rule, report) in one fused pass per source, with no per-character
// escaping, no token objects and no repeated work across a build. Every
// cache here lives inside one run() call: one case is answered alone and
// nothing is carried into the next case.

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `s` with the five HTML escapes applied; unchanged when none occur. */
function escapeBulk(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_ALL, (c) => ESCAPES[c]) : s;
}

const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;

/** The slug rule, with a per-case cache: titles, tags and headings repeat. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    // A surrogate pair is one character the rule drops, like any other.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < plain.length) {
      const d = plain.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; if (out.length > 0) gap = true; continue; }
    }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// Unicode whitespace (the complement of \S) at or above U+0080.
const UNI_WS = new Set([0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. The
 *  body is one slice of the source, never a split-and-join of its lines. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line, counting lines from the opening `---`.
  let closeIdx = -1;
  let closeEnd = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let idx = 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (text.slice(pos, end) === '---') { closeIdx = idx; closeEnd = end; break; }
    if (e === -1) break;
    pos = end + 1;
    idx++;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = firstNl + 1;
  for (let i = 1; i < closeIdx; i++) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    const line = text.slice(pos, end);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${i + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
      if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;

const ESCAPABLE = '\\`*_[]()#+-.!>';

function trimStr(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  return isBlankLine(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR_RE.test(line);
}

function isContinued(line) {
  let k = 0;
  while (line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return /^\S$/.test(line[k]);
}

/** The first index from `from` where `s` holds `what` outside a backslash
 *  escape, within [from, hi), or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j + wlen <= hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside
 *  an escape, within [from, hi), or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE.indexOf(s[j + 1]) !== -1) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** `s[lo, hi)` rendered inline, appended to `out`. Nested strong,
 *  emphasis and link text recurse over their own ranges, so no inner
 *  string is ever sliced out and re-scanned from scratch. */
function inlineRange(s, lo, hi, link, out) {
  let i = lo;
  let runStart = lo;
  const flush = (to) => {
    if (to > runStart) out.push(escapeBulk(s.slice(runStart, to)));
  };
  while (i < hi) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < hi && ESCAPABLE.indexOf(s[i + 1]) !== -1) {
        flush(i);
        const ch = s[i + 1];
        out.push(ch === '>' ? '&gt;' : ch);
        i += 2;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        flush(i);
        out.push('<code>', escapeBulk(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineRange(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeBulk(link(target)), '">');
        inlineRange(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(hi);
}

function inlineStr(s, link) {
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/** The words of one line: runs of characters other than whitespace. A
 *  word never spans the `\n` between lines, so a body's count is the sum
 *  of its lines' counts, counted as the lines are consumed. */
function wordsInLine(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const ws = c < 128 ? (c === 32 || (c >= 9 && c <= 13)) : UNI_WS.has(c);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** A body's HTML, table of contents, excerpt and word count, in one
 *  pass over its lines: blocks are rendered as they are read, with no
 *  token list, and each line's words are counted as it is consumed. */
function renderMarkdown(src, link, slugCache) {
  const ids = new Set();
  const toc = [];
  const blocks = [];
  let excerpt = '';
  let hasExcerpt = false;
  let words = 0;
  const N = src.length;
  let pos = 0;
  const nextLine = () => {
    const start = pos;
    const e = src.indexOf('\n', start);
    if (e === -1) { pos = N; return { line: src.slice(start), next: N, start }; }
    pos = e + 1;
    return { line: src.slice(start, e), next: pos, start };
  };
  while (pos < N) {
    const { line, next } = nextLine();
    pos = next;
    if (isBlankLine(line)) continue;
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      words += wordsInLine(line);
      const lang = fence[1];
      const body = [];
      let closed = false;
      while (pos < N) {
        const step = nextLine();
        if (FENCE_CLOSE.test(step.line)) { words += wordsInLine(step.line); pos = step.next; closed = true; break; }
        words += wordsInLine(step.line);
        body.push(step.line);
        pos = step.next;
      }
      void closed;
      const cls = lang === '' ? '' : ` class="language-${escapeBulk(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeBulk(body.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      words += wordsInLine(line);
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      continue;
    }
    if (HR_RE.test(line)) { words += wordsInLine(line); blocks.push('<hr>'); continue; }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      let curLine = line;
      for (;;) {
        words += wordsInLine(curLine);
        let q = curLine.slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        qlines.push(trimStr(q));
        if (pos >= N) break;
        const step = nextLine();
        if (step.line.charCodeAt(0) !== 62) { pos = step.start; break; }
        curLine = step.line;
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      let curLine = line;
      for (;;) {
        words += wordsInLine(curLine);
        const m = marker.exec(curLine);
        if (m !== null) items.push([trimStr(isOrdered ? m[2] : m[1])]);
        else if (isContinued(curLine)) items[items.length - 1].push(trimStr(curLine));
        else break;
        if (pos >= N) break;
        const step = nextLine();
        if (marker.exec(step.line) === null && !isContinued(step.line)) { pos = step.start; break; }
        curLine = step.line;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inlineStr(parts.join('\n'), link)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const lines = [trimStr(line)];
    words += wordsInLine(line);
    while (pos < N) {
      const step = nextLine();
      if (endsParagraph(step.line)) { pos = step.start; break; }
      words += wordsInLine(step.line);
      lines.push(trimStr(step.line));
    }
    const html = inlineStr(lines.join('\n'), link);
    if (!hasExcerpt) { excerpt = html; hasExcerpt = true; }
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt, words };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

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

/** Expand includes once, at parse time, into a flat node list: an
 *  include renders its template in the same scope, at most 8 deep, so
 *  expanding it with the depth baked in renders identically and skips a
 *  map lookup and a recursion on every page. Adjacent text joins. */
function expandNodes(nodes, templates, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      const last = out[out.length - 1];
      if (last !== undefined && last.kind === 'text') last.text += n.text;
      else out.push({ kind: 'text', text: n.text });
    } else if (n.kind === 'var' || n.kind === 'raw') out.push(n);
    else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) expandNodes(t, templates, depth + 1, out);
      }
    } else if (n.kind === 'for') {
      const body = [];
      expandNodes(n.body, templates, depth, body);
      out.push({ kind: 'for', name: n.name, path: n.path, body });
    } else if (n.kind === 'if') {
      const then = [];
      expandNodes(n.then, templates, depth, then);
      let els = null;
      if (n.else !== null) {
        els = [];
        expandNodes(n.else, templates, depth, els);
      }
      out.push({ kind: 'if', not: n.not, path: n.path, then, else: els });
    }
  }
  return out;
}

/** The value at `path` in the scope stack: the first name from the
 *  nearest frame holding it, then own properties down the path. */
function lookup(stack, path) {
  for (let si = stack.length - 1; si >= 0; si--) {
    const vars = stack[si];
    if (hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
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

/** Render flat nodes into `parts`, sharing one array through every
 *  nested if and loop so no intermediate string is built. */
function renderNodes(nodes, stack, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') parts.push(n.text);
    else if (n.kind === 'var') parts.push(escapeBulk(textOf(lookup(stack, n.path))));
    else if (n.kind === 'raw') parts.push(textOf(lookup(stack, n.path)));
    else if (n.kind === 'if') {
      const v = truthy(lookup(stack, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, stack, parts);
    } else {
      const xs = lookup(stack, n.path);
      if (!Array.isArray(xs)) continue;
      const frame = {};
      const loop = { index: 0, first: true, last: false, length: xs.length };
      stack.push(frame);
      for (let k = 0; k < xs.length; k++) {
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        frame[n.name] = xs[k];
        frame.loop = loop;
        renderNodes(n.body, stack, parts);
      }
      stack.pop();
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const REPORT_FILE = 'build-report.txt';

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

export function run(input) {
  const slugCache = new Map();
  const linkCache = new Map();
  const broken = new Set();
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not
  // parse is reported and left out, as if it were not there.
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templates = new Map();
  for (const [name, ast] of parsed) templates.set(name, expandNodes(ast, parsed, 0, []));

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, sorted by path in code-unit order; `\r\n` and lone `\r`
  // made `\n`. Any other file is static.
  const files = [...input.files].sort((x, y) => cmpStr(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the order the checks run: refused, the
  // generator's own directory, a post with no date, no layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
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

  // Permalinks: the slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const key = `${dir.length}:${dir}:${target}`;
      const hit = linkCache.get(key);
      if (hit !== undefined) {
        if (hit === null) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit === null ? target : hit;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let url = null;
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) url = `${page.url}${frag}`;
        else if (staticPaths.has(path)) url = `${base}/${path}${frag}`;
      }
      if (url === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        linkCache.set(key, null);
        return target;
      }
      linkCache.set(key, url);
      return url;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(md.words / 200));
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags, each slug once, named as first met walking
  // the posts in collection order; ordered by count, then by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseVars = { site, tags: allTags, recent };
  const output = {};
  const stack = [baseVars, null];
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    stack[1] = extra;
    renderNodes(nodes, stack, parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
