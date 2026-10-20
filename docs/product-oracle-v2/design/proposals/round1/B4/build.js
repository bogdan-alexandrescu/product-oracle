// B4 Triage: builds the four screens from quillfield.json and tokens.json.
// Usage: node build.js <path to quillfield.json>
const fs = require('fs');
const path = require('path');
const D = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));
const OUT = __dirname;

// ---------- helpers ----------
const kebab = s => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
const vars = o => Object.entries(o).map(([k, v]) => `--${kebab(k)}:${v}`).join(';');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (n, d = 0) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);
const goal = id => D.goals.find(g => g.id === id);
const pct = x => Math.round(x * 100);
const minus = '−';
const signed = (n, d) => (n > 0 ? '+' : n < 0 ? minus : '') + fmt(Math.abs(n), d);

const ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  requests: '<path d="M3 10v4a1 1 0 0 0 1 1h3l7 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  baseline: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  prds: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  priorities: '<path d="M10 6h11M10 12h8M10 18h5M4 4v4M3 12h3M3 16h3v4H3"/>',
  roadmap: '<path d="M3 6h8M7 12h10M13 18h8"/><circle cx="11" cy="6" r="1.5"/><circle cx="17" cy="12" r="1.5"/><circle cx="21" cy="18" r="0.5"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  decision: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  review: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.6M12 17h.01"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  merge: '<path d="M6 4v7a4 4 0 0 0 4 4h9"/><path d="m15 11 4 4-4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L3 9M3 4v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15M21 20v-5h-5"/>',
  next: '<path d="m6 6 6 6-6 6M13 6l6 6-6 6"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  slip: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
};
const ic = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

// confidence colour class
const confCls = c => (c >= 0.75 ? 'hi' : c >= 0.5 ? 'mid' : 'lo');
function ring(value, size, cls, label) {
  const r = size / 2 - 4, C = 2 * Math.PI * r, on = C * value;
  return `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}">
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rt"/>
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="rv" stroke-dasharray="${on.toFixed(1)} ${(C - on).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
<text x="50%" y="50%" dy=".36em" text-anchor="middle">${pct(value)}</text></svg>`;
}
function spark(vals, target, w, h) {
  const all = vals.concat([target]);
  const lo = Math.min(...all), hi = Math.max(...all), pad = 5;
  const y = v => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo || 1));
  const x = i => pad + (w - 2 * pad) * i / (vals.length - 1);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = vals.length - 1;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="6-month trend">
<line x1="${pad}" x2="${w - pad}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}" class="tgt"/>
<polyline points="${pts}" class="ln"/><circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="3.5" class="pt"/></svg>`;
}
function bars(vals, w, h, label) {
  const n = vals.length, gap = 4, bw = (w - gap * (n - 1)) / n, mx = Math.max(...vals);
  return `<svg class="bars" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">${vals.map((v, i) => {
    const bh = Math.max(3, (h - 2) * v / mx);
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="${i === n - 1 ? 'now' : ''}"/>`;
  }).join('')}</svg>`;
}
const meter = (v, max, cls = '') => `<span class="meter ${cls}"><i style="width:${(100 * v / max).toFixed(1)}%"></i></span>`;

// ---------- derived numbers ----------
const G = D.goals.map(g => {
  const first = g.trend_6m[0], last = g.trend_6m[g.trend_6m.length - 1];
  const dec = g.unit === '%' || Number.isInteger(g.current) ? 0 : 1;
  const unitShort = g.unit === '%' ? '%' : g.unit === 'min' ? ' min' : '';
  const gap = Math.abs(g.target - g.current);
  const gapUnit = g.unit === '%' ? ' pts' : g.unit === 'min' ? ' min' : g.unit === 'clinics' ? '' : '';
  const delta = last - first;
  const good = g.better === 'up' ? delta > 0 : delta < 0;
  return { ...g, dec, unitShort, gap, gapUnit, delta, good };
});
const NY = D.needs_you;
const groups = [
  { key: 'decisions', label: 'Decisions', icon: 'decision', items: NY.decisions },
  { key: 'reviews', label: 'Reviews', icon: 'review', items: NY.reviews },
  { key: 'questions', label: 'Questions', icon: 'question', items: NY.questions },
];
const totalNeeds = groups.reduce((s, g) => s + g.items.length, 0);
// Triage order: paused run, waiting checkpoint, run waiting to start, then reviews, then questions.
const blockRank = { 'Overrun': 1, 'Checkpoint': 2, 'Cost approval': 3, 'Approval': 4, 'Comments': 5, 'Interview': 6, 'Asked you': 7 };
const ACTIONS = {
  'Overrun': [['Resume', 'pri'], ['Cancel', '']],
  'Checkpoint': [['Approve', 'pri'], ['Open', '']],
  'Cost approval': [['Approve', 'pri'], ['Open', '']],
  'Approval': [['Review', 'pri']],
  'Comments': [['Resolve', 'pri']],
  'Interview': [['Answer', 'pri']],
  'Asked you': [['Answer', 'pri']],
};
const queue = groups.flatMap(g => g.items.map(it => {
  const [ctx, ref] = it.context.split(' · ');
  let product = ctx, refTxt = ref ? ref.replace('run ', '') : '';
  const m = ctx.match(/^(.*) (v\d+)$/);
  if (m) { product = m[1]; refTxt = m[2]; }
  if (it.from) refTxt = it.from;
  return { ...it, group: g, product, ref: refTxt };
})).sort((a, b) => blockRank[a.kind] - blockRank[b.kind]);
const R = D.requests;
const stateCounts = [
  ['All', R.open], ['New', R.unreviewed], ['Qualified', R.qualified], ['Merged', R.merged_duplicates], ['Disqualified', R.disqualified],
];
if (R.unreviewed + R.qualified + R.merged_duplicates + R.disqualified !== R.open) throw new Error('request states do not sum to open');
const prd = D.prds.find(p => p.state === 'in review');
const steps = D.journey_steps;

