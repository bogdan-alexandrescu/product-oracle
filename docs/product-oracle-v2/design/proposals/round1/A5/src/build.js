// A5 Bento: generates the four HTML screens from quillfield.json.
// Every number on screen is read or derived here, never typed into markup.
const fs = require('fs');
const path = require('path');

const DATA = process.argv[2];
const OUT = process.argv[3];
const D = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const T = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tokens.json'), 'utf8'));

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const goal = id => D.goals.find(g => g.id === id);

// ---------- derived numbers ----------
// % of target: current / target, inverted when lower is better.
const pctOfTarget = g => Math.round(100 * (g.better === 'up' ? g.current / g.target : g.target / g.current));
const delta6m = g => +(g.trend_6m[g.trend_6m.length - 1] - g.trend_6m[0]).toFixed(1);
const confClass = c => (c >= 0.7 ? 'hi' : c >= 0.5 ? 'mid' : 'lo');
const NY = D.needs_you;
const needCounts = { decisions: NY.decisions.length, reviews: NY.reviews.length, questions: NY.questions.length };
const needTotal = needCounts.decisions + needCounts.reviews + needCounts.questions;
const R = D.requests;
const unique = R.open - R.merged_duplicates;
const stateCounts = { New: R.unreviewed, Qualified: R.qualified, Merged: R.merged_duplicates, Disqualified: R.disqualified };
const stateSum = Object.values(stateCounts).reduce((a, b) => a + b, 0);
if (stateSum !== R.open) throw new Error('state counts do not sum to open');
const srcSum = Object.values(R.by_source).reduce((a, b) => a + b, 0);
if (srcSum !== R.open) throw new Error('sources do not sum to open');
const PR = D.prd_review;
const prdInReview = D.prds.find(p => p.state === 'in review');
const evidenceTotal = PR.claim.evidence.reduce((a, e) => a + e.count, 0);

