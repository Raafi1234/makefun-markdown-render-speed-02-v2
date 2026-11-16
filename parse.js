// parse.js — an original, dependency-free Markdown renderer.
//
// parse(markdown) returns precisely the HTML that marked 18.1.3
// produces under its default settings (GFM on, hard breaks off,
// pedantic off). Where marked disagrees with the CommonMark or GFM
// specifications, marked wins: this file follows marked's behaviour,
// quirks included.
//
// How it works, in outline:
//   1. The source is scanned into block tokens. Inline text is not
//      parsed yet; it is parked on a queue so that link reference
//      definitions appearing later in the document are already known
//      when reference links get resolved.
//   2. Each parked inline string is then tokenised. Emphasis and
//      strikethrough matching runs over a shadow copy of the string
//      in which code spans, link destinations, tags, escapes and
//      resolved reference links have been blanked out, so delimiter
//      characters inside those constructs cannot be mistaken for
//      emphasis delimiters.
//   3. The token tree is walked to build the HTML string.
//
// The module holds no state between calls: every parse() builds a
// fresh parser context. There are no imports and no I/O.

// ------------------------------------------------------------------
// Text helpers
// ------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escOne = (c) => ESC_MAP[c];

const ESC_EVERY_RE = /[&<>"']/g;
const ESC_EVERY_TEST = /[&<>"']/;
// An ampersand that already begins something shaped like a character
// reference is preserved by the "soft" escaper.
const ESC_SOFT_RE = /[<>"']|&(?!(#\d{1,7}|#[xX][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_SOFT_TEST = /[<>"']|&(?!(#\d{1,7}|#[xX][a-fA-F0-9]{1,6}|\w+);)/;

function escHtml(s, every) {
  if (every) return ESC_EVERY_TEST.test(s) ? s.replace(ESC_EVERY_RE, escOne) : s;
  return ESC_SOFT_TEST.test(s) ? s.replace(ESC_SOFT_RE, escOne) : s;
}

// Numeric character references in running text: decimal with 1–7
// digits or hex with 1–6 digits, semicolon mandatory. Zero, surrogate
// values and values above U+10FFFF decode to U+FFFD; a reference to
// '&' decodes to the literal text "&amp;".
const NUMREF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMREF_OR_BARE_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumRefs(s) {
  if (!NUMREF_TEST.test(s)) return s;
  return s.replace(NUMREF_OR_BARE_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '�';
    return v === 38 ? '&amp;' : String.fromCodePoint(v);
  });
}

// Link destinations go through encodeURI with the percent sign's own
// encoding undone afterwards. A malformed URI yields null, and the
// caller then renders the label without the link wrapper.
function hrefClean(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove the maximal trailing run of character `ch` — or, when
// `invert` is true, the maximal trailing run of characters that are
// not `ch`.
function cutTail(s, ch, invert) {
  let n = 0;
  const len = s.length;
  while (n < len) {
    const c = s.charAt(len - n - 1);
    if (!invert && c === ch) n++;
    else if (invert && c !== ch) n++;
    else break;
  }
  return s.slice(0, len - n);
}

const BLANK_RE = /^[ \t]*$/;
// Trailing blank lines are dropped only when there are more than two
// of them after the last content line; otherwise the source stands.
function dropFarBlankTail(src) {
  const lines = src.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && BLANK_RE.test(lines[last])) last--;
  return lines.length - last <= 2 ? src : lines.slice(0, last + 1).join('\n');
}

// The lookup key for a link label: trimmed, inner whitespace folded
// to single spaces, case folded. The fold goes lower→upper→lower,
// mirroring the reference (it folds a few extra code points).
function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Bracket matching used for link destinations and labels. Scanning
// starts with the opening bracket already consumed: the result is
// the index where the depth first drops below zero, -1 when the
// string is balanced overall, or -2 when brackets remain open.
// A backslash escapes the following character.
function bracketScan(s, pair) {
  const open = pair[0];
  const close = pair[1];
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs on 4-wide tab stops. `startCol` is the column at which
// the first character of `s` sits.
function tabExpand(s, startCol = 0) {
  if (!s.includes('\t')) return s;
  let col = startCol;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// First line of a string, without splitting the whole thing.
function line0(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Split a table row on pipes that are not backslash-escaped. When
// `width` is given the row is truncated or padded to that many cells.
function rowSplit(row, width) {
  const marked = row.replace(/\|/g, (pipe, off, whole) => {
    let esc = false;
    let b = off;
    while (--b >= 0 && whole[b] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = marked.split(' |');
  let lo = 0;
  if (!cells[0]?.trim()) lo = 1;
  let hi = cells.length;
  if (hi > 0 && !cells[hi - 1]?.trim()) hi--;
  const kept = cells.slice(lo, hi);
  if (width) {
    if (kept.length > width) kept.splice(width);
    else while (kept.length < width) kept.push('');
  }
  return kept.map((c) => c.trim().replace(/\\\|/g, '|'));
}

// A fenced block that starts indented (inside a list item, say) has
// that indentation stripped from each content line carrying at least
// as much leading space.
const FENCE_INDENT_RE = /^(\s+)(?:```)/;
const LEAD_WS_RE = /^\s+/;
function fenceDedent(raw, text) {
  const m = FENCE_INDENT_RE.exec(raw);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = LEAD_WS_RE.exec(line);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ------------------------------------------------------------------
// Pattern assembly
// ------------------------------------------------------------------

// Compose a RegExp from a template by substituting named placeholders
// with the source text of other patterns. Only the first occurrence
// of each placeholder is replaced unless the name is listed in
// `everywhere`. Substitution order is significant: an inserted
// pattern may itself contain a later placeholder's name as plain
// text (the HTML tag list contains both "table" and "html"), so
// callers fill the dangerous holes first. A '^' at the start of an
// inserted fragment (or right after a character that is not '[') is
// dropped, following the reference's convention.
function fill(template, flags, subs, everywhere) {
  let src = typeof template === 'string' ? template : template.source;
  if (subs) {
    for (const [name, sub] of subs) {
      const rep = (typeof sub === 'string' ? sub : sub.source).replace(/(^|[^\[])\^/g, '$1');
      if (everywhere && everywhere.includes(name)) {
        src = src.split(name).join(rep);
      } else {
        const at = src.indexOf(name);
        if (at !== -1) src = src.slice(0, at) + rep + src.slice(at + name.length);
      }
    }
  }
  return new RegExp(src, flags);
}

// Some patterns depend on how much container indentation may precede
// them (list item content shrinks the allowance). This memoises the
// compiled pattern per level — patterns only, never results.
function byIndent(factory) {
  const cache = [];
  return (indent) => {
    const level = Math.max(0, Math.min(3, indent - 1));
    if (!cache[level]) cache[level] = factory(level);
    return cache[level];
  };
}

// ------------------------------------------------------------------
// Assorted small patterns used by the scanners and renderers
// ------------------------------------------------------------------

const MISC = {
  codeDedent: /^(?: {0,3}\t| {1,4})/gm,
  labelEscapes: /\\([\[\]])/g,
  tailHash: /#$/,
  tailBlank: /[ \t]$/,
  anyNonSpace: /[^ ]/,
  leadWs: /^[ \t]+/,
  blank: BLANK_RE,
  twoBlankTail: /\n[ \t]*\n[ \t]*$/,
  quoteStart: /^ {0,3}>/,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteStrip: /^ {0,3}>[ \t]?/gm,
  quoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  taskTest: /^\[[ xX]\][ \t]+\S/,
  taskStrip: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  multiLine: /\n.*\n/,
  angleHref: /^<(.*)>$/,
  delimHasPipe: /[:|]/,
  alignOuterStrip: /^\||\| *$/g,
  rowTailBlank: /\n[ \t]*$/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  aOpen: /^<a /i,
  aClose: /^<\/a>/i,
  rawOpen: /^<(pre|code|kbd|script)(\s|>)/i,
  rawClose: /^<\/(pre|code|kbd|script)(\s|>)/i,
  ltOpen: /^</,
  gtClose: />$/,
  uniAlnum: /[\p{L}\p{N}]/u,
  word0: /^\S*/,
  tailNl: /\n$/,
  itemHead: (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletAt: byIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrAt: byIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fenceAt: byIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingAt: byIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlAt: null, // set below, once the tag list exists
  quoteAt: byIndent((n) => new RegExp(`^ {0,${n}}>`)),
};

const TAG_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

MISC.htmlAt = byIndent(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);

// ------------------------------------------------------------------
// Block grammar (GFM)
// ------------------------------------------------------------------

const G_BLANK = /^(?:[ \t]*(?:\n|$))+/;
const G_INDENT_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const G_FENCE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const G_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const G_ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const G_LINE = /^[^\n]+/;
const BULLET_SRC = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Setext heading: a run of paragraph-like lines closed by an '=' or
// '-' underline. The lookaheads cut the run wherever a line would
// start a different block construct.
const SETEXT_TMPL =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const SETEXT_SUBS_BASE = [
  ['bull', BULLET_SRC],
  ['blockCode', /(?: {4}| {0,3}\t)/],
  ['fences', / {0,3}(?:`{3,}|~{3,})/],
  ['blockquote', / {0,3}>/],
  ['heading', / {0,3}#{1,6}(?:\s|$)/],
  ['hr', / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  ['html', / {0,3}<[^\n>]+>\n/],
];
const G_SETEXT = fill(
  SETEXT_TMPL,
  '',
  [
    ...SETEXT_SUBS_BASE,
    ['table', / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
  ],
  ['bull', 'blockCode', 'fences', 'blockquote', 'heading', 'hr', 'html', 'table'],
);

// Paragraph pattern factory: the body is a run of lines, each
// following line checked against a negative lookahead of interrupting
// constructs. `tablePat` may be null (inside block quotes there is no
// table interruption variant in the reference's quote grammar).
const PARA_TMPL = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const HTML_OPEN_SRC =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
function paraPattern(listVariant, tablePat) {
  // Fill order matters: the table hole is substituted before the tag
  // list goes in, because the tag list contains the words "table"
  // and "html" as ordinary alternatives.
  const subs = [
    ['hr', G_HR],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['|lheading', ''],
  ];
  if (tablePat) subs.push(['table', tablePat]);
  else subs.push(['|table', '']);
  subs.push(
    ['blockquote', ' {0,3}>'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', listVariant],
    ['html', HTML_OPEN_SRC],
    ['tag', TAG_NAMES],
  );
  return fill(PARA_TMPL, '', subs);
}

// Link reference definition: [label]: destination "optional title".
const LABEL_BODY = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const G_DEF = new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)");

const G_LIST_HEAD = fill(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, '', [['bull', BULLET_SRC]]);

const COMMENT_SRC = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const G_HTML_BLOCK = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))", "i");

// Table: header line, delimiter row, then body rows up to the next
// interrupting construct.
const G_TABLE = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)");

const G_PARA = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)");
const G_PARA_QUOTE = paraPattern(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', null);

// Block quote: lines carrying the '>' marker plus lazy continuation
// lines that belong to an inner paragraph.
const G_QUOTE = fill(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, '', [
  ['paragraph', G_PARA_QUOTE],
]);

const BLOCK = {
  blank: G_BLANK,
  indentedCode: G_INDENT_CODE,
  fence: G_FENCE,
  atx: G_ATX,
  hr: G_HR,
  quote: G_QUOTE,
  listHead: G_LIST_HEAD,
  htmlBlock: G_HTML_BLOCK,
  def: G_DEF,
  table: G_TABLE,
  setext: G_SETEXT,
  para: G_PARA,
  line: G_LINE,
};

// ------------------------------------------------------------------
// Inline grammar (GFM)
// ------------------------------------------------------------------

const I_ESC = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODESPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_HARDBREAK = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const I_UNESCAPE = /\\([\p{P}\p{S}])/gu;
const I_UNESCAPE_MASK = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const I_PUNCT_ONLY = /^((?![*_])[\s\p{P}\p{S}])/u;

// Character classes for delimiter flanking tests. The GFM left
// flanking class for '*' (and the right one) treats '~' as neither
// punctuation nor space, which the "NoTilde" variants encode.
const CLS_PUNCT = /[\p{P}\p{S}]/u;
const CLS_PUNCT_NT = /(?!~)[\p{P}\p{S}]/u;
const CLS_WS_PUNCT = /[\s\p{P}\p{S}]/u;
const CLS_WS_PUNCT_NT = /(?!~)[\s\p{P}\p{S}]/u;
const CLS_NOT_WS_PUNCT = /[^\s\p{P}\p{S}]/u;
const CLS_NOT_WS_PUNCT_T = /(?:[^\s\p{P}\p{S}]|~)/u;

const I_EM_OPEN = fill(
  /^(?:\*+(?:((?!\*)punct)|([^\s\*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  'u',
  [['punct', CLS_PUNCT_NT]],
  ['punct'],
);

// Right-delimiter scanners: global patterns walked forward from an
// opener. Each alternative describes the text preceding a candidate
// closing run and captures that run.
const RDELIM_STAR_TMPL =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const RDELIM_UNDER_TMPL =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";

const RDELIM_EVERYWHERE = ['notPunctSpace', 'punctSpace', 'punct'];
const I_EM_CLOSE_STAR = fill(
  RDELIM_STAR_TMPL,
  'gu',
  [
    ['notPunctSpace', CLS_NOT_WS_PUNCT_T],
    ['punctSpace', CLS_WS_PUNCT_NT],
    ['punct', CLS_PUNCT_NT],
  ],
  RDELIM_EVERYWHERE,
);
const I_EM_CLOSE_UNDER = fill(
  RDELIM_UNDER_TMPL,
  'gu',
  [
    ['notPunctSpace', CLS_NOT_WS_PUNCT],
    ['punctSpace', CLS_WS_PUNCT],
    ['punct', CLS_PUNCT],
  ],
  RDELIM_EVERYWHERE,
);

const I_DEL_OPEN = fill(/^~~?(?:((?!~)punct)|[^\s~])/, 'u', [['punct', CLS_PUNCT]]);
const I_DEL_CLOSE = fill(
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
  'gu',
  [
    ['notPunctSpace', CLS_NOT_WS_PUNCT],
    ['punctSpace', CLS_WS_PUNCT],
    ['punct', CLS_PUNCT],
  ],
  RDELIM_EVERYWHERE,
);
const I_DEL_WHOLE = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Shadow-copy blanking: whole link / code-span / tag spans collapse
// to inert shells of the same length.
const I_SPAN_BLANK = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");

const I_AUTOLINK = fill(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, '', [
  ['scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  [
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  ],
]);

const I_TAG = fill(
  "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  '',
  [
    ['comment', fill(COMMENT_SRC, '', [['(?:-->|$)', '-->']])],
    ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*\"[^\"]*\"|\s*=\s*'[^']*'|\s*=\s*[^\s\"'=<>`]+)?/],
  ],
);

// Link labels: nested bracket pairs one level deep, escapes, and
// code spans (whose backtick runs need not balance inside a label).
const NESTED_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL_SRC = fill(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  '',
  [['brackets', NESTED_BRACKETS]],
);
const I_LINK = fill(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, '', [
  ['label', LINK_LABEL_SRC],
  ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
  ['title', /\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
]);
const I_REFLINK = fill(/^!?\[(label)\]\[(ref)\]/, '', [
  ['label', LINK_LABEL_SRC],
  ['ref', LABEL_BODY],
]);
const I_SHORTLINK = fill(/^!?\[(ref)\](?:\[\])?/, '', [['ref', LABEL_BODY]]);

const REFLINK_LABEL_HUNT = fill(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  '',
  [['brackets', NESTED_BRACKETS]],
);
const REF_BRACKET_HUNT = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const I_REFLINK_HUNT = fill(/reflink|nolink(?!\()/, 'g', [
  [
    'reflink',
    fill(/^!?\[(label)\]\[(ref)\]/, '', [
      ['label', REFLINK_LABEL_HUNT],
      ['ref', REF_BRACKET_HUNT],
    ]),
  ],
  [
    'nolink',
    fill(/^!?\[(ref)\](?:\[\])?/, '', [['ref', REF_BRACKET_HUNT]]),
  ],
]);

const PROTO_SRC = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_BODY = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const I_URL = fill(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, '', [
  ['emailProtocol', fill(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, '', [['email', EMAIL_BODY]], ['email'])],
  ['protocol', PROTO_SRC],
  ['email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
]);
const I_URL_TRIM = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

const I_TEXT = fill(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-]+@))))/,
  '',
  [
    ['protocol', PROTO_SRC],
    ['emailProtocol', /(?:mailto|xmpp):/],
    ['wwwStart', '(?<![^\\s*_~(])www\\.'],
  ],
  ['emailProtocol'],
);

const INLINE = {
  esc: I_ESC,
  codespan: I_CODESPAN,
  hardbreak: I_HARDBREAK,
  delWhole: I_DEL_WHOLE,
  delOpen: I_DEL_OPEN,
  delClose: I_DEL_CLOSE,
  emOpen: I_EM_OPEN,
  emCloseStar: I_EM_CLOSE_STAR,
  emCloseUnder: I_EM_CLOSE_UNDER,
  punctOnly: I_PUNCT_ONLY,
  unescape: I_UNESCAPE,
  unescapeMask: I_UNESCAPE_MASK,
  spanBlank: I_SPAN_BLANK,
  autolink: I_AUTOLINK,
  tag: I_TAG,
  link: I_LINK,
  reflink: I_REFLINK,
  shortlink: I_SHORTLINK,
  reflinkHunt: I_REFLINK_HUNT,
  url: I_URL,
  urlTrim: I_URL_TRIM,
  text: I_TEXT,
};

// ------------------------------------------------------------------
// Delimiter bookkeeping
// ------------------------------------------------------------------

// One pass over a shadow string recording, per delimiter character,
// the last index at which a closing run could start (a run whose
// preceding character is not blank). Matchers use these as scan
// bounds so they never walk past the final possible closer.
function closerBounds(shadow) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = shadow.length;
  for (let i = 0; i < n; i++) {
    const ch = shadow[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : shadow[i - 1];
    let j = i + 1;
    while (j < n && shadow[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { src: shadow, em, del };
}

// ------------------------------------------------------------------
// Parser context
// ------------------------------------------------------------------

// One context per parse() call. `links` collects link reference
// definitions keyed by folded label; `pending` is the queue of
// inline strings awaiting tokenisation; `flags` carries the inline
// state (inside a link label, inside a raw HTML element, whether a
// link has already been emitted at this level, whether a ')' exists
// anywhere relevant, and whether we are at the document's top level).
function makeContext() {
  const ctx = {
    blocks: [],
    links: Object.create(null),
    pending: [],
    flags: { inLink: false, inRaw: false, linkOut: false, parenOk: true, top: true },
    shadowStack: [],
  };
  ctx.blocks.links = ctx.links;
  return ctx;
}

// Park an inline string for later tokenisation into `target` (an
// array that will be filled in place once all blocks are known).
function parkInline(ctx, src, target) {
  ctx.pending.push({ src, target });
  return target;
}

// The block scanner. Tokenisers are tried in a fixed precedence
// order; most are guarded by a first-character test that is a strict
// superset of the pattern's possible openings, so the expensive
// patterns only run where they could match.
function scanBlocks(ctx, src, tokens, nested) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;

    if ((tok = hBlank(ctx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    const c0 = src.charCodeAt(0);
    if ((c0 === 32 || c0 === 9) && (tok = hIndentedCode(ctx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.pending[ctx.pending.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if ((c0 === 96 || c0 === 126 || c0 === 32) && (tok = hFence(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 35 || c0 === 32) && (tok = hAtx(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 45 || c0 === 95 || c0 === 42 || c0 === 32) && (tok = hHr(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 62 || c0 === 32) && (tok = hQuote(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = hList(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 60 || c0 === 32) && (tok = hHtmlBlock(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 91 || c0 === 32) && (tok = hDef(ctx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        ctx.pending[ctx.pending.length - 1].src = last.text;
      } else {
        if (!ctx.blocks.links[tok.tag]) {
          ctx.blocks.links[tok.tag] = { href: tok.href, title: tok.title };
        }
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = hTable(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = hSetext(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }

    if (ctx.flags.top && (tok = hPara(ctx, src))) {
      const last = tokens[tokens.length - 1];
      if (nested && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.pending.pop();
        ctx.pending[ctx.pending.length - 1].src = last.text;
      } else tokens.push(tok);
      nested = false;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = hLine(ctx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.pending.pop();
        ctx.pending[ctx.pending.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.flags.top = true;
  return tokens;
}

// Does `text` contain a complete inline (non-image) link? Used by
// the masking pass: a reference label that itself contains a link
// keeps its characters visible to the emphasis matcher.
function textHasLink(ctx, text) {
  if (!text.includes('[')) return false;
  const linkRe = INLINE.link;
  for (const m of text.matchAll(INLINE.spanBlank)) {
    if (linkRe.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INLINE.reflinkHunt)) {
    const whole = m[0];
    const open = whole.lastIndexOf('[');
    const unknown = whole.charAt(0) === '!' || !Object.hasOwn(ctx.blocks.links, labelKey(whole.slice(open + 1, -1)));
    if (!unknown && !(open > 1 && textHasLink(ctx, whole.slice(1, open - 1)))) return true;
  }
  return false;
}

// Build the shadow copy of an inline string: resolved reference-link
// spans are blanked (recursively when the label itself holds a
// link), escapes and code-span interiors become '+' runs, and whole
// link / code / tag spans become bracketed 'a' shells.
function shadowOf(ctx, src) {
  let shadow = src;
  if (ctx.blocks.links && src.includes('[')) {
    const hunt = INLINE.reflinkHunt;
    const blank = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(ctx.blocks.links, labelKey(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (textHasLink(ctx, inner)) {
          return '[' + inner.replace(hunt, blank) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    shadow = shadow.replace(hunt, blank);
  }
  // Each masking pass is skipped when the characters it keys on are
  // absent: code/escape masking needs a backtick or a backslash, and
  // span blanking needs a bracket, backtick or '<'.
  if (shadow.includes('`') || shadow.includes('\\')) {
    shadow = shadow.replace(INLINE.unescapeMask, (whole, ticks, punct) => {
      if (punct) return '+'.repeat(whole.length);
      if (ticks) return ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return whole;
    });
  }
  if (shadow.includes('[') || shadow.includes('`') || shadow.includes('<')) {
    shadow = shadow.replace(INLINE.spanBlank, (whole, a, b) => {
      const keep = b ? b.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
  }
  return shadow;
}

function scanInline(ctx, src, tokens = []) {
  const savedParen = ctx.flags.parenOk;
  ctx.flags.parenOk = savedParen && src.includes(')');
  try {
    const needsShadow = src.includes('*') || src.includes('_') || src.includes('~');
    const shadow = needsShadow ? shadowOf(ctx, src) : src;
    ctx.shadowStack.push(closerBounds(shadow));
    try {
      inlineLoop(ctx, src, shadow, tokens);
    } finally {
      ctx.shadowStack.pop();
    }
  } finally {
    ctx.flags.parenOk = savedParen;
  }
  return tokens;
}

function emBound(ctx, shadow, ch) {
  const top = ctx.shadowStack[ctx.shadowStack.length - 1];
  if (top && top.src === shadow) return top.em[ch];
  return closerBounds(shadow).em[ch];
}

function delBound(ctx, shadow) {
  const top = ctx.shadowStack[ctx.shadowStack.length - 1];
  if (top && top.src === shadow) return top.del;
  return closerBounds(shadow).del;
}

// The inline scanner: same dispatch idea as the block scanner — a
// first-character guard per tokeniser, each a superset of its
// pattern's openings.
function inlineLoop(ctx, src, shadow, tokens) {
  let prevWasText = false;
  let prevChar = '';
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    let tok;

    const c0 = src.charCodeAt(0);
    if (c0 === 92 && (tok = iEscape(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (c0 === 60 && (tok = iTag(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 91 || c0 === 33) && (tok = iLink(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 91 || c0 === 33) && (tok = iReflink(ctx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    if ((c0 === 42 || c0 === 95) && (tok = iEmStrong(ctx, src, shadow, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (c0 === 96 && (tok = iCodespan(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((c0 === 32 || c0 === 92) && (tok = iHardbreak(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (c0 === 126 && (tok = iDel(ctx, src, shadow, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (c0 === 60 && (tok = iAutolink(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (!ctx.flags.inLink && urlStartChar(c0) && (tok = iUrl(ctx, src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = iText(ctx, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevWasText = true;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ------------------------------------------------------------------
// Block handlers. Each returns a token or undefined.
// ------------------------------------------------------------------

function hBlank(ctx, src) {
  const m = BLOCK.blank.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function hIndentedCode(ctx, src) {
  const m = BLOCK.indentedCode.exec(src);
  if (m) {
    const raw = dropFarBlankTail(m[0]);
    const text = raw.replace(MISC.codeDedent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function hFence(ctx, src) {
  const m = BLOCK.fence.exec(src);
  if (m) {
    const raw = m[0];
    const text = fenceDedent(raw, m[3] || '');
    return {
      type: 'code',
      raw,
      lang: m[2] ? m[2].trim().replace(INLINE.unescape, '$1') : m[2],
      text,
    };
  }
}

function hAtx(ctx, src) {
  const m = BLOCK.atx.exec(src);
  if (m) {
    let text = m[2].trim();
    // A closing run of '#' is stripped when it is the whole text or
    // is preceded by a space or tab.
    if (MISC.tailHash.test(text)) {
      const stripped = cutTail(text, '#');
      if (!stripped || MISC.tailBlank.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: cutTail(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: parkInline(ctx, text, []),
    };
  }
}

function hHr(ctx, src) {
  const m = BLOCK.hr.exec(src);
  if (m) return { type: 'hr', raw: cutTail(m[0], '\n') };
}

function hQuote(ctx, src) {
  const m = BLOCK.quote.exec(src);
  if (!m) return undefined;
  let lines = cutTail(m[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const out = [];
  while (lines.length > 0) {
    // Peel one layer of quote: a run of marked lines together with
    // any unmarked lines that precede the first marker.
    let sawMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (MISC.quoteStart.test(lines[p])) { chunk.push(lines[p]); sawMarker = true; }
      else if (!sawMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(MISC.quoteMarkerWs, (whole, marker, ws) => marker + tabExpand(ws, marker.length))
      .replace(MISC.quoteSetext, '\n    $1')
      .replace(MISC.quoteStrip, '');
    rawAll = rawAll ? rawAll + '\n' + joined : joined;
    textAll = textAll ? textAll + '\n' + stripped : stripped;
    const savedTop = ctx.flags.top;
    ctx.flags.top = true;
    scanBlocks(ctx, stripped, out, true);
    ctx.flags.top = savedTop;
    if (lines.length === 0) break;
    const last = out[out.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      // The inner quote can absorb the remaining lines: re-scan the
      // concatenation and splice the merged token in.
      const rest = lines.join('\n');
      const mergedSrc = last.raw + '\n' + rest.replace(MISC.quoteStrip, '');
      const merged = hQuote(ctx, mergedSrc);
      if (!merged) break;
      out[out.length - 1] = merged;
      const leftover = mergedSrc.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
      if (consumed.length > 0) rawAll += '\n' + consumed.join('\n');
      textAll = textAll.substring(0, textAll.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && MISC.quoteStart.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const mergedSrc = last.raw + '\n' + lines.join('\n');
      const merged = hList(ctx, mergedSrc);
      if (!merged) break;
      out[out.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? mergedSrc.slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        rawAll += '\n' + taken;
        textAll += '\n' + taken;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, tokens: out, text: textAll };
}

function hList(ctx, src) {
  const head = BLOCK.listHead.exec(src);
  if (!head) return undefined;
  const origin = src;
  const used = () => origin.length - src.length;
  const bulletText = head[1].trim();
  const ordered = bulletText.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bulletText.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletRe = ordered ? `\\d{1,9}\\${bulletText.slice(-1)}` : `\\${bulletText}`;
  const itemRe = MISC.itemHead(bulletRe);
  let pendingLoose = false;
  let m = head;
  while (src) {
    let blankFirstUsed = false;
    if (!(m = itemRe.exec(src)) || BLOCK.hr.test(src)) break;
    const itemStart = used();
    src = src.substring(m[0].length);
    const firstLine = line0(m[2]);
    const bulletLen = m[1].length;
    // Only the first line's leading whitespace is tab-expanded here,
    // with tab stops counted from the end of the bullet.
    let content = firstLine.replace(MISC.leadWs, (ws) => tabExpand(ws, bulletLen));
    let nextLine = line0(src);
    const blankFirst = !content.trim();
    let indent;
    let itemText;
    if (blankFirst) {
      indent = bulletLen + 1;
      itemText = '';
    } else {
      indent = content.search(MISC.anyNonSpace);
      if (indent > 4) indent = 1;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && MISC.blank.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      blankFirstUsed = true;
    }
    if (!blankFirstUsed) {
      const nextBulletRe = MISC.nextBulletAt(indent);
      const hrRe = MISC.hrAt(indent);
      const fenceRe = MISC.fenceAt(indent);
      const headingRe = MISC.headingAt(indent);
      const htmlRe = MISC.htmlAt(indent);
      const quoteRe = MISC.quoteAt(indent);
      let line = content;
      let wasBlank = blankFirst;
      while (src) {
        const rawLine = line0(src);
        nextLine = rawLine;
        const expanded = rawLine.charCodeAt(0) === 32 || rawLine.charCodeAt(0) === 9
          ? rawLine.replace(MISC.leadWs, (ws) => tabExpand(ws))
          : rawLine;
        if (fenceRe.test(rawLine) || headingRe.test(rawLine) || htmlRe.test(rawLine) || quoteRe.test(rawLine) || nextBulletRe.test(rawLine) || hrRe.test(rawLine)) break;
        if (expanded.search(MISC.anyNonSpace) >= indent || !rawLine.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (wasBlank || content.replace(/\t/g, '    ').search(MISC.anyNonSpace) >= 4 || fenceRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
          const setextLine = /^ {0,3}(?:=+|-+) *$/.test(rawLine) && BLOCK.setext.test(`${content}\n${rawLine}`)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : rawLine;
          itemText += '\n' + setextLine;
        }
        wasBlank = !rawLine.trim();
        src = src.substring(rawLine.length + 1);
        line = expanded.slice(indent);
        content = line;
      }
    }
    const itemRaw = origin.slice(itemStart, used());
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (MISC.twoBlankTail.test(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!MISC.taskTest.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return undefined;
  list.raw = origin.slice(0, used()).trimEnd();
  for (const item of list.items) {
    ctx.flags.top = false;
    item.tokens = [];
    scanBlocksInto(ctx, item.text, item.tokens);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => MISC.multiLine.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(MISC.taskStrip, '');
      first.raw = first.raw.replace(MISC.taskStrip, '');
      first.text = first.text.replace(MISC.taskStrip, '');
      for (let gi = ctx.pending.length - 1; gi >= 0; gi--) {
        if (MISC.taskTest.test(ctx.pending[gi].src)) {
          ctx.pending[gi].src = ctx.pending[gi].src.replace(MISC.taskStrip, '');
          break;
        }
      }
      const box = MISC.taskBox.exec(item.raw);
      if (box) {
        const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// List items are scanned into their own token array; the links
// table and the inline queue stay shared with the enclosing scan.
function scanBlocksInto(ctx, src, tokens) {
  scanBlocks(ctx, src, tokens, false);
}

function hHtmlBlock(ctx, src) {
  const m = BLOCK.htmlBlock.exec(src);
  if (m) {
    const raw = dropFarBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }
}

function hDef(ctx, src) {
  const m = BLOCK.def.exec(src);
  if (m) {
    if (!MISC.ltOpen.test(m[2]) && bracketScan(m[2], '()') !== -1) return undefined;
    const tag = labelKey(m[1]);
    const href = m[2] ? m[2].replace(MISC.angleHref, '$1').replace(INLINE.unescape, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.unescape, '$1') : m[3];
    return { type: 'def', tag, raw: cutTail(m[0], '\n'), href, title };
  }
}

function hTable(ctx, src) {
  // Cheap pre-check: the second line must be a delimiter row — only
  // dashes, colons, pipes and spaces, with at least one dash. If it
  // is not, the full table pattern cannot match either.
  const nl = src.indexOf('\n');
  if (nl === -1) return undefined;
  const nl2 = src.indexOf('\n', nl + 1);
  const delimLine = src.slice(nl + 1, nl2 === -1 ? undefined : nl2);
  if (!/^[ :|-]+$/.test(delimLine) || !delimLine.includes('-')) return undefined;
  const m = BLOCK.table.exec(src);
  if (!m || !MISC.delimHasPipe.test(m[2])) return undefined;
  const headerCells = rowSplit(m[1]);
  const alignCells = m[2].replace(MISC.alignOuterStrip, '').split('|');
  const bodyRows = m[3]?.trim() ? m[3].replace(MISC.rowTailBlank, '').split('\n') : [];
  const table = { type: 'table', raw: cutTail(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignCells.length) return undefined;
  for (const cell of alignCells) {
    if (MISC.alignRight.test(cell)) table.align.push('right');
    else if (MISC.alignCenter.test(cell)) table.align.push('center');
    else if (MISC.alignLeft.test(cell)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: parkInline(ctx, headerCells[i], []), header: true, align: table.align[i] });
  }
  for (const row of bodyRows) {
    table.rows.push(
      rowSplit(row, table.header.length).map((cell, j) => ({
        text: cell,
        tokens: parkInline(ctx, cell, []),
        header: false,
        align: table.align[j],
      })),
    );
  }
  return table;
}

function hSetext(ctx, src) {
  // Cheap pre-check: an underline line (only '=' or only '-' after
  // up to three spaces) must appear before the first blank line.
  const blank = /\n[ \t]*\n/.exec(src);
  const limit = blank ? blank.index + 1 : src.length;
  if (!/\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(src.slice(0, limit + 1))) return undefined;
  const m = BLOCK.setext.exec(src);
  if (m) {
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: cutTail(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: parkInline(ctx, text, []),
    };
  }
}

function hPara(ctx, src) {
  const m = BLOCK.para.exec(src);
  if (m) {
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: parkInline(ctx, text, []) };
  }
}

function hLine(ctx, src) {
  const m = BLOCK.line.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], tokens: parkInline(ctx, m[0], []) };
}

// ------------------------------------------------------------------
// Inline handlers. Each returns a token or undefined.
// ------------------------------------------------------------------

// Shared link/image construction: the label is tokenised with the
// in-link flag raised; a plain link whose label emitted another link
// is suppressed outright (links do not nest in the output).
function makeLink(ctx, match, data, raw) {
  const label = match[1].replace(MISC.labelEscapes, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = ctx.flags.inLink;
  const savedOut = ctx.flags.linkOut;
  const savedRaw = ctx.flags.inRaw;
  ctx.flags.inLink = true;
  ctx.flags.linkOut = false;
  const tokens = scanInline(ctx, label);
  const emitted = ctx.flags.linkOut;
  ctx.flags.linkOut = savedOut;
  ctx.flags.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.flags.inRaw = savedRaw;
      return undefined;
    }
    ctx.flags.linkOut = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: data.href,
    title: data.title || null,
    text: label,
    tokens,
  };
}

// True when the label of a would-be link contains a tag or autolink
// reaching past the label's end — then the bracket is not a link.
function labelOverflow(ctx, src, label, skip) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.codespan.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(skip + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag && tag[0].length > label.length - i) return true;
    if (tag) i += tag[0].length - 1;
  }
  return false;
}

function iEscape(ctx, src) {
  const m = INLINE.esc.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function iTag(ctx, src) {
  const m = INLINE.tag.exec(src);
  if (m) {
    if (!ctx.flags.inLink && MISC.aOpen.test(m[0])) ctx.flags.inLink = true;
    else if (ctx.flags.inLink && MISC.aClose.test(m[0])) ctx.flags.inLink = false;
    if (!ctx.flags.inRaw && MISC.rawOpen.test(m[0])) ctx.flags.inRaw = true;
    else if (ctx.flags.inRaw && MISC.rawClose.test(m[0])) ctx.flags.inRaw = false;
    return { type: 'html', raw: m[0], inLink: ctx.flags.inLink, inRawBlock: ctx.flags.inRaw, block: false, text: m[0] };
  }
}

function iLink(ctx, src) {
  if (ctx.flags.parenOk === false) return undefined;
  const m = INLINE.link.exec(src);
  if (!m) return undefined;
  const skip = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelOverflow(ctx, src, m[1], skip)) return undefined;
  const hrefPart = m[2].trim();
  if (MISC.ltOpen.test(hrefPart)) {
    if (!MISC.gtClose.test(hrefPart)) return undefined;
    const unescaped = cutTail(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - unescaped.length) % 2 === 0) return undefined;
  } else {
    const closeIdx = bracketScan(m[2], '()');
    if (closeIdx === -2) return undefined;
    if (closeIdx > -1) {
      const totalLen = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + closeIdx;
      m[2] = m[2].substring(0, closeIdx);
      m[0] = m[0].substring(0, totalLen).trim();
      m[3] = '';
    }
  }
  const backslashTail = cutTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - backslashTail.length) % 2 === 0) return undefined;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (MISC.ltOpen.test(href)) href = href.slice(1, -1);
  return makeLink(ctx, m, {
    href: href && href.replace(INLINE.unescape, '$1'),
    title: title && title.replace(INLINE.unescape, '$1'),
  }, m[0]);
}

function iReflink(ctx, src) {
  const links = ctx.blocks.links;
  const m = INLINE.reflink.exec(src) || INLINE.shortlink.exec(src);
  if (!m) return undefined;
  const skip = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelOverflow(ctx, src, m[1], skip)) return undefined;
  const found = links[labelKey(m[2] || m[1])];
  if (!found) {
    const first = m[0].charAt(0);
    return { type: 'text', raw: first, text: first };
  }
  return makeLink(ctx, m, found, m[0]);
}

function iEmStrong(ctx, src, shadow, prevChar) {
  const open = INLINE.emOpen.exec(src);
  if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
  const delim = open[0][0];
  const sameChar = prevChar === delim;
  const offset = shadow.length - src.length;
  let runStart = offset;
  while (runStart > 0 && shadow[runStart - 1] === delim) runStart--;
  const beforeRun = [...shadow.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelimOrPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctOnly.exec(beforeRun);
  let effPrev = prevChar;
  if (runStart < offset) effPrev = beforeRun;
  const flankPunct = runStart < offset ? beforeIsDelimOrPunct : !!INLINE.punctOnly.exec(effPrev);
  if (open[4] && effPrev.match(MISC.uniAlnum)) return undefined;
  const punctPart = open[1] || open[3] || '';
  if (!punctPart || !effPrev || flankPunct) {
    const openLen = [...open[0]].length - 1;
    let pending = openLen;
    let skipped = 0;
    const delimTotal = offset - runStart + openLen;
    const canOpenBare = !!beforeRun.trim() && (!!punctPart || delim === '*' && !beforeIsDelimOrPunct);
    if (delim !== '*' && delim !== '_') return undefined;
    const closeRe = delim === '*' ? INLINE.emCloseStar : INLINE.emCloseUnder;
    const lastCloser = emBound(ctx, shadow, delim);
    const startPos = shadow.length - src.length + openLen;
    if (lastCloser < startPos) return undefined;
    const rest = shadow.slice(shadow.length - src.length + openLen);
    const bound = lastCloser - startPos;
    let match;
    closeRe.lastIndex = 0;
    while ((match = closeRe.exec(rest)) !== null && !(match.index > bound)) {
      const grp = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!grp) continue;
      let size = [...grp].length;
      if (match[3] || match[4]) { pending += size; continue; }
      if (match[5] || match[6] || canOpenBare) {
        if (sameChar && (match[5] || match[6])) break;
        if (delimTotal % 3 && !((delimTotal + size) % 3)) { skipped += size; continue; }
      }
      pending -= size;
      if (pending > 0) continue;
      size = Math.min(size, size + pending + skipped);
      const firstUnit = [...match[0]][0].length;
      const raw = src.slice(0, openLen + match.index + firstUnit + size);
      if (Math.min(openLen, size) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: scanInline(ctx, inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: scanInline(ctx, inner) };
    }
  }
  return undefined;
}

function iCodespan(ctx, src) {
  const m = INLINE.codespan.exec(src);
  if (m) {
    let text = m[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const padded = text.startsWith(' ') && text.endsWith(' ');
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }
}

function iHardbreak(ctx, src) {
  const m = INLINE.hardbreak.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function iDel(ctx, src, shadow, prevChar) {
  const open = INLINE.delOpen.exec(src);
  if (!open) return undefined;
  if (!(open[1] || '') || !prevChar || INLINE.punctOnly.exec(prevChar)) {
    const openLen = [...open[0]].length - 1;
    let pending = openLen;
    const closeRe = INLINE.delClose;
    const lastCloser = delBound(ctx, shadow);
    const startPos = shadow.length - src.length + openLen;
    if (lastCloser < startPos) return undefined;
    const rest = shadow.slice(shadow.length - src.length + openLen);
    const bound = lastCloser - startPos;
    let match;
    closeRe.lastIndex = 0;
    while ((match = closeRe.exec(rest)) !== null && !(match.index > bound)) {
      const grp = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!grp) continue;
      let size = [...grp].length;
      if (size !== openLen) continue;
      if (match[3] || match[4]) { pending += size; continue; }
      pending -= size;
      if (pending > 0) continue;
      size = Math.min(size, size + pending);
      const firstUnit = [...match[0]][0].length;
      const raw = src.slice(0, openLen + match.index + firstUnit + size);
      const inner = raw.slice(openLen, raw.length - openLen);
      return { type: 'del', raw, text: inner, tokens: scanInline(ctx, inner) };
    }
  }
  return undefined;
}

function iAutolink(ctx, src) {
  const m = INLINE.autolink.exec(src);
  if (m) {
    let text;
    let href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function iUrl(ctx, src) {
  const m = INLINE.url.exec(src);
  if (m) {
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = INLINE.urlTrim.exec(m[0])?.[0] ?? '';
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

// Could an extended autolink or bare email start with this code?
// Openings are a protocol or an email local part, whose first
// character is alphanumeric or one of '.', '_', '+', '-'.
function urlStartChar(c0) {
  return (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45;
}

// Characters that can interrupt a plain text run: markup openers,
// escapes, '_', '@' (the email lookahead), plus the multi-character
// stops '://', 'www.' and a double-space line ending.
const TEXT_STOP_RE = /[\\<!\[`*~_@]/;

function iText(ctx, src) {
  // Fast path: with no stop character and none of the multi-char
  // stops anywhere ahead, the text pattern matches the whole rest.
  if (!TEXT_STOP_RE.test(src) && !src.includes('://') && !src.includes('www.') && !src.includes('  \n') && !src.includes('mailto:') && !src.includes('xmpp:')) {
    const inRaw = ctx.flags.inRaw;
    return { type: 'text', raw: src, text: inRaw ? src : decodeNumRefs(src), escaped: inRaw };
  }
  const m = INLINE.text.exec(src);
  if (m) {
    const inRaw = ctx.flags.inRaw;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeNumRefs(m[0]), escaped: inRaw };
  }
}

// ------------------------------------------------------------------
// Rendering: token tree to HTML
// ------------------------------------------------------------------

function renderBlockList(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInlineList(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCode(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderBlockList(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInlineList(tok.tokens)}</p>\n`; break;
      case 'text': out += renderTextTok(tok, false); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderCode(tok) {
  const langWord = (tok.lang || '').match(MISC.word0)?.[0];
  const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const inner = tok.escaped ? body : escHtml(body, true);
  return langWord
    ? `<pre><code class="language-${escHtml(langWord)}">${inner}</code></pre>\n`
    : `<pre><code>${inner}</code></pre>\n`;
}

function renderList(list) {
  let items = '';
  for (const item of list.items) items += `<li>${renderBlockList(item.tokens)}</li>\n`;
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderCheckbox(tok) {
  return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
}

function renderTable(table) {
  let head = '';
  for (const cell of table.header) head += renderCell(cell);
  head = `<tr>\n${head}</tr>\n`;
  let body = '';
  for (const row of table.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderCell(cell);
    body += `<tr>\n${rowHtml}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInlineList(cell.tokens)}</${tag}>\n`;
}

// Plain-text rendering, used for image alt text: markup is stripped
// and only the textual content survives (a task checkbox keeps its
// raw source text).
const PLAIN = {
  strong: (tok) => (tok.tokens ? renderInlineList(tok.tokens, PLAIN) : tok.text),
  em: (tok) => (tok.tokens ? renderInlineList(tok.tokens, PLAIN) : tok.text),
  codespan: (tok) => tok.text,
  del: (tok) => (tok.tokens ? renderInlineList(tok.tokens, PLAIN) : tok.text),
  html: (tok) => tok.text,
  text: (tok) => tok.text,
  link: (tok) => (tok.tokens ? renderInlineList(tok.tokens, PLAIN) : tok.text),
  image: (tok) => (tok.tokens ? renderInlineList(tok.tokens, PLAIN) : tok.text),
  br: () => '',
  checkbox: (tok) => tok.raw,
};

function renderTextTok(tok, plain) {
  if (tok.tokens) return renderInlineList(tok.tokens, plain ? PLAIN : undefined);
  return tok.escaped ? tok.text : escHtml(tok.text);
}

function renderInlineList(tokens, renderer) {
  const plain = renderer === PLAIN;
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += plain ? tok.text : escHtml(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': out += plain ? PLAIN.link(tok) : renderLink(tok); break;
      case 'image': out += plain ? PLAIN.image(tok) : renderImage(tok); break;
      case 'checkbox': out += plain ? tok.raw : renderCheckbox(tok); break;
      case 'strong': out += plain ? PLAIN.strong(tok) : `<strong>${renderInlineList(tok.tokens)}</strong>`; break;
      case 'em': out += plain ? PLAIN.em(tok) : `<em>${renderInlineList(tok.tokens)}</em>`; break;
      case 'codespan': out += plain ? tok.text : `<code>${escHtml(tok.text, true)}</code>`; break;
      case 'br': out += plain ? '' : '<br>'; break;
      case 'del': out += plain ? PLAIN.del(tok) : `<del>${renderInlineList(tok.tokens)}</del>`; break;
      case 'text': out += renderTextTok(tok, plain); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderLink(tok) {
  const label = tok.autolink ? escHtml(tok.text, true) : renderInlineList(tok.tokens);
  const href = hrefClean(tok.href);
  if (href === null) return label;
  let out = `<a href="${escHtml(href, tok.autolink)}"`;
  if (tok.title) out += ` title="${escHtml(tok.title)}"`;
  return out + '>' + label + '</a>';
}

function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderInlineList(tok.tokens, PLAIN);
  const href = hrefClean(tok.href);
  if (href === null) return escHtml(alt);
  let out = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
  if (tok.title) out += ` title="${escHtml(tok.title)}"`;
  return out + '>';
}

// ------------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------------

/**
 * Render a Markdown string to HTML, byte-identical to marked 18.1.3
 * with default options.
 */
export function parse(markdown) {
  const ctx = makeContext();
  // Line endings are normalised to '\n'; most inputs need no copy.
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  scanBlocks(ctx, src, ctx.blocks, false);
  for (let i = 0; i < ctx.pending.length; i++) {
    const job = ctx.pending[i];
    ctx.flags.inRaw = false;
    scanInline(ctx, job.src, job.target);
  }
  ctx.pending = [];
  return renderBlockList(ctx.blocks);
}