// ---------- shared chrome ----------
const NAV = [['Home', 'home'], ['Requests', 'requests'], ['Baseline', 'baseline'], ['PRDs', 'prds'], ['Priorities', 'priorities'], ['Roadmap', 'roadmap'], ['Runs', 'runs'], ['Inbox', 'inbox']];
const BADGE = { Inbox: totalNeeds, Requests: R.unreviewed };
const rail = cur => `<nav class="rail" aria-label="Main">
<div class="logo" aria-label="Oracle">O</div>
${NAV.map(([l, i]) => `<a href="#"${l === cur ? ' aria-current="page"' : ''}>${ic(i)}<span>${l}</span>${BADGE[l] ? `<b class="badge">${BADGE[l]}</b>` : ''}</a>`).join('\n')}
<span class="sp"></span>
<a href="#">${ic('settings')}<span>Settings</span></a>
<div class="me" title="${D.viewer.name}">${D.viewer.initials}</div>
</nav>`;
const tabbar = () => `<nav class="tabbar" aria-label="Main">
${[['Home', 'home'], ['Requests', 'requests'], ['PRDs', 'prds'], ['Inbox', 'inbox'], ['More', 'more']].map(([l, i]) => `<a href="#"${l === 'Home' ? ' aria-current="page"' : ''}>${ic(i)}<span>${l}</span>${BADGE[l] ? `<b class="badge">${BADGE[l]}</b>` : ''}</a>`).join('')}
</nav>`;
const head = (title, chips, action, actIcon) => `<header class="top">
<div class="tl"><h1>${esc(title)}</h1>${chips}</div>
<div class="tr"><button class="btn primary">${ic(actIcon)}${action}</button></div>
</header>`;