// ---------- icons ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>',
  requests: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  baseline: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  prds: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  priorities: '<path d="M4 6h16M4 12h11M4 18h6"/>',
  roadmap: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5 15.5 12 10 15.5z"/>',
  inbox: '<path d="M3 13 6 5h12l3 8v6H3z"/><path d="M3 13h5l1.5 3h5L16 13h5"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  decision: '<path d="M4 12.5 9 17.5 20 6.5"/>',
  review: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6"/><path d="M12 16.8v.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  merge: '<path d="M7 4v16"/><path d="M7 8c0 5 10 3 10 9v3"/><circle cx="7" cy="4" r="0.6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  play: '<path d="M7 5v14l12-7z"/>',
};
const ic = (n, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

// ---------- small visuals ----------
function ring(pct, size, stroke, cls = '') {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, on = c * Math.min(pct, 100) / 100;
  return `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" class="ring-track" stroke-width="${stroke}"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" class="ring-on" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${on.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
function spark(g, w, h) {
  const vals = g.trend_6m, lo = Math.min(...vals, g.target), hi = Math.max(...vals, g.target);
  const pad = 5, y = v => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo || 1));
  const x = i => pad + (w - 2 * pad) * i / (vals.length - 1);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0)},${h} ${pts} ${x(vals.length - 1)},${h}`;
  const ty = y(g.target).toFixed(1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="6 month trend">` +
    `<line x1="0" x2="${w}" y1="${ty}" y2="${ty}" class="spark-target"/>` +
    `<polygon points="${area}" class="spark-area"/><polyline points="${pts}" class="spark-line"/>` +
    `<circle cx="${x(vals.length - 1)}" cy="${y(vals[vals.length - 1])}" r="4" class="spark-dot"/></svg>`;
}
function bars(vals, w, h, gap = 4) {
  const max = Math.max(...vals), bw = (w - gap * (vals.length - 1)) / vals.length;
  return `<svg class="bars" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="Weekly new requests">` +
    vals.map((v, i) => { const bh = Math.max(3, (h - 2) * v / max); return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" class="${i === vals.length - 1 ? 'bar-now' : 'bar'}"/>`; }).join('') + '</svg>';
}
const chip = (txt, cls = '', icon = '') => `<span class="chip ${cls}">${icon ? ic(icon) : ''}${esc(txt)}</span>`;
const gchip = id => id ? `<span class="gid">${id}</span>` : '<span class="gid none">—</span>';
const statusCls = s => ({ 'on track': 'pass', 'drifting': 'warn', 'at risk': 'crit' }[s] || 'info');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- shell ----------
const NAV = ['Home', 'Requests', 'Baseline', 'PRDs', 'Priorities', 'Roadmap', 'Runs', 'Inbox'];
const navIcon = { Home: 'home', Requests: 'requests', Baseline: 'baseline', PRDs: 'prds', Priorities: 'priorities', Roadmap: 'roadmap', Runs: 'runs', Inbox: 'inbox', Settings: 'settings' };
function rail(active) {
  const a = n => `<a href="#"${n === active ? ' aria-current="page"' : ''}>${ic(navIcon[n])}<span>${n}</span>${n === 'Inbox' ? `<b class="count num">${needTotal}</b>` : ''}</a>`;
  return `<nav class="rail" aria-label="Main"><div class="logo">O</div>${NAV.map(a).join('')}<div class="sp"></div>${a('Settings')}<div class="me" title="${esc(D.viewer.name)}">${D.viewer.initials}</div></nav>`;
}
function tabbar(active) {
  const items = ['Home', 'Requests', 'PRDs', 'Inbox'];
  return `<nav class="tabbar" aria-label="Main">${items.map(n => `<a href="#"${n === active ? ' aria-current="page"' : ''}>${ic(navIcon[n])}<span>${n}</span>${n === 'Inbox' ? `<b class="count num">${needTotal}</b>` : ''}</a>`).join('')}<a href="#">${ic('more')}<span>More</span></a></nav>`;
}
function head(title, statusHtml, action, actionIcon = 'plus') {
  return `<header class="top"><div class="tl"><h1>${esc(title)}</h1>${statusHtml}</div><button class="btn primary">${ic(actionIcon)}${esc(action)}</button></header>`;
}
function page(name, body, active) {
  const css = fs.readFileSync(path.join(__dirname, 'a5.css'), 'utf8');
  const v = (o) => Object.entries(o).map(([k, x]) => `--${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${x}`).join(';');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>A5 Bento · ${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap">
<style>
:root{${v(T.color.light)};color-scheme:light}
@media (prefers-color-scheme: dark){:root{${v(T.color.dark)};color-scheme:dark}}
${css}
</style>
</head>
<body>
<div class="app">${rail(active)}<main class="main">${body}</main></div>
${tabbar(active)}
</body>
</html>
`;
}

// ---------- HOME ----------
function goalCell(g) {
  const p = pctOfTarget(g), d = delta6m(g), good = g.better === 'up' ? d > 0 : d < 0;
  const unit = g.unit === '%' ? '%' : '';
  const unitWord = g.unit === '%' ? '' : ` ${esc(g.unit)}`;
  const tgt = (g.better === 'down' ? `${ic('arrowDown', 'ic dir')}${g.target_text.startsWith('under') ? '&lt; ' : ''}` : ic('arrowUp', 'ic dir')) + `${fmt(g.target)}${unit}${unitWord}`;
  const cc = confClass(g.confidence);
  return `<article class="goal">
  <h3 class="g-name">${gchip(g.id)} ${esc(g.name)}</h3>
  <div class="g-main">
    <div class="g-ring">${ring(p, 62, 7, 'prog')}<b class="num">${p}<i>%</i></b></div>
    <div class="g-num"><b class="num">${fmt(g.current)}${unit}</b><span class="tgt num">${tgt}</span></div>
    ${spark(g, 104, 52)}
  </div>
  <div class="g-foot"><span class="conf ${cc}">${ring(Math.round(g.confidence * 100), 20, 4, 'c')}<span class="num">${Math.round(g.confidence * 100)}%</span><span class="cl">conf.</span></span>
  ${g.status === 'proposed' ? chip('Proposed', 'warn') : ''}
  <span class="delta num ${good ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}<span class="cl">6m</span></span></div>
</article>`;
}
function needsItems() {
  const rows = [];
  const act = { Checkpoint: 'Approve', 'Cost approval': 'Approve', Overrun: 'Decide', Approval: 'Review', Comments: 'Resolve', Interview: 'Answer', 'Asked you': 'Answer' };
  const push = (arr, kind, icon) => arr.forEach(it => rows.push(`<li class="need k-${kind}">${ic(icon)}<span class="nt">${esc(it.title)}</span>${it.from ? `<span class="av" title="${esc(it.from)}">${it.from.split(' ').map(w => w[0]).join('').replace('.', '')}</span>` : ''}${it.cost ? `<span class="cost num">${esc(it.cost.replace(' estimate', '').replace(' of ', '/'))}</span>` : ''}<span class="age num">${esc(it.age)}</span><button class="btn sm ${kind === 'd' ? 'lime' : 'ghost'}">${act[it.kind]}</button></li>`));
  push(NY.decisions, 'd', 'decision'); push(NY.reviews, 'r', 'review'); push(NY.questions, 'q', 'question');
  return rows.join('');
}
function needsTile(mobile) {
  const seg = (k, n, label) => `<div class="nc k-${k}"><b class="num">${n}</b><span>${label}</span></div>`;
  const tot = needTotal;
  return `<section class="tile needs hero" aria-label="Needs me">
  <div class="th"><h2>Needs me</h2><b class="big num">${tot}</b></div>
  <div class="segbar" aria-hidden="true"><i class="k-d" style="flex:${needCounts.decisions}"></i><i class="k-r" style="flex:${needCounts.reviews}"></i><i class="k-q" style="flex:${needCounts.questions}"></i></div>
  <div class="ncounts">${seg('d', needCounts.decisions, 'Decisions')}${seg('r', needCounts.reviews, 'Reviews')}${seg('q', needCounts.questions, 'Questions')}</div>
  <ul class="needlist">${needsItems()}</ul>
</section>`;
}
function trackBlock(t) {
  const rm = D.roadmap;
  const cell = (col, label) => {
    const it = rm[col].find(x => x.track === t.name);
    if (!it) return `<div class="nnl-c ${col} empty"><span class="nl">${label}</span><span class="dash">—</span></div>`;
    const flags = (it.state === 'at risk' ? chip('At risk', 'crit', 'alert') : '') + (it.slipped_from ? chip('Slipped', 'warn') : '');
    return `<div class="nnl-c ${col}"><span class="nl">${label}</span><b>${esc(it.milestone)}</b>${flags}</div>`;
  };
  const pct = Math.round(100 * t.done / t.total);
  return `<div class="track">
  <div class="tr1"><h3>${esc(t.name)}</h3>${chip(cap(t.status), statusCls(t.status))}</div>
  <div class="tr2"><span class="prog"><span class="pb"><i style="width:${pct}%"></i></span><b class="num">${t.done}/${t.total}</b></span>
  ${chip(`${t.at_risk} at risk`, t.at_risk ? 'crit' : 'quiet', t.at_risk ? 'alert' : '')}${chip(`${t.slipped} slipped`, t.slipped ? 'warn' : 'quiet')}
  ${t.serves.map(gchip).join('')}</div>
  <div class="nnl">${cell('now', 'Now')}${cell('next', 'Next')}${cell('later', 'Later')}</div>
</div>`;
}
function journeyDots(p, compact) {
  const steps = D.journey_steps, cur = p.journey_index - 1;
  return `<ol class="jdots${compact ? ' compact' : ''}" aria-label="Journey">${steps.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'cur' : ''}" title="${s}"></li>`).join('')}</ol>`;
}
function workTile() {
  const p = prdInReview;
  return `<section class="tile work" aria-label="Tracks">
  <div class="th"><h2>Tracks</h2><span class="tcount num">${D.tracks.length}</span></div>
  ${D.tracks.map(trackBlock).join('')}
  <div class="inrev"><h4 class="sublbl">In review</h4>
    <div class="ir1">${ic('prds')}<h3>${esc(p.name)}</h3><span class="ver num">${p.version}</span>${chip(`${p.blockers} blockers`, 'crit', 'block')}</div>
    <div class="ir2">${journeyDots(p)}<span class="stage">${esc(p.journey_stage)}</span><span class="num stepof">${p.journey_index}/${D.journey_steps.length}</span>${p.serves.map(gchip).join('')}</div>
  </div>
</section>`;
}
function requestsTile() {
  const funnel = [['Open', R.open], ['Unique', unique], ['Qualified', R.qualified]];
  const top = R.themes.filter(t => t.goal).slice(0, 4), max = R.themes[0].count;
  return `<section class="tile reqs" aria-label="Requests">
  <div class="th"><h2>Requests</h2></div>
  <div class="rq-new"><div><b class="big num">${R.new_this_week}</b><span class="lbl">New this week</span></div>${bars(R.weekly_new_8w, 128, 56)}</div>
  <div class="funnel">${funnel.map(([l, n]) => `<div class="fr"><span class="fl">${l}</span><span class="fb"><i style="width:${(100 * n / R.open).toFixed(1)}%"></i></span><b class="num">${n}</b></div>`).join('')}</div>
  <h4 class="sublbl">Top themes</h4>
  <ul class="themes">${top.map(t => `<li><span class="tn">${esc(t.name)}</span><b class="num">${t.count}</b>${gchip(t.goal)}<span class="tb"><i style="width:${(100 * t.count / max).toFixed(1)}%"></i></span></li>`).join('')}</ul>
</section>`;
}
function home(mobile) {
  const tip = `<div class="tip" role="tooltip"><b>% of target</b> current ÷ target, inverted when lower is better; small ring is confidence</div>`;
  const goals = `<section class="tile goals" aria-label="Goals">
  <div class="th"><h2>Goals</h2><span class="tcount num">${D.goals.length}</span><button class="iinfo" aria-label="About goals" aria-expanded="${mobile ? 'false' : 'true'}">${ic('info')}</button>${mobile ? '' : tip}</div>
  <div class="goal-grid">${D.goals.map(goalCell).join('')}</div>
</section>`;
  const status = `<span class="hstat">${chip(D.company, 'outline')}</span>`;
  return `<div class="content home">${head('Home', status, 'New idea')}<div class="bento">${goals}${needsTile(mobile)}${workTile()}${requestsTile()}</div></div>`;
}

// ---------- REQUESTS ----------
function requestsScreen() {
  const filt = [['All', R.open], ...Object.entries(stateCounts)];
  const stCls = { Qualified: 'pass', Merged: 'info', New: 'accent', Disqualified: 'crit' };
  const rows = R.rows, maxM = Math.max(...rows.map(r => r.mentions));
  const rowHtml = r => {
    const merged = r.state === 'Merged';
    const out = r.linked ? `<span class="lnk">${ic('link')}${esc(r.linked)}</span>` : r.reason ? chip(r.reason, 'crit-o') : '';
    const acts = r.state === 'New' ? `<span class="acts"><button class="ibtn ok" aria-label="Qualify">${ic('check')}</button><button class="ibtn no" aria-label="Disqualify">${ic('x')}</button></span>` : '';
    return `<tr class="${merged ? 'merged' : ''}"><td class="rt">${merged ? ic('merge', 'ic mg') : ''}${esc(r.title)}</td><td class="src">${esc(r.source)}</td><td><b class="num">${r.mentions}</b></td><td>${gchip(r.goal)}</td><td>${chip(r.state, stCls[r.state])}</td><td>${out}${acts}</td></tr>`;
  };
  // merged rows sit under the row they were merged into
  const ordered = [];
  rows.filter(r => r.state !== 'Merged').forEach(r => { ordered.push(r); rows.filter(m => m.merged_into === r.title).forEach(m => ordered.push(m)); });
  const maxT = R.themes[0].count;
  const funnel = [['Open', R.open], ['Unique', unique], ['Qualified', R.qualified]];
  const body = `<div class="content">
${head('Requests', `<span class="hstat">${chip(`${R.open} open`, 'outline')}${chip(`${R.new_this_week} new`, 'accent')}</span>`, 'Add request')}
<div class="rq-layout">
  <section class="tile rq-main">
    <div class="filters"><div class="seg" role="tablist">${filt.map(([l, n], i) => `<button role="tab" aria-selected="${i === 0}">${l}<b class="num">${n}</b></button>`).join('')}</div>
    <div class="srcs">${Object.entries(R.by_source).map(([s, n]) => `<button class="fchip">${esc(s)}<b class="num">${n}</b></button>`).join('')}</div></div>
    <table class="tbl"><thead><tr><th>Request</th><th>Source</th><th>Mentions</th><th>Goal</th><th>State</th><th>Outcome</th></tr></thead>
    <tbody>${ordered.map(rowHtml).join('')}</tbody></table>
    <div class="tfoot num">${rows.length} of ${R.open}</div>
  </section>
  <aside class="rq-side">
    <section class="tile">
      <div class="th"><h2>Flow</h2></div>
      <div class="rq-new"><div><b class="big num">${R.new_this_week}</b><span class="lbl">New this week</span></div>${bars(R.weekly_new_8w, 150, 56)}</div>
      <div class="funnel">${funnel.map(([l, n]) => `<div class="fr"><span class="fl">${l}</span><span class="fb"><i style="width:${(100 * n / R.open).toFixed(1)}%"></i></span><b class="num">${n}</b></div>`).join('')}</div>
    </section>
    <section class="tile">
      <div class="th"><h2>Themes</h2><span class="tcount num">${R.themes.length}</span></div>
      <ul class="themes full">${R.themes.map(t => `<li><div class="r1"><span class="tn">${esc(t.name)}</span><b class="num">${t.count}</b>${gchip(t.goal)}</div><div class="r2"><span class="tb"><i style="width:${(100 * t.count / maxT).toFixed(1)}%"></i></span><span class="tp">${t.prd ? `${ic('prds')}${esc(t.prd)}` : '<span class="dash">No PRD</span>'}</span></div></li>`).join('')}</ul>
    </section>
  </aside>
</div></div>`;
  return page('requests', body, 'Requests');
}

// ---------- PRD REVIEW ----------
function prdScreen() {
  const steps = D.journey_steps, cur = prdInReview.journey_index - 1;
  const journey = `<ol class="journey">${steps.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'cur' : ''}"><i class="num">${i < cur ? ic('check') : i + 1}</i>${esc(s)}</li>`).join('')}</ol>`;
  const secIcon = s => s.status === 'approved' ? `<span class="si pass">${ic('check')}</span>` : s.status === 'in review' ? '<span class="si cur-dot"></span>' : '<span class="si draft"></span>';
  const counts = PR.sections.reduce((a, s) => (a[s.status] = (a[s.status] || 0) + 1, a), {});
  const cur_s = PR.sections.find(s => s.current);
  const verdictCls = { approved: 'pass', 'changes requested': 'warn', pending: 'quiet' };
  const sg = PR.suggestions.map(s => {
    const right = s.state === 'open' ? `<span class="acts"><button class="btn sm ok">${ic('check')}Accept</button><button class="btn sm ghost-d">${ic('x')}Reject</button></span>`
      : s.state === 'accepted' ? chip('Accepted', 'pass', 'check') : `${chip('Rejected', 'crit')}${chip(s.reason, 'outline')}`;
    return `<li class="sg ${s.state}"><p>${esc(s.text)}</p><div class="sgr"><span class="by">${esc(s.by)}</span>${right}</div></li>`;
  }).join('');
  const comp = PR.composition, compTot = comp.mandatory + comp.optional_on + comp.optional_off;
  const ev = PR.claim.evidence, evMax = Math.max(...ev.map(e => e.count));
  const body = `<div class="content prd">
