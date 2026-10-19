// Prints the contrast table for every text/background pair the screens use.
const T = require('../tokens.json');
const lum = h => { const c = h.match(/\w\w/g).map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const PAIRS = [
  ['text', 'bg', 'body: titles, rows, numerals', 7], ['text2', 'bg', 'body: labels, context, ages', 7],
  ['text', 'surface2', 'plain chip, segmented control', 7], ['accentText', 'bg', 'kind labels, links, FR ids', 4.5],
  ['onAccent', 'accent', 'primary button, selected filter', 4.5], ['accentSoftText', 'accentSoft', 'goal id chip, current section', 4.5],
  ['text', 'accentSoft', 'claim highlight', 7], ['pass', 'passBg', 'chip: on track, qualified, approved', 4.5],
  ['warn', 'warnBg', 'chip: drifting, at risk, slipped', 4.5], ['crit', 'critBg', 'chip: disqualified, rejected', 4.5],
  ['na', 'naBg', 'chip: proposed, merged, pending', 4.5], ['info', 'infoBg', 'chip: in review, new, open', 4.5],
  ['pass', 'bg', '6-month change (good)', 4.5], ['crit', 'bg', 'at risk, blockers, reasons', 4.5], ['warn', 'bg', 'cost figure', 4.5],
  ['tipText', 'tipBg', 'tooltip', 7], ['railText', 'railBg', 'rail and tab labels', 7], ['railActiveText', 'railActiveBg', 'active rail item', 7],
  ['onBadge', 'badge', 'inbox count badge', 4.5], ['onLime', 'lime', 'journey: current step', 7], ['lime', 'onLime', 'journey: current step number', 7],
];
const rows = [];
for (const th of ['light', 'dark']) for (const [f, b, use, min] of PAIRS) {
  const c = T.color[th], r = ratio(c[f], c[b]);
  rows.push(`| ${th} | \`${f}\` ${c[f]} | \`${b}\` ${c[b]} | ${use} | ${r.toFixed(2)} | ${min}:1 | ${r >= min ? 'pass' : 'FAIL'} |`);
}
console.log('| Theme | Text | Background | Used for | Ratio | Needs | Result |\n|---|---|---|---|---|---|---|\n' + rows.join('\n'));