const fonts = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap';
const page = (name, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>B4 Triage · ${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>
:root{${vars(T.color.light)}}
@media (prefers-color-scheme: dark){:root{${vars(T.color.dark)}}}
${CSS}
</style>
</head>
<body class="p-${name}">
${body}
</body>
</html>
`;

// ---------- CSS ----------
const CSS = String.raw`
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:400 15px/22px 'Inter',system-ui,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
h1,h2,h3,p,ul,ol{margin:0;padding:0}
ul,ol{list-style:none}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit;cursor:pointer}
.ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:500}
.app{display:grid;grid-template-columns:88px minmax(0,1fr);min-height:100vh}
/* rail */
.rail{background:var(--nav-bg);display:flex;flex-direction:column;align-items:center;padding:14px 0 16px;gap:2px;min-height:100vh}
.rail .logo{width:40px;height:40px;border-radius:12px;background:var(--lime);color:var(--on-lime);display:grid;place-items:center;font:700 19px 'Bricolage Grotesque',system-ui,sans-serif;margin-bottom:12px}
.rail a{position:relative;width:76px;padding:8px 0 7px;border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--nav-text);font:500 13px/16px 'Inter',system-ui,sans-serif}
.rail a .ic{width:21px;height:21px}
.rail a[aria-current]{background:var(--nav-active-bg);color:var(--nav-active-text);font-weight:700}
.badge{position:absolute;top:3px;right:12px;min-width:20px;height:20px;border-radius:10px;background:var(--badge);color:var(--on-badge);font:700 13px/20px 'Inter',system-ui,sans-serif;text-align:center;padding:0 5px}
.rail .sp{flex:1}
.rail .me{width:38px;height:38px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font:700 14px 'Inter',system-ui,sans-serif;margin-top:8px}
.tabbar{display:none}
/* top */
.main{min-width:0;padding:0 28px 28px}
.top{display:flex;align-items:center;gap:16px;height:66px}
.tl{display:flex;align-items:center;gap:10px;min-width:0}
.tr{margin-left:auto;display:flex;gap:10px}
h1{font:700 28px/34px 'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.02em;white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 16px;border-radius:10px;border:1.5px solid var(--border-strong);background:var(--surface);color:var(--text);font:600 15px 'Inter',system-ui,sans-serif;white-space:nowrap}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.act{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:8px;border:1.5px solid var(--border-strong);background:var(--surface);color:var(--text);font:600 14px 'Inter',system-ui,sans-serif;white-space:nowrap}
.act.pri{background:var(--accent-soft);border-color:var(--accent-soft);color:var(--accent-soft-text)}
.act.ok{background:var(--pass-bg);border-color:var(--pass-bg);color:var(--pass)}
.act.no{color:var(--crit);border-color:var(--border-strong)}
/* chips */
.chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;font:600 13px/26px 'Inter',system-ui,sans-serif;white-space:nowrap;background:var(--na-bg);color:var(--na)}
.chip .ic{width:14px;height:14px}
.chip.pass{background:var(--pass-bg);color:var(--pass)}
.chip.warn{background:var(--warn-bg);color:var(--warn)}
.chip.crit{background:var(--crit-bg);color:var(--crit)}
.chip.vio{background:var(--accent-soft);color:var(--accent-soft-text)}
.chip.now{background:var(--lime);color:var(--on-lime)}
.chip.line{background:transparent;border:1.5px solid var(--border-strong);color:var(--text)}
.chip.dash{background:transparent;border:1.5px dashed var(--border-strong);color:var(--text)}
.gid{display:inline-grid;place-items:center;height:24px;min-width:32px;padding:0 6px;border-radius:6px;font:600 13px/24px 'JetBrains Mono',ui-monospace,monospace;background:var(--accent-soft);color:var(--accent-soft-text)}
.gid.none{background:var(--na-bg);color:var(--na)}
.block{background:var(--surface);border:1px solid var(--border);border-radius:14px}
.bh{display:flex;align-items:center;gap:10px;height:52px;padding:0 16px;border-bottom:1px solid var(--border)}
.bh h2{font:700 18px/24px 'Bricolage Grotesque',system-ui,sans-serif;white-space:nowrap}
.bh .r{margin-left:auto;display:flex;gap:8px;align-items:center}
.cap{font:600 13px/18px 'Inter',system-ui,sans-serif;color:var(--text2);white-space:nowrap}
.meter{display:inline-block;position:relative;height:8px;border-radius:4px;background:var(--chart-track);overflow:hidden;vertical-align:middle}
.meter i{position:absolute;inset:0 auto 0 0;background:var(--chart-bar);border-radius:4px}
.meter.pass i{background:var(--pass)}.meter.warn i{background:var(--warn)}
/* charts */
.ring .rt{fill:none;stroke:var(--chart-track);stroke-width:5}
.ring .rv{fill:none;stroke-width:5;stroke-linecap:round}
.ring text{font:700 14px 'Inter',system-ui,sans-serif;fill:var(--text)}
.ring.hi .rv{stroke:var(--pass)}.ring.mid .rv{stroke:var(--warn)}.ring.lo .rv{stroke:var(--crit)}
.bars rect{fill:var(--chart-bar)}
.bars rect.now{fill:var(--lime)}
/* goal band */
.goals{background:var(--hero);color:var(--hero-text);border-radius:16px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.goal{padding:14px 16px;display:flex;flex-direction:column;gap:9px;min-width:0}
.goal+.goal{border-left:1px solid var(--hero-line)}
.g1{display:flex;align-items:center;gap:8px;min-width:0}
.goals .gid{background:var(--hero-chip);color:var(--hero-text)}
.g1 .gn{font:600 15px/20px 'Inter',system-ui,sans-serif;white-space:nowrap}
.g1 .chip{margin-left:auto}
.g2{display:flex;align-items:center;gap:10px}
.num{display:flex;align-items:baseline;gap:4px;font:700 44px/44px 'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.num small{font:600 17px 'Inter',system-ui,sans-serif;letter-spacing:0;color:var(--hero-text)}
.tg{white-space:nowrap;display:flex;flex-direction:column;font:600 13px/17px 'Inter',system-ui,sans-serif;color:var(--hero-text2)}
.tg b{font:700 17px/21px 'Inter',system-ui,sans-serif;color:var(--hero-text)}
.tg.cf{align-items:center;gap:2px}
.g2 .sp2{flex:1}.g2 svg{flex:none}
.goals .spark .ln{fill:none;stroke:var(--lime);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.goals .spark .pt{fill:var(--lime)}
.goals .spark .tgt{stroke:var(--hero-text2);stroke-width:1.5;stroke-dasharray:4 4}
.goals .ring .rt{stroke:var(--hero-line)}
.goals .ring text{fill:var(--hero-text)}
.goals .ring.hi .rv{stroke:var(--ring-high)}.goals .ring.mid .rv{stroke:var(--ring-mid)}.goals .ring.lo .rv{stroke:var(--ring-low)}
.g3{display:flex;gap:6px;flex-wrap:nowrap}
.hc{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border-radius:999px;background:var(--hero-chip);color:var(--hero-text);font:600 13px/26px 'Inter',system-ui,sans-serif;white-space:nowrap}
.hc.good{color:var(--lime)}
.hc .ic{width:14px;height:14px}
.goals .chip.warn{background:var(--ring-mid);color:#16132c}
/* home grid */
.home{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;margin-top:16px;align-items:start}
.side{display:flex;flex-direction:column;gap:16px}
/* queue */
.kinds{display:flex;gap:4px;margin-left:auto}
.kind{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:9px;font:600 14px 'Inter',system-ui,sans-serif;color:var(--text2);border:0;background:transparent;white-space:nowrap}
.kind b{font:700 20px 'Bricolage Grotesque',system-ui,sans-serif;color:var(--text)}
.kind[aria-pressed=true]{background:var(--surface2);color:var(--text)}
table{border-collapse:collapse;width:100%}
.qt{table-layout:fixed}
.qt th{height:38px;text-align:left;font:600 13px/18px 'Inter',system-ui,sans-serif;color:var(--text2);padding:0 8px;border-bottom:1px solid var(--border);white-space:nowrap}
.qt td{height:52px;padding:0 8px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden}
.qt th:first-child,.qt td:first-child{padding-left:16px}
.qt th:last-child,.qt td:last-child{padding-right:16px}
.qt tr:last-child td{border-bottom:0}
.qt .rk{font:600 15px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2)}
.qt tr.next td{background:var(--lime-soft)}
.qt tr.next td:first-child{box-shadow:inset 4px 0 0 var(--lime)}
.qt tr.next .rk{color:var(--on-lime-soft)}
.qt .tt{font-weight:600}
.qt .ctx{color:var(--text)}
.qt .ref{font:500 14px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2)}
.qt .age{font:500 14px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2);text-align:right}
.qt .cost{font:500 13px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2);text-align:right}
.qt .cost.over{color:var(--warn);font-weight:600}
.qt .acts{text-align:right}
.qt .acts .act+.act{margin-left:6px}
.kc{display:inline-flex;align-items:center;gap:6px;font:600 14px 'Inter',system-ui,sans-serif;color:var(--text)}
.kc .ic{width:17px;height:17px;color:var(--accent-text)}
.kc.crit,.kc.crit .ic{color:var(--crit)}
.qf{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--border);position:relative}
.ib{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--border-strong);background:var(--surface);color:var(--text2);padding:0}
.ib .ic{width:15px;height:15px}
.ib[aria-expanded=true]{border-color:var(--accent);color:var(--accent-text)}
.tip{display:flex;align-items:center;gap:10px;background:var(--hero);color:var(--hero-text);border-radius:10px;padding:9px 14px;font:500 14px/20px 'Inter',system-ui,sans-serif;position:relative;max-width:520px}
.tip::before{content:"";position:absolute;left:-6px;top:50%;width:12px;height:12px;margin-top:-6px;background:var(--hero);transform:rotate(45deg)}
.qf .sp{flex:1}
/* side blocks */
.trk{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.trk:last-child{border-bottom:0}
.trk .l1{display:flex;align-items:center;gap:8px}
.trk .l1 b{font-weight:600;white-space:nowrap}
.trk .l1 .chip{margin-left:auto}
.trk .l2{display:flex;align-items:center;gap:8px}
.trk .l2 .meter{flex:1;min-width:40px}
.trk .l2 .dn{font:600 14px 'JetBrains Mono',ui-monospace,monospace;white-space:nowrap}
.sec{font:600 13px/18px 'Inter',system-ui,sans-serif;color:var(--text2);padding:10px 16px 0}
.jdots{display:flex;gap:3px;flex:1}
.jdots i{flex:1;height:8px;border-radius:3px;background:var(--chart-track)}
.jdots i.d{background:var(--chart-bar)}
.jdots i.c{background:var(--lime);box-shadow:0 0 0 1.5px var(--on-lime) inset}
.flow{display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border)}
.big{display:flex;align-items:baseline;gap:6px;font:700 40px/40px 'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.03em}
.big small{font:600 14px 'Inter',system-ui,sans-serif;color:var(--text2);letter-spacing:0}
.flow .bars{margin-left:auto}
.th{display:grid;grid-template-columns:minmax(0,1fr) 48px 24px 34px;align-items:center;gap:8px;height:40px;padding:0 16px;border-bottom:1px solid var(--border)}
.th:last-child{border-bottom:0}
.th span:first-child{white-space:nowrap}
.th .n{font:600 14px 'JetBrains Mono',ui-monospace,monospace;text-align:right}
.th .meter{width:48px}
/* requests page */
.cols{display:grid;grid-template-columns:minmax(0,1fr) 352px;gap:20px;align-items:start}
.filters{display:flex;gap:6px;padding:0 16px;height:56px;align-items:center;border-bottom:1px solid var(--border)}
.f{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:9px;border:1.5px solid var(--border);background:var(--surface);font:600 14px 'Inter',system-ui,sans-serif;color:var(--text);white-space:nowrap}
.f b{font:600 14px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2)}
.f[aria-pressed=true]{background:var(--hero);border-color:var(--hero);color:var(--hero-text)}
.f[aria-pressed=true] b{color:var(--hero-text2)}
.rt2{table-layout:fixed}
.rt2 th{height:38px;text-align:left;font:600 13px/18px 'Inter',system-ui,sans-serif;color:var(--text2);padding:0 8px;border-bottom:1px solid var(--border);white-space:nowrap}
.rt2 td{height:50px;padding:0 8px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden}
.rt2 th:first-child,.rt2 td:first-child{padding-left:16px}
.rt2 th:last-child,.rt2 td:last-child{padding-right:16px}
.rt2 tr:last-child td{border-bottom:0}
.rt2 .tt{font-weight:600}
.rt2 .tt .ic{width:16px;height:16px;color:var(--text2);vertical-align:-3px;margin-right:6px}
.rt2 tr.child td{background:var(--surface2)}
.rt2 tr.child .tt{padding-left:30px;font-weight:500}
.rt2 .n{font:600 14px 'JetBrains Mono',ui-monospace,monospace;text-align:right}
.lk{display:inline-flex;align-items:center;gap:6px;color:var(--accent-text);font-weight:500}
.lk .ic{width:15px;height:15px}
.pane{display:flex;flex-direction:column}
.pane .sec{padding:14px 16px 6px}
.srow{display:grid;grid-template-columns:96px minmax(0,1fr) 30px;gap:10px;align-items:center;height:34px;padding:0 16px}
.srow .meter{width:100%}
.srow .n{font:600 14px 'JetBrains Mono',ui-monospace,monospace;text-align:right}
.tfoot{display:flex;align-items:center;gap:10px;height:48px;padding:0 16px;border-top:1px solid var(--border)}
/* journey */
.journey{display:flex;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px;width:max-content;max-width:100%}
.journey span{display:flex;align-items:center;gap:7px;height:34px;padding:0 13px 0 6px;border-radius:999px;font:500 14px 'Inter',system-ui,sans-serif;color:var(--text);white-space:nowrap}
.journey span i{font:600 13px/24px 'JetBrains Mono',ui-monospace,monospace;font-style:normal;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--surface2);color:var(--text2)}
.journey .done i{background:var(--pass-bg);color:var(--pass)}
.journey .done i .ic{width:14px;height:14px;stroke-width:2.6}
.journey .cur{background:var(--hero);color:var(--hero-text);font-weight:700}
.journey .cur i{background:var(--lime);color:var(--on-lime)}
/* prd review */
.rv{display:grid;grid-template-columns:262px minmax(0,1fr) 372px;gap:20px;align-items:start;margin-top:16px}
.outl li{display:flex;align-items:center;gap:10px;height:44px;padding:0 14px;border-bottom:1px solid var(--border);font-weight:500;white-space:nowrap}
.outl li:last-child{border-bottom:0}
.outl li .ic{width:17px;height:17px}
.outl .ap .ic{color:var(--pass)}
.outl .dr .ic{color:var(--text2)}
.outl .cur{background:var(--accent-soft);color:var(--accent-soft-text);font-weight:700;box-shadow:inset 4px 0 0 var(--accent)}
.outl .cur .ic{color:var(--accent-soft-text)}
.outl li .chip,.outl li .mono{margin-left:auto}
.doc{padding:0 0 8px}
.dt{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border)}
.seg{display:inline-flex;background:var(--surface2);border-radius:10px;padding:3px}
.seg button{border:0;background:none;height:30px;padding:0 12px;border-radius:8px;font:600 14px 'Inter',system-ui,sans-serif;color:var(--text)}
.seg button[aria-pressed=true]{background:var(--surface);box-shadow:0 1px 3px rgba(22,19,44,.18);color:var(--text)}
.dt .sp{flex:1}
.sh{display:flex;align-items:center;gap:10px;padding:18px 20px 10px}
.sh h2{font:700 24px/30px 'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.01em;white-space:nowrap}
.revs{display:flex;gap:8px;padding:0 20px 16px;flex-wrap:wrap}
.av{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--surface);color:var(--text);font:700 12px 'Inter',system-ui,sans-serif}
.rvw{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px 0 5px;border-radius:999px;font:600 14px 'Inter',system-ui,sans-serif;white-space:nowrap}
.rvw.pass{background:var(--pass-bg);color:var(--pass)}.rvw.warn{background:var(--warn-bg);color:var(--warn)}.rvw.na{background:var(--na-bg);color:var(--na)}
.rvw .av{font-size:13px;width:24px;height:24px}
.claim{margin:0 20px 16px;border:1px solid var(--border);border-radius:12px;overflow:hidden}
.claim .ch{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--surface2)}
.claim q{quotes:none;font:600 16px/24px 'Inter',system-ui,sans-serif}
.claim q span{background:var(--highlight);color:var(--highlight-text);border-radius:4px;padding:1px 4px}
.claim .ch .ring{margin-left:auto}
.ev th{height:36px;text-align:left;font:600 13px 'Inter',system-ui,sans-serif;color:var(--text2);padding:0 14px;border-top:1px solid var(--border)}
.ev td{height:40px;padding:0 14px;border-top:1px solid var(--border)}
.ev .n{text-align:right;font:600 14px 'JetBrains Mono',ui-monospace,monospace}
.ev tr.tot td{font-weight:700}
.reqs li{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:8px;align-items:start;padding:12px 20px;border-top:1px solid var(--border);font-size:16px;line-height:25px}
.reqs .id{font:600 14px/25px 'JetBrains Mono',ui-monospace,monospace;color:var(--text2)}
.insp .sg{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.insp .sg:last-child{border-bottom:0}
.insp .sg .who{display:flex;align-items:center;gap:8px;font:600 14px 'Inter',system-ui,sans-serif}
.insp .sg .who .chip{margin-left:auto}
.insp .sg p{font-size:15px;line-height:22px}
.insp .sg .row{display:flex;gap:8px;align-items:center}
.blk{display:flex;gap:10px;align-items:flex-start;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--crit-bg);color:var(--text)}
.blk .ic{color:var(--crit);margin-top:2px}
.comp{display:flex;height:12px;border-radius:6px;overflow:hidden;gap:2px;margin:4px 0}
.comp i{display:block}
.comp .m{background:var(--accent)}.comp .on{background:var(--chart-bar);opacity:.55}.comp .off{background:var(--chart-track)}
.leg{display:flex;gap:10px;font:600 13px 'Inter',system-ui,sans-serif;color:var(--text)}
.leg span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.leg i{width:10px;height:10px;border-radius:3px;display:inline-block}
/* roadmap */
.rm{display:grid;grid-template-columns:minmax(0,1fr) 352px;gap:20px;align-items:start;margin-top:4px}
.rmt{table-layout:fixed}
.rmt th{height:52px;text-align:left;padding:0 14px;border-bottom:1px solid var(--border);font:700 18px 'Bricolage Grotesque',system-ui,sans-serif;white-space:nowrap}
.rmt th .cap{margin-left:6px}
.rmt th.nowc{background:var(--lime-soft)}
.rmt th .nd{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 1.5px var(--on-lime-soft);margin-right:8px;vertical-align:1px}
.rmt td{padding:14px;border-bottom:1px solid var(--border);vertical-align:top}
.rmt td+td,.rmt th+th{border-left:1px solid var(--border)}
.rmt tr:last-child td{border-bottom:0}
.rmt td.nowc{background:color-mix(in srgb,var(--lime-soft) 45%,transparent)}
.trh{display:flex;flex-direction:column;gap:8px}
.trh b{font:700 16px/22px 'Inter',system-ui,sans-serif}
.trh .row{display:flex;gap:8px;align-items:center}
.trh .row .meter{width:84px}
.trh .dn{font:600 14px 'JetBrains Mono',ui-monospace,monospace}
.ms{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1.5px solid var(--border-strong)}
.ms b{font-weight:600}
.ms .row{display:flex;gap:6px;flex-wrap:wrap}
.ms.risk{border-color:var(--warn)}
.ms.slip{border-style:dashed}
.ms.pend{border-style:dashed;background:transparent}
.empty{color:var(--text2);font-weight:600}
tr.pend td{background:var(--surface2)}
.rmt tr.sel td:first-child{box-shadow:inset 4px 0 0 var(--accent);background:var(--accent-soft)}
.insp .kv{display:grid;grid-template-columns:1fr auto;gap:0;padding:0 16px}
.insp .kv>div{display:contents}
.insp .kv>div>span,.insp .kv>div>b{height:44px;display:flex;align-items:center;border-bottom:1px solid var(--border)}
.insp .kv>div>b{justify-content:flex-end;font-weight:600;gap:8px}
.insp .kv>div:last-child>span,.insp .kv>div:last-child>b{border-bottom:0}
.gm{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}
.gm .spark .ln{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round}
.gm .spark .pt{fill:var(--accent)}
.gm .spark .tgt{stroke:var(--text2);stroke-width:1.5;stroke-dasharray:4 4}
.gm .big{font-size:32px;line-height:32px}