${head(PR.prd, `<span class="hstat"><span class="ver num">${PR.version}</span>${chip(cap(prdInReview.state), 'accent')}${chip(`${PR.blockers.length} blockers`, 'crit', 'block')}</span>`, `Approve ${cur_s.revision}`, 'check')}
<div class="prd-bar">${journey}<div class="toggles"><div class="seg sm">${PR.versions.map(v => `<button aria-selected="${v === PR.version}" class="num">${v}</button>`).join('')}</div><div class="seg sm">${['Brief', 'Full'].map(v => `<button aria-selected="${v === PR.view}">${v}</button>`).join('')}</div></div></div>
<div class="prd-layout">
  <div class="leftcol"><nav class="tile sections" aria-label="Sections">
    <div class="th"><h2>Sections</h2></div>
    <div class="secsum">${chip(`${counts.approved} approved`, 'pass')}${chip(`${counts['in review']} in review`, 'accent')}${chip(`${counts.draft} draft`, 'quiet')}</div>
    <ol>${PR.sections.map(s => `<li class="${s.current ? 'cur' : ''}">${secIcon(s)}<span>${esc(s.name)}</span>${s.revision ? `<span class="rev num">${s.revision}</span>` : ''}</li>`).join('')}</ol>
  </nav>
    <section class="tile comp">
        <div class="th"><h2>Composition</h2></div>
        <div class="pack">${esc(comp.pack)}</div>
        <div class="cbar" aria-hidden="true"><i class="m" style="flex:${comp.mandatory}"></i><i class="on" style="flex:${comp.optional_on}"></i><i class="off" style="flex:${comp.optional_off}"></i></div>
        <ul class="clegend"><li><i class="m"></i>Mandatory<b class="num">${comp.mandatory}</b></li><li><i class="on"></i>Optional on<b class="num">${comp.optional_on}</b></li><li><i class="off"></i>Optional off<b class="num">${comp.optional_off}</b></li><li class="tot">Total<b class="num">${compTot}</b></li></ul>
      </section></div>
  <section class="docw">
    <article class="tile doc">
      <div class="th"><h2 class="doc-h">${esc(cur_s.name)}</h2><span class="rev num">${cur_s.revision}</span></div>
      <ol class="frs">${PR.requirements.map(r => { const [id, ...t] = r.split(' '); return `<li><span class="frid num">${id}</span><p>${esc(t.join(' '))}</p></li>`; }).join('')}</ol>
    </article>
    <div class="docrow">
      <section class="tile claim">
        <div class="th"><h2>Evidence</h2><span class="tcount num">${evidenceTotal}</span></div>
        <blockquote>${esc(PR.claim.text)}</blockquote>
        <div class="claimviz"><div class="cring">${ring(Math.round(PR.claim.confidence * 100), 64, 7, 'c ' + confClass(PR.claim.confidence))}<b class="num">${Math.round(PR.claim.confidence * 100)}%</b></div>
        <ul class="evl">${ev.map(e => `<li><span class="en">${esc(e.source)}</span><span class="eb"><i style="width:${(100 * e.count / evMax).toFixed(0)}%"></i></span><b class="num">${e.count}</b></li>`).join('')}</ul></div>
      </section>

    </div>
  </section>
  <aside class="inspector tile">
    <div class="ins-sec"><div class="th"><h2>Blockers</h2><span class="tcount crit num">${PR.blockers.length}</span></div>
      <ul class="blk">${PR.blockers.map(b => `<li>${ic('block')}<span>${esc(b)}</span></li>`).join('')}</ul></div>
    <div class="ins-sec"><div class="th"><h2>Reviewers</h2></div>
      <ul class="rvw">${PR.reviewers.map(r => `<li><span class="av2">${r.name.split(' ').map(w => w[0]).join('').replace('.', '')}</span><span class="rn">${esc(r.name)}</span>${chip(cap(r.verdict), verdictCls[r.verdict])}</li>`).join('')}</ul></div>
    <div class="ins-sec"><div class="th"><h2>Suggestions</h2><span class="tcount num">${PR.suggestions.length}</span></div>
      <ul class="sgl">${sg}</ul></div>
  </aside>
