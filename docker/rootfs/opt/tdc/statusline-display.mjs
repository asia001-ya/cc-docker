#!/usr/bin/env node
/** Pure terminal formatting, shared by the collector and the visual fixture. */
const RESET = '\x1b[0m';
const colors = {
  text: '230;237;243', muted: '139;148;158', divider: '70;80;94', track: '40;45;53',
  model: '96;205;255', modelBackground: '27;43;56', effort: '167;139;250',
  directory: '255;166;87', healthy: '22;197;93', warning: '255;166;87', elevated: '167;139;250', critical: '248;81;73',
};
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const stripAnsi = value => value
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

export function cleanLabel(value) {
  return typeof value === 'string' ? stripAnsi(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/gu, ' ').trim() : '';
}

function cellWidth(segment) {
  if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) return 0;
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment)) return 2;
  const cp = segment.codePointAt(0);
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)) ? 2 : 1;
}

// Preserve layout spaces when measuring rendered rows; labels are cleaned separately.
export const textWidth = text => [...graphemes.segment(stripAnsi(String(text)))].reduce((n, entry) => n + cellWidth(entry.segment), 0);

export function fitLabel(value, width, tail = false) {
  if (width <= 0) return '';
  const text = cleanLabel(value);
  if (textWidth(text) <= width) return text;
  const parts = [...graphemes.segment(text)].map(entry => entry.segment);
  let result = '', used = 0;
  for (const part of tail ? parts.reverse() : parts) {
    const size = cellWidth(part);
    if (used + size > width - 1) break;
    result = tail ? part + result : result + part;
    used += size;
  }
  return tail ? '…' + result : result + '…';
}

export function contextSizeLabel(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return '—';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

export function folderName(value) {
  const source = cleanLabel(value);
  if (!source) return '—';
  const normalized = source.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

const paint = (text, color, bold = false) => `\x1b[38;2;${color}m${bold ? '\x1b[1m' : ''}${text}${RESET}`;
const field = (label, value, color = colors.text) => (label ? paint(`${label} `, colors.muted) : '') + paint(value, color);
const separator = paint(' · ', colors.divider);

function flow(segments, width, joiner = '  ') {
  const lines = [];
  let line = '';
  for (const segment of segments) {
    if (line && textWidth(line) + textWidth(joiner) + textWidth(segment) > width) {
      lines.push(line);
      line = '';
    }
    line += (line ? joiner : '') + segment;
  }
  if (line) lines.push(line);
  return lines;
}

function contextMeter(session, width, occupied) {
  const used = session.context_used_percentage;
  const percent = typeof used === 'number' && Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null;
  const number = percent === null ? '—' : `${Math.round(percent)}%`;
  const fixed = textWidth(`ctx [] ${number}`);
  // Halve the fitted scale too, so constrained panes shrink along with wide ones.
  const preferredLength = Math.max(1, Math.min(32, width - fixed, Math.max(10, width - occupied - textWidth(separator) - fixed)));
  const length = Math.max(1, Math.round(preferredLength / 2));
  const filled = percent === null ? 0 : Math.round(percent / 100 * length);
  const color = percent === null ? colors.muted : percent <= 20 ? colors.healthy : percent <= 50 ? colors.warning : percent <= 70 ? colors.elevated : colors.critical;
  // These two glyphs share height and baseline in the terminal's TDC Statusline font.
  // Keep ASCII backslashes untouched so ordinary terminal output retains its font.
  const bar = paint('■'.repeat(filled), color) + paint('∖'.repeat(length - filled), colors.track);
  return paint('ctx [', colors.muted) + bar + paint('] ', colors.muted) + paint(number, color, percent !== null);
}

export function renderStatusLine(_quota, session, columns = 120) {
  const requested = Number(columns);
  const width = Math.max(16, Math.min(240, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 120) - 4);
  const level = cleanLabel(session.effort_level);
  const thinking = session.thinking_enabled === false ? '关闭' : level || (session.thinking_enabled === true ? '开启' : '—');
  const model = fitLabel(session.model?.display_name || session.model?.id || '模型 —', width - 2);
  const badge = `\x1b[48;2;${colors.modelBackground}m` + paint(` ${model} `, colors.model, true);
  const segments = [
    badge,
    paint(fitLabel(thinking, width), session.thinking_enabled === false ? colors.muted : colors.effort),
    paint(fitLabel(contextSizeLabel(session.context_window_size), width), colors.text),
    field('git', fitLabel(session.git_branch || '—', width - 4)),
    paint(fitLabel(folderName(session.cwd), width), colors.directory),
  ];
  const occupied = segments.reduce((sum, segment) => sum + textWidth(segment), 0) + textWidth(separator) * (segments.length - 1);
  return flow([...segments, contextMeter(session, width, occupied)], width, separator).join('\n');
}