/* phone */
@media (max-width:600px){
  .app{display:block}
  .rail{display:none}
  .main{padding:0 16px 96px}
  .top{height:64px}
  h1{font-size:26px}
  .btn{height:40px;padding:0 14px}
  .goals{grid-template-columns:1fr}
  .goal{padding:14px 16px;gap:8px}
  .goal+.goal{border-left:0;border-top:1px solid var(--hero-line)}
  .g1 .gn{white-space:normal}
  .num{font-size:38px;line-height:38px}
  .home{display:flex;flex-direction:column;gap:16px;margin-top:16px}
  .side{gap:16px}
  .qb .bh{height:auto;flex-wrap:wrap;padding:12px 16px;gap:10px}
  .kinds{margin-left:0;width:100%;display:grid;grid-template-columns:repeat(4,1fr)}
  .kind{flex-direction:column;height:auto;padding:6px 0;gap:0;font-size:13px}
  .qt col.c-kind,.qt col.c-ctx,.qt col.c-ref,.qt col.c-cost,.qt col.c-rk{width:0}
  .qt,.qt tbody{display:block;width:100%}
  .qt colgroup,.qt thead{display:none}
  .qt .h-rk,.qt .h-kind,.qt .h-ctx,.qt .h-ref,.qt .h-cost{display:none}
  .qt td.rk,.qt td.kd,.qt td.ctx,.qt td.ref,.qt td.cost,.qt td.age{display:none}
  .qt tr{display:flex;align-items:center;gap:8px;padding:0 16px;height:54px;border-bottom:1px solid var(--border)}
  .qt tr:last-child{border-bottom:0}
  .qt td{height:auto;padding:0!important;border:0}
  .qt td.tt{flex:1;min-width:0;white-space:normal;line-height:20px}
  .qt tr{min-height:54px;height:auto!important;padding-top:8px!important;padding-bottom:8px!important}
  .p-home .qt td.tt .ic{display:inline-block}
  .home>*{min-width:0;max-width:100%}
  .qt .acts .act.sec2{display:none}
  .qt tr.next{background:var(--lime-soft);box-shadow:inset 4px 0 0 var(--lime)}
  .qt tr.next td{background:transparent}
  .qt tr.next td:first-child{box-shadow:none}
  .qf{flex-wrap:wrap}
  .tip{max-width:100%}
  .tip::before{display:none}
  .tabbar{display:grid;grid-template-columns:repeat(5,1fr);position:fixed;left:0;right:0;bottom:0;height:72px;background:var(--nav-bg);padding:6px 6px 10px}
  .tabbar a{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--nav-text);font:500 13px/16px 'Inter',system-ui,sans-serif;border-radius:12px}
  .tabbar a .ic{width:22px;height:22px}
  .tabbar a[aria-current]{background:var(--nav-active-bg);color:var(--nav-active-text);font-weight:700}
  .tabbar .badge{right:14px;top:2px}
}
.qt td.tt .ic{display:none;width:17px;height:17px;vertical-align:-3px;margin-right:6px;color:var(--accent-text)}
.qt td.tt .ic.crit{color:var(--crit)}
`;

// ---------- HOME ----------
function goalBand() {
  return `<section class="goals" aria-label="Goals">
