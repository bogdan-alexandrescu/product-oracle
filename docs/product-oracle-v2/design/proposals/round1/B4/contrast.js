// Prints the WCAG contrast table for every text/background pair used in the B4 screens.
const T = require('./tokens.json').color;
const lum = h => { const c = h.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const P = [
  ['text', 'bg', 'body', 'page title'], ['text', 'surface', 'body', 'table rows, block titles'], ['text', 'surface2', 'body', 'merged row, segmented'],
  ['text2', 'bg', 'label', 'none in use; reserve'], ['text2', 'surface', 'label', 'column heads, age, counts'], ['text2', 'surface2', 'label', 'merged row meta, outline'],
  ['text', 'limeSoft', 'body', 'next queue row'], ['text2', 'limeSoft', 'label', 'age in next row'], ['warn', 'limeSoft', 'label', 'overrun cost in next row'], ['crit', 'limeSoft', 'label', 'Overrun kind in next row'],
  ['accentText', 'surface', 'body', 'links, kind icons'], ['accentText', 'surface2', 'body', 'link in merged row'],
  ['onAccent', 'accent', 'label', 'primary button'], ['accentSoftText', 'accentSoft', 'label', 'inline actions, G-id, outline current'],
  ['onLime', 'lime', 'label', 'now milestone, rail active'], ['onLimeSoft', 'limeSoft', 'label', 'Now column head'],
  ['heroText', 'hero', 'body', 'goal band, tooltip, filter on'], ['heroText2', 'hero', 'label', 'Target, Conf. labels'], ['heroText', 'heroChip', 'label', 'goal chips'], ['lime', 'heroChip', 'label', 'good trend chip'], ['lime', 'hero', 'label', 'sparkline'],
  ['pass', 'passBg', 'label', 'On track, Approved'], ['warn', 'warnBg', 'label', 'Drifting, at risk'], ['crit', 'critBg', 'label', 'blockers, Disqualified'], ['text', 'critBg', 'body', 'blocker rows'], ['na', 'naBg', 'label', 'Pending, no goal'],
  ['highlightText', 'highlight', 'body', 'claim'], ['warn', 'surface', 'label', 'overrun cost'], ['crit', 'surface', 'label', 'Overrun kind, Disqualify'], ['pass', 'surface', 'label', 'ring, meter'],
  ['navText', 'navBg', 'label', 'rail, tab bar'], ['navActiveText', 'navActiveBg', 'label', 'rail active'], ['onBadge', 'badge', 'label', 'rail badge'],
];
const extra = [['#16132c', 'ringMid', 'label', 'Proposed chip on goal band']];
let out = '| Theme | Text | Background | Use | Kind | Ratio | Needs | Result |\n|---|---|---|---|---|---|---|---|\n';
for (const th of ['light', 'dark']) for (const [f, b, kind, use] of P.concat(extra)) {
  const fc = f.startsWith('#') ? f : T[th][f], bc = T[th][b];
  const r = ratio(fc, bc), need = kind === 'body' ? 7 : 4.5;
  out += `| ${th} | \`${f}\` ${fc} | \`${b}\` ${bc} | ${use} | ${kind} | ${r.toFixed(2)} | ${need} | ${r >= need ? 'pass' : 'FAIL'} |\n`;
}
process.stdout.write(out);