</div></div>`;
  return page('prd-review', body, 'PRDs');
}

// ---------- ROADMAP ----------
function roadmapScreen() {
  const rm = D.roadmap, snap = rm.from.split(' · ')[0].replace('Priority snapshot ', '');
  const cols = [['now', 'Now'], ['next', 'Next'], ['later', 'Later']];
  const sel = rm.now.find(x => x.state === 'at risk');
  const selTrack = D.tracks.find(t => t.name === sel.track);
  const lane = t => {
    const pct = Math.round(100 * t.done / t.total);
    return `<div class="lane">
    <div class="lh"><h3>${esc(t.name)}</h3><div class="lhm">${chip(cap(t.status), statusCls(t.status))}<span class="prog"><span class="pb"><i style="width:${pct}%"></i></span><b class="num">${t.done}/${t.total}</b></span></div>
    <div class="lhm">${chip(`${t.at_risk} at risk`, t.at_risk ? 'crit' : 'quiet', t.at_risk ? 'alert' : '')}${chip(`${t.slipped} slipped`, t.slipped ? 'warn' : 'quiet')}${t.serves.map(gchip).join('')}</div></div>
    ${cols.map(([k]) => { const it = rm[k].find(x => x.track === t.name);
      if (!it) return `<div class="mcell ${k} empty"><span class="dash">—</span></div>`;
      const isSel = it === sel;
      return `<div class="mcell ${k}"><div class="ms${isSel ? ' sel' : ''}${it.state === 'at risk' ? ' risk' : ''}">${ic('flag')}<b>${esc(it.milestone)}</b><div class="msc">${it.state ? chip(cap(it.state), statusCls(it.state), it.state === 'at risk' ? 'alert' : '') : ''}${it.slipped_from ? chip(`Slipped from ${it.slipped_from}`, 'warn') : ''}</div></div></div>`; }).join('')}
  </div>`;
  };
  const pend = rm.pending.map(pp => { const p = D.prds.find(x => x.name === pp.prd); return `<div class="lane pending">
    <div class="lh"><h3>${esc(p.name)}</h3><div class="lhm"><span class="ver num">${p.version}</span>${chip('Pending publish', 'accent')}</div><div class="lhm">${p.serves.map(gchip).join('')}</div></div>
    <div class="pendrow">${journeyDots(p)}<span class="stage">${esc(p.journey_stage)}</span><span class="num stepof">${p.journey_index}/${D.journey_steps.length}</span>${chip(`${p.blockers} blockers`, 'crit', 'block')}</div>
  </div>`; }).join('');
  const g = goal(selTrack.serves[0]);
  const body = `<div class="content">