${G.map(g => {
    const conf = confCls(g.confidence);
    const cur = fmt(g.current, g.dec);
    const tgt = fmt(g.target, Number.isInteger(g.target) ? 0 : 1) + (g.unit === '%' ? '%' : g.unit === 'min' ? ' min' : '');
    const arrow = g.delta > 0 ? '▲' : '▼';
    return `<article class="goal">
<div class="g1"><span class="gn">${esc(g.name)}</span></div>
<div class="g2"><span class="num">${cur}${g.unit === '%' ? '<small>%</small>' : ''}</span>
<span class="tg">Target<b>${tgt}</b></span><span class="sp2"></span>
${spark(g.trend_6m, g.target, 76, 44)}
<span class="tg cf">Conf.${ring(g.confidence, 42, conf, `Confidence ${pct(g.confidence)}%`)}</span></div>
<div class="g3"><span class="gid">${g.id}</span><span class="hc ${g.good ? 'good' : ''}">${arrow} ${fmt(Math.abs(g.delta), g.dec)} · 6m</span><span class="hc">${fmt(g.gap, g.dec)}${g.gapUnit} to go</span>${g.status === 'proposed' ? '<span class="chip warn">Proposed</span>' : ''}</div>
</article>`;
  }).join('\n')}
</section>`;
}
function queueBlock() {
  return `<section class="block qb" aria-label="Needs me">
<div class="bh"><h2>Needs me</h2>
<div class="kinds" role="group" aria-label="Filter by kind">
<button class="kind" aria-pressed="true"><b>${totalNeeds}</b>All</button>
${groups.map(g => `<button class="kind" aria-pressed="false"><b>${g.items.length}</b>${g.label}</button>`).join('')}
</div></div>
<table class="qt">
<colgroup><col class="c-rk" style="width:36px"><col class="c-kind" style="width:132px"><col class="c-tt"><col class="c-ctx" style="width:172px"><col class="c-age" style="width:50px"><col class="c-cost" style="width:126px"><col class="c-act" style="width:174px"></colgroup>
<thead><tr><th class="h-rk">#</th><th class="h-kind">Kind</th><th>Item</th><th class="h-ctx">For</th><th style="text-align:right">Age</th><th class="h-cost" style="text-align:right">Cost</th><th style="text-align:right">Action</th></tr></thead>
<tbody>
${queue.map((q, i) => {
    const crit = q.kind === 'Overrun';
    const over = q.kind === 'Overrun';
    return `<tr class="${i === 0 ? 'next' : ''}"><td class="rk">${i + 1}</td>
<td class="kd"><span class="kc ${crit ? 'crit' : ''}">${ic(crit ? 'pause' : q.group.icon)}${q.kind}</span></td>
<td class="tt">${ic(crit ? 'pause' : q.group.icon, crit ? 'crit' : '')}${esc(q.title)}</td>
<td class="ctx">${esc(q.product)}</td>
<td class="age">${q.age}</td>
<td class="cost ${over ? 'over' : ''}">${q.cost ? esc(q.cost.replace(' estimate', ' est.').replace(' of ', '/')) : ''}</td>
<td class="acts">${ACTIONS[q.kind].map(([l, c], j) => `<button class="act ${c} ${j ? 'sec2' : ''}">${l}</button>`).join('')}</td></tr>`;
  }).join('\n')}
</tbody></table>
<div class="qf"><span class="cap">Order</span><button class="ib" aria-expanded="true" aria-label="About the order">${ic('info')}</button>
<div class="tip" role="tooltip">Blocking first: paused runs, then waiting checkpoints and approvals, then reviews, then questions.</div></div>
</section>`;
}
function tracksBlock() {
  const nowNext = D.roadmap.next;
  return `<section class="block" aria-label="Tracks">
<div class="bh"><h2>Tracks</h2><div class="r"><span class="cap">${D.tracks.length} active</span></div></div>
${D.tracks.map(t => {
    const st = t.status === 'on track' ? 'pass' : 'warn';
    return `<div class="trk"><div class="l1"><b>${esc(t.name)}</b><span class="chip ${st}">${t.status[0].toUpperCase() + t.status.slice(1)}</span></div>
<div class="l2"><span class="chip now">${esc(t.now_milestone)}</span>${t.at_risk ? `<span class="chip warn">${ic('alert')}${t.at_risk} at risk</span>` : ''}${meter(t.done, t.total, st)}<span class="dn">${t.done}/${t.total}</span></div></div>`;
  }).join('\n')}
<div class="sec">PRD in review</div>
<div class="trk"><div class="l1"><b>${esc(prd.name)}</b><span class="gid">${prd.version}</span></div>
<div class="l2"><span class="chip vio">${prd.journey_stage} ${prd.journey_index}/${steps.length}</span><span class="jdots">${steps.map((s, i) => `<i class="${i + 1 < prd.journey_index ? 'd' : i + 1 === prd.journey_index ? 'c' : ''}" title="${s}"></i>`).join('')}</span><span class="chip crit">${prd.blockers} blockers</span></div></div>
</section>`;
}
function requestsBlock() {
  return `<section class="block" aria-label="Requests">
<div class="bh"><h2>Requests</h2><div class="r"><span class="chip line">${R.open} open</span><span class="chip vio">${R.unreviewed} new</span></div></div>
<div class="flow"><span class="big">${R.new_this_week}<small>this week</small></span>${bars(R.weekly_new_8w, 132, 40, 'New requests per week, last 8 weeks')}<span class="cap">8 wk</span></div>
${R.themes.slice(0, 4).map(t => `<div class="th"><span>${esc(t.name)}</span>${meter(t.count, R.themes[0].count)}<span class="n">${t.count}</span>${t.goal ? `<span class="gid">${t.goal}</span>` : '<span class="gid none">—</span>'}</div>`).join('\n')}
</section>`;
}
const home = page('home', `<div class="app">
${rail('Home')}
<main class="main">
${head('Home', `<span class="chip crit">${totalNeeds} waiting</span>`, 'Next item', 'next')}
${goalBand()}
<div class="home">
${queueBlock()}
<div class="side">
${tracksBlock()}
${requestsBlock()}
</div>
</div>
</main>
${tabbar()}
</div>`);

// ---------- REQUESTS ----------
const stateChip = s => ({ Qualified: 'pass', Merged: 'vio', New: 'vio', Disqualified: 'crit' }[s]);
const reqRows = R.rows.map(r => {
  let last;
  if (r.state === 'Qualified') last = `<span class="lk">${ic('link')}${esc(r.linked)}</span>`;
  else if (r.state === 'Merged') last = `<span class="lk">${ic('merge')}Duplicate</span>`;
  else if (r.state === 'Disqualified') last = `<span class="chip line">${esc(r.reason)}</span>`;
  else last = `<button class="act ok">Qualify</button> <button class="act no">Disqualify</button>`;
  return `<tr class="${r.state === 'Merged' ? 'child' : ''}"><td class="tt">${r.state === 'Merged' ? ic('merge') : ''}${esc(r.title)}</td>