${head('Roadmap', `<span class="hstat">${chip(`Snapshot ${snap}`, 'outline')}${chip(`${rm.now.filter(x => x.state === 'at risk').length} at risk`, 'crit', 'alert')}</span>`, 'Roadmap run', 'play')}
<div class="rm-layout">
  <section class="tile rm">
    <div class="rm-head"><span></span>${cols.map(([k, l]) => `<div class="colh ${k}">${l}<b class="num">${rm[k].length}</b></div>`).join('')}</div>
    ${D.tracks.map(lane).join('')}
    ${pend}
  </section>
  <aside class="inspector tile">
    <div class="ins-sec"><div class="th">${ic('flag')}<h2>${esc(sel.milestone)}</h2></div>
      <div class="kv"><span>Track</span><b>${esc(sel.track)}</b></div>
      <div class="kv"><span>At risk</span>${chip(sel.at_risk_item, 'crit', 'alert')}</div>
    </div>
    <div class="ins-sec"><div class="th"><h2>Moves goal</h2></div>
      <div class="gmini">${gchip(g.id)}<b>${esc(g.name)}</b></div>
      <div class="gmini2"><div class="g-ring sm">${ring(pctOfTarget(g), 56, 6, 'prog')}<b class="num">${pctOfTarget(g)}<i>%</i></b></div><div><b class="mid num">${fmt(g.current)}<small> ${g.unit}</small></b><span class="tgt num">${ic('arrowDown', 'ic dir')}${fmt(g.target)} ${g.unit}</span></div>${spark(g, 120, 40)}</div>
    </div>
  </aside>
</div></div>`;
  return page('roadmap', body, 'Roadmap');
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'home.html'), page('home', home(false), 'Home'));
fs.writeFileSync(path.join(OUT, 'requests.html'), requestsScreen());
fs.writeFileSync(path.join(OUT, 'prd-review.html'), prdScreen());
fs.writeFileSync(path.join(OUT, 'roadmap.html'), roadmapScreen());
console.log('built', { needTotal, unique, pct: D.goals.map(pctOfTarget), d: D.goals.map(delta6m), evidenceTotal });