<td>${r.source}</td><td class="n">${r.mentions}</td>
<td>${r.goal ? `<span class="gid">${r.goal}</span>` : '<span class="gid none">—</span>'}</td>
<td><span class="chip ${stateChip(r.state)}">${r.state}</span></td><td>${last}</td></tr>`;
}).join('\n');
const srcMax = Math.max(...Object.values(R.by_source));
const srcTotal = Object.values(R.by_source).reduce((a, b) => a + b, 0);
if (srcTotal !== R.open) throw new Error('sources do not sum to open');
const requests = page('requests', `<div class="app">
${rail('Requests')}
<main class="main">
${head('Requests', `<span class="chip line">${R.open} open</span><span class="chip vio">${R.new_this_week} this week</span>`, 'Add request', 'plus')}
<div class="cols">
<section class="block" aria-label="Requests and feedback">
<div class="filters" role="group" aria-label="Filter by state">
${stateCounts.map(([l, n], i) => `<button class="f" aria-pressed="${i === 0}">${l}<b>${n}</b></button>`).join('')}
</div>
<table class="rt2">
<colgroup><col><col style="width:92px"><col style="width:80px"><col style="width:56px"><col style="width:120px"><col style="width:232px"></colgroup>
<thead><tr><th>Request</th><th>Source</th><th style="text-align:right">Mentions</th><th>Goal</th><th>State</th><th>Link or reason</th></tr></thead>
<tbody>
${reqRows}
</tbody></table>
<div class="tfoot"><span class="cap">${R.rows.length} of ${R.open}</span></div>
</section>
<aside class="block pane insp" aria-label="Themes and flow">
<div class="bh"><h2>Themes</h2><div class="r"><span class="cap">${R.themes.length}</span></div></div>
${R.themes.map(t => `<div class="th"><span>${esc(t.name)}</span>${meter(t.count, R.themes[0].count)}<span class="n">${t.count}</span>${t.goal ? `<span class="gid">${t.goal}</span>` : '<span class="gid none">—</span>'}</div>`).join('\n')}
<div class="sec">New per week</div>
<div class="flow"><span class="big">${R.new_this_week}<small>this week</small></span>${bars(R.weekly_new_8w, 150, 44, 'New requests per week, last 8 weeks')}</div>
<div class="sec">Sources</div>
${Object.entries(R.by_source).map(([s, n]) => `<div class="srow"><span>${s}</span>${meter(n, srcMax)}<span class="n">${n}</span></div>`).join('\n')}
<div style="height:10px"></div>
</aside>
</div>
</main>
</div>`);

// ---------- PRD REVIEW ----------
const P = D.prd_review;
const journey = cur => `<nav class="journey" aria-label="Journey">${steps.map((s, i) => {
  const n = i + 1, cls = n < cur ? 'done' : n === cur ? 'cur' : '';
  return `<span class="${cls}"><i>${n < cur ? ic('check') : n}</i>${s}</span>`;
}).join('')}</nav>`;
const secIcon = s => s.status === 'approved' ? ['ap', 'check'] : s.status === 'in review' ? ['cur', 'review'] : ['dr', 'dot'];
const approvedN = P.sections.filter(s => s.status === 'approved').length;
const verdict = { approved: ['pass', 'Approved'], 'changes requested': ['warn', 'Changes'], pending: ['na', 'Pending'] };
const initials = n => n.split(' ').map(w => w[0]).join('').replace('.', '');
const evTotal = P.claim.evidence.reduce((a, e) => a + e.count, 0);
const comp = P.composition, compTotal = comp.mandatory + comp.optional_on + comp.optional_off;
const openSug = P.suggestions.filter(s => s.state === 'open').length;
const commentsItem = NY.reviews.find(r => r.kind === 'Comments');
const commentsN = parseInt(commentsItem.title, 10);
const reqs = P.requirements.map(r => { const [id, ...rest] = r.split(' '); return [id, rest.join(' ')]; });
const prdReview = page('prd-review', `<div class="app">
${rail('PRDs')}
<main class="main">
${head(P.prd, `<span class="gid">${P.version}</span><span class="chip vio">In review</span><span class="chip crit">${ic('alert')}${D.prd_review.blockers.length} blockers</span>`, 'Approve ' + P.sections.find(s => s.current).revision, 'check')}
${journey(prd.journey_index)}
<div class="rv">
<aside class="block outl" aria-label="Sections">
<div class="bh"><h2>Sections</h2><div class="r"><span class="cap">${approvedN}/${P.sections.length}</span></div></div>
<ul>${P.sections.map(s => { const [c, i] = secIcon(s); return `<li class="${c}">${ic(i)}${s.name}${s.revision ? `<span class="mono">${s.revision}</span>` : ''}</li>`; }).join('')}</ul>
</aside>
<article class="block doc">
<div class="dt"><div class="seg" role="group" aria-label="Version">${P.versions.map(v => `<button aria-pressed="${v === P.version}">${v}</button>`).join('')}</div>
<div class="seg" role="group" aria-label="View">${['Brief', 'Full'].map(v => `<button aria-pressed="${v === P.view}">${v}</button>`).join('')}</div>
<span class="sp"></span><span class="chip line">${ic('chat')}${commentsN} comments</span></div>
<div class="sh"><h2>Functional requirements</h2><span class="gid">${P.sections.find(s => s.current).revision}</span><span class="chip vio">In review</span></div>
<div class="revs">${P.reviewers.map(r => { const [c, l] = verdict[r.verdict]; return `<span class="rvw ${c}"><span class="av">${initials(r.name)}</span>${esc(r.name)} · ${l}</span>`; }).join('')}</div>
<div class="claim"><div class="ch"><span class="cap">Claim</span><q><span>${esc(P.claim.text)}</span></q>${ring(P.claim.confidence, 46, confCls(P.claim.confidence), `Confidence ${pct(P.claim.confidence)}%`)}</div>
<table class="ev"><thead><tr><th>Evidence</th><th style="text-align:right">Items</th></tr></thead><tbody>
${P.claim.evidence.map(e => `<tr><td>${esc(e.source)}</td><td class="n">${e.count}</td></tr>`).join('')}
<tr class="tot"><td>Total</td><td class="n">${evTotal}</td></tr></tbody></table></div>
<ol class="reqs">${reqs.map(([id, t]) => `<li><span class="id">${id}</span><span>${esc(t)}</span>${id === 'FR-3' ? `<span class="chip crit">${ic('alert')}Gap</span>` : id === 'FR-4' ? '<span class="chip pass">Added</span>' : ''}</li>`).join('')}</ol>
</article>
<aside class="block insp" aria-label="Inspector">
<div class="bh"><h2>Blockers</h2><div class="r"><span class="chip crit">${P.blockers.length}</span></div></div>
${P.blockers.map(b => `<div class="blk">${ic('alert')}<span>${esc(b)}</span></div>`).join('')}
<div class="bh"><h2>Suggestions</h2><div class="r"><span class="chip vio">${openSug} open</span><span class="cap">${P.suggestions.length}</span></div></div>
${P.suggestions.map(s => {
    const st = s.state === 'open' ? '' : s.state === 'accepted' ? '<span class="chip pass">Accepted</span>' : '<span class="chip crit">Rejected</span>';
    const foot = s.state === 'open' ? '<div class="row"><button class="act ok">' + ic('check') + 'Accept</button><button class="act no">' + ic('x') + 'Reject</button></div>' : s.reason ? `<div class="row"><span class="cap">Reason</span><span class="chip line">${esc(s.reason)}</span></div>` : '';
    return `<div class="sg"><div class="who"><span>${esc(s.by)}</span>${st}</div><p>${esc(s.text)}</p>${foot}</div>`;
  }).join('\n')}
<div class="bh"><h2>Composition</h2><div class="r"><span class="cap">${compTotal} modules</span></div></div>
<div class="sg"><div class="who"><span>${esc(comp.pack)}</span></div>
<div class="comp"><i class="m" style="flex:${comp.mandatory}"></i><i class="on" style="flex:${comp.optional_on}"></i><i class="off" style="flex:${comp.optional_off}"></i></div>
<div class="leg"><span><i style="background:var(--accent)"></i>${comp.mandatory} Mandatory</span><span><i style="background:var(--chart-bar);opacity:.55"></i>${comp.optional_on} Optional on</span><span><i style="background:var(--chart-track)"></i>${comp.optional_off} Optional off</span></div></div>
</aside>
</div>
</main>
</div>`);

// ---------- ROADMAP ----------
const RM = D.roadmap;
const trackOf = n => D.tracks.find(t => t.name === n);
const cell = (items, col) => items.length ? items.map(m => {
  const risk = m.state === 'at risk', slip = !!m.slipped_from;
  return `<div class="ms ${risk ? 'risk' : ''} ${slip ? 'slip' : ''}"><b>${esc(m.milestone)}</b>${risk || slip || m.state ? `<div class="row">${m.state === 'on track' ? '<span class="chip pass">On track</span>' : ''}${risk ? `<span class="chip warn">${ic('alert')}At risk</span><span class="chip line">${esc(m.at_risk_item)}</span>` : ''}${slip ? `<span class="chip warn">${ic('slip')}Slipped from ${m.slipped_from}</span>` : ''}</div>` : ''}</div>`;
}).join('') : '<span class="empty">—</span>';
const rmRows = D.tracks.map(t => {
  const st = t.status === 'on track' ? 'pass' : 'warn';
  const pick = arr => arr.filter(m => m.track === t.name);
  return `<tr${t.at_risk ? ' class="sel"' : ''}><td><div class="trh"><b>${esc(t.name)}</b><div class="row"><span class="chip ${st}">${t.status[0].toUpperCase() + t.status.slice(1)}</span>${t.serves.map(s => `<span class="gid">${s}</span>`).join('')}</div><div class="row">${meter(t.done, t.total, st)}<span class="dn">${t.done}/${t.total}</span></div></div></td>
<td class="nowc">${cell(pick(RM.now))}</td><td>${cell(pick(RM.next))}</td><td>${cell(pick(RM.later))}</td></tr>`;
}).join('\n');
const pend = RM.pending.map(p => `<tr class="pend"><td><div class="trh"><b>${esc(p.prd)}</b><div class="row"><span class="chip dash">Pending publish</span></div><div class="row"><span class="chip vio">${prd.journey_stage} ${prd.journey_index}/${steps.length}</span></div></div></td>
<td class="nowc" colspan="3"><div class="ms pend"><b>${p.note[0].toUpperCase() + p.note.slice(1)}</b><div class="row">${prd.serves.map(s => `<span class="gid">${s}</span>`).join('')}<span class="chip crit">${ic('alert')}${prd.blockers} blockers</span></div></div></td></tr>`).join('');
const selT = D.tracks.find(t => t.at_risk) || D.tracks[0];
const selG = G.find(g => g.id === selT.serves[0]);
const selPrd = D.prds.find(p => p.name === selT.name);
const snapshot = RM.from.split(' · ')[0];
const roadmap = page('roadmap', `<div class="app">
${rail('Roadmap')}
<main class="main">
${head('Roadmap', `<span class="chip line">${esc(snapshot)}</span><span class="chip warn">${ic('alert')}${D.tracks.reduce((a, t) => a + t.at_risk, 0)} at risk</span><span class="chip dash">${RM.pending.length} pending</span>`, 'Re-derive', 'refresh')}
<div class="rm">
<section class="block" aria-label="Now, Next, Later">
<table class="rmt"><colgroup><col style="width:290px"><col><col><col></colgroup>
<thead><tr><th>Track</th><th class="nowc"><span class="nd"></span>Now<span class="cap">${RM.now.length}</span></th><th>Next<span class="cap">${RM.next.length}</span></th><th>Later<span class="cap">${RM.later.length}</span></th></tr></thead>
<tbody>${rmRows}
${pend}</tbody></table>
</section>
<aside class="block insp" aria-label="Inspector">
<div class="bh"><h2>${esc(selT.name)}</h2></div>
<div class="gm">${ring(selT.done / selT.total, 56, 'mid', `${selT.done} of ${selT.total} done`)}<span class="big">${selT.done}<small>of ${selT.total} done</small></span></div>
<div class="kv">
<div><span>Status</span><b><span class="chip warn">${selT.status[0].toUpperCase() + selT.status.slice(1)}</span></b></div>
<div><span>Now</span><b>${esc(selT.now_milestone)}</b></div>
<div><span>At risk</span><b><span class="chip warn">${selT.at_risk}</span>${esc(selT.at_risk_item)}</b></div>
<div><span>Slipped</span><b><span class="chip warn">${selT.slipped}</span></b></div>
<div><span>PRD</span><b><span class="gid">${selPrd.version}</span>${selPrd.state[0].toUpperCase() + selPrd.state.slice(1)}</b></div>
</div>
<div class="sec">Moves goal</div>
<div class="gm"><span class="gid">${selG.id}</span><span class="big">${fmt(selG.current, selG.dec)}<small>/ ${fmt(selG.target, Number.isInteger(selG.target) ? 0 : 1)} ${selG.unit}</small></span><span style="flex:1"></span>${spark(selG.trend_6m, selG.target, 96, 40)}</div>
<div class="kv"><div><span>Confidence</span><b>${ring(selG.confidence, 40, confCls(selG.confidence), 'Confidence')}</b></div></div>
</aside>
</div>
</main>
</div>`);

fs.writeFileSync(path.join(OUT, 'home.html'), home);
fs.writeFileSync(path.join(OUT, 'requests.html'), requests);
fs.writeFileSync(path.join(OUT, 'prd-review.html'), prdReview);
fs.writeFileSync(path.join(OUT, 'roadmap.html'), roadmap);
console.log('built', { totalNeeds, queue: queue.map(q => q.kind), G: G.map(g => [g.id, g.delta, g.gap]) });
