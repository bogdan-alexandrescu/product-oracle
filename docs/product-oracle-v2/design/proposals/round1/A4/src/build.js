// A4 Calm: builds the four screens from quillfield.json. Every figure on screen is read
// from the data file or computed from it here.
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..');
const D = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const T = JSON.parse(fs.readFileSync(path.join(OUT, 'tokens.json'), 'utf8'));

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const goal = id => D.goals.find(g => g.id === id);
const sum = a => a.reduce((x, y) => x + y, 0);
const round1 = n => Math.round(n * 10) / 10;

// ---------- tokens to CSS ----------
const kebab = s => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
const vars = o => Object.entries(o).map(([k, v]) => `--${kebab(k)}:${v}`).join(';');
const CSS_VARS = `:root{${vars(T.color.light)}}
@media (prefers-color-scheme: dark){:root{${vars(T.color.dark)}}}
:root[data-theme=dark]{${vars(T.color.dark)}}`;

// ---------- icons ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  requests: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12.5h5"/>',
  baseline: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  prds: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  priorities: '<path d="M4 6h10M4 12h7M4 18h4M17 4v16M14 17l3 3 3-3"/>',
  roadmap: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  merge: '<path d="M6 4v5a5 5 0 0 0 5 5h7M15 11l3 3-3 3M6 20v-6"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/>',
};
const ic = (n, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

// ---------- small charts ----------
function spark(values, w = 112, h = 36) {
  const min = Math.min(...values), max = Math.max(...values), pad = 4;
  const x = i => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = v => (max === min ? h / 2 : pad + ((max - v) * (h - 2 * pad)) / (max - min));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(last).toFixed(1)}" cy="${y(values[last]).toFixed(1)}" r="3.5" fill="var(--accent)"/></svg>`;
}
function bars(values, w, h, labelLast = true) {
  const max = Math.max(...values), gap = 6, bw = (w - gap * (values.length - 1)) / values.length;
  const top = labelLast ? 20 : 0;
  const r = values.map((v, i) => {
    const bh = ((h - top) * v) / max, x = i * (bw + gap), y = h - bh;
    const lastBar = i === values.length - 1;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${lastBar ? 'var(--accent)' : 'var(--bar)'}"/>` +
      (lastBar && labelLast ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" class="svgnum">${v}</text>` : '');
  }).join('');
  return `<svg class="bars" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${r}</svg>`;
}
const ring = (p, size = 44, label = true) => `<span class="ring" style="--p:${p};--s:${size}px">${label ? `<b class="num">${p}</b>` : ''}</span>`;
const meter = (done, total) => `<span class="meter"><i style="width:${((done / total) * 100).toFixed(1)}%"></i></span><span class="num mt">${done}/${total}</span>`;

const NAV = [['home', 'Home'], ['requests', 'Requests'], ['baseline', 'Baseline'], ['prds', 'PRDs'], ['priorities', 'Priorities'], ['roadmap', 'Roadmap'], ['runs', 'Runs'], ['inbox', 'Inbox']];
const needsTotal = sum(Object.values(D.needs_you).map(a => a.length));

function shell({ page, title, status, action, body, mobileTabs = true }) {
  const rail = NAV.map(([k, l]) => `<a href="#"${k === page ? ' aria-current="page"' : ''}>${ic(k)}<span>${l}</span>${k === 'inbox' ? `<em class="num">${needsTotal}</em>` : ''}</a>`).join('');
  const tabs = [['home', 'Home'], ['requests', 'Requests'], ['prds', 'PRDs'], ['inbox', 'Inbox'], ['more', 'More']]
    .map(([k, l]) => `<a href="#"${k === page ? ' aria-current="page"' : ''}>${ic(k)}<span>${l}</span>${k === 'inbox' ? `<em class="num">${needsTotal}</em>` : ''}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Oracle · ${esc(title)} · A4 Calm</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap">
<style>
${CSS_VARS}
${fs.readFileSync(path.join(__dirname, 'calm.css'), 'utf8')}
</style>
</head>
<body class="p-${page}">
<div class="app">
<nav class="rail" aria-label="Main"><div class="logo">O</div>${rail}<span class="sp"></span><a href="#">${ic('settings')}<span>Settings</span></a><div class="me">${esc(D.viewer.initials)}</div></nav>
<main class="main">
<header class="top"><div class="tl"><h1>${esc(title)}</h1>${status}</div><div class="tr">${action}</div></header>
${body}
</main>
</div>
${mobileTabs ? `<nav class="tabs" aria-label="Main">${tabs}</nav>` : ''}
</body>
</html>
`;
}

// ---------- goal formatting ----------
function fmtVal(g, v) {
  if (g.unit === '%') return `${v}<small>%</small>`;
  if (g.unit === 'min') return `${v}<small>min</small>`;
  return `${v}`;
}
function fmtPlain(g, v) {
  if (g.unit === '%') return `${v}%`;
  if (g.unit === 'min') return `${v} min`;
  return `${v}`;
}
function gap(g) {
  const d = round1(Math.abs(g.target - g.current));
  return g.unit === '%' ? `${d} pts` : g.unit === 'min' ? `${d} min` : `${d}`;
}
function delta6(g) {
  const d = round1(g.current - g.trend_6m[0]);
  const good = g.better === 'up' ? d > 0 : d < 0;
  return { txt: `${d > 0 ? '+' : '−'}${Math.abs(d)}`, good };
}
const pct = c => Math.round(c * 100);
const goalChip = id => id ? `<span class="gid">${id}</span>` : `<span class="gid none">No goal</span>`;
const stateChip = s => {
  const m = { 'on track': 'pass', drifting: 'warn', 'at risk': 'warn', 'in review': 'info', published: 'pass', confirmed: 'pass', proposed: 'na',
    Qualified: 'pass', New: 'info', Merged: 'na', Disqualified: 'crit', approved: 'pass', draft: 'na', 'changes requested': 'warn', pending: 'na', open: 'info', accepted: 'pass', rejected: 'crit' };
  const lbl = s.charAt(0).toUpperCase() + s.slice(1);
  return `<span class="chip c-${m[s] || 'na'}">${esc(lbl)}</span>`;
};

// =====================================================================
// HOME
// =====================================================================
function home() {
  const goalsHtml = D.goals.map(g => {
    const d = delta6(g);
    return `<div class="goal">
  <div class="gn">${goalChip(g.id)}<span>${esc(g.name)}</span></div>
  <div class="gv"><b class="big num">${fmtVal(g, g.current)}</b><span class="tgt num">${ic('arrow', 'ic s')}${fmtPlain(g, g.target)}</span></div>
  <div class="gc">${spark(g.trend_6m)}<span class="conf">${ring(pct(g.confidence), 40)}</span></div>
  <div class="gf"><span class="num"><b>${gap(g)}</b> to go</span><span class="dl num ${d.good ? 'good' : 'bad'}">${d.txt} <span>6 mo</span></span>${g.status === 'proposed' ? stateChip('proposed') : ''}</div>
</div>`;
  }).join('');

  const tip = `<div class="tip" role="tooltip"><b>Confidence</b><span>How strongly Oracle's evidence supports each goal's current figure, in percent.</span></div>`;

  // needs you: one line each, its action on the right
  const N = D.needs_you;
  const prod = c => c.split(' · ')[0];
  const items = [
    [N.decisions[0], 'Approve'],
    [N.decisions[2], 'Decide'],
    [N.reviews[0], 'Review'],
    [N.questions[1], 'Answer'],
  ];
  const kindsCount = [['Decisions', N.decisions.length], ['Reviews', N.reviews.length], ['Questions', N.questions.length]];
  const needsRows = items.map(([it, act]) => `<li><span class="kind">${esc(it.kind)}</span><b class="ti">${esc(it.title)}</b><span class="ctx">${esc(prod(it.context))}</span><span class="cost num">${it.kind === 'Overrun' || it.kind === 'Cost approval' ? esc(it.cost) : ''}</span><span class="age num">${esc(it.age)}</span><button class="btn sm${act === 'Approve' ? ' pri' : ''}">${act}</button></li>`).join('');

  // tracks + PRD in review
  const prd = D.prds.find(p => p.state === 'in review');
  const steps = D.journey_steps;
  const jdots = steps.map((s, i) => `<i class="${i + 1 < prd.journey_index ? 'd' : i + 1 === prd.journey_index ? 'now' : ''}" title="${esc(s)}"></i>`).join('');
  const trackRows = D.tracks.map(t => `<tr><th>${esc(t.name)}</th><td>${stateChip(t.status)}</td><td><span class="ms"><i class="lime"></i>${esc(t.now_milestone)}</span></td><td class="prog">${meter(t.done, t.total)}</td><td class="num">${t.at_risk ? `<span class="risk">${t.at_risk} at risk</span>` : '<span class="zero">0<span class="mo"> at risk</span></span>'}</td><td>${t.serves.map(goalChip).join(' ')}</td></tr>`).join('') +
    `<tr class="prd"><th>${esc(prd.name)} <span class="ver">${esc(prd.version)}</span></th><td>${stateChip(prd.state)}</td><td><span class="ms"><i class="lime"></i>${esc(prd.journey_stage)}</span></td><td class="prog"><span class="jdots">${jdots}</span><span class="num mt">${prd.journey_index}/${steps.length}</span></td><td class="num"><span class="risk">${prd.blockers} blockers</span></td><td>${prd.serves.map(goalChip).join(' ')}</td></tr>`;

  // requests
  const R = D.requests;
  const themes = R.themes.slice(0, 4);
  const tmax = Math.max(...R.themes.map(t => t.count));
  const themeRows = themes.map(t => `<li><span class="tn">${esc(t.name)}</span><span class="tb"><i style="width:${((t.count / tmax) * 100).toFixed(1)}%"></i></span><b class="num">${t.count}</b>${goalChip(t.goal)}</li>`).join('');

  const body = `<div class="col">
<section class="sec goals"><div class="lab"><h2>Goals <button class="ib" aria-label="About confidence" aria-expanded="true">${ic('info')}</button></h2>${tip}</div><div class="goalrow">${goalsHtml}</div></section>
<section class="sec needs"><div class="lab"><h2>Needs you</h2><ul class="kinds">${kindsCount.map(([k, n]) => `<li><b class="num">${n}</b><span>${k}</span></li>`).join('')}</ul><a class="more" href="#">All ${needsTotal} ${ic('arrow', 'ic s')}</a></div><div><ul class="nrows">${needsRows}</ul></div></section>
<section class="sec tracks"><div class="lab"><h2>Tracks</h2></div><div class="tw"><table class="tt"><thead><tr><th></th><th>Status</th><th>Now</th><th>Done</th><th>At risk</th><th>Goals</th></tr></thead><tbody>${trackRows}</tbody></table></div></section>
<section class="sec reqs"><div class="lab"><h2>Requests</h2></div><div class="rq">
  <div class="rnew"><b class="big num">${R.new_this_week}</b><span>New this week</span><ul class="rmini"><li><b class="num">${R.open}</b> Open</li><li><b class="num">${R.unreviewed}</b> Unreviewed</li></ul></div>
  <div class="rtrend">${bars(R.weekly_new_8w, 232, 84)}<span class="axis"><span>8 wk ago</span><span>This wk</span></span></div>
  <div class="rthemes"><h3>Top themes</h3><ul>${themeRows}</ul></div>
</div></section>
</div>`;
  return shell({
    page: 'home', title: 'Home',
    status: `<span class="chip c-plain">${esc(D.company)}</span>`,
    action: `<button class="btn pri">${ic('plus')}New idea</button>`, body,
  });
}

// =====================================================================
// REQUESTS
// =====================================================================
function requests() {
  const R = D.requests;
  const states = [['All', R.open], ['New', R.unreviewed], ['Qualified', R.qualified], ['Merged', R.merged_duplicates], ['Disqualified', R.disqualified]];
  const srcTotal = sum(Object.values(R.by_source));
  const srcColors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
  const src = Object.entries(R.by_source);
  const tmax = Math.max(...R.themes.map(t => t.count));
  const themeRows = R.themes.map(t => `<li><span class="tn">${esc(t.name)}</span><span class="tb"><i style="width:${((t.count / tmax) * 100).toFixed(1)}%"></i></span><b class="num">${t.count}</b>${goalChip(t.goal)}<span class="tp">${t.prd ? `${ic('prds', 'ic s')}${esc(t.prd)}` : '<span class="dash">—</span>'}</span></li>`).join('');
  const rows = R.rows.map(r => {
    let out;
    if (r.state === 'Qualified') out = `${ic('prds', 'ic s')}${esc(r.linked)}`;
    else if (r.state === 'Merged') out = `${ic('merge', 'ic s')}${esc(r.merged_into)}`;
    else if (r.state === 'Disqualified') out = `<span class="why">${esc(r.reason)}</span>`;
    else out = `<span class="acts"><button class="btn sm pri">Qualify</button><button class="btn sm">Disqualify</button></span>`;
    return `<tr class="${r.state === 'Merged' ? 'merged' : ''}"><th>${esc(r.title)}</th><td>${esc(r.source)}</td><td class="num r">${r.mentions}</td><td>${goalChip(r.goal)}</td><td>${stateChip(r.state)}</td><td class="out">${out}</td></tr>`;
  }).join('');
  const body = `<div class="col">
<section class="sec rtop"><div class="rblock"><h2>Themes</h2><ul class="themes">${themeRows}</ul></div>
<div class="rblock"><h2>Sources</h2><div class="stack">${src.map(([k, v], i) => `<i style="flex:${v};background:${srcColors[i]}"></i>`).join('')}</div>
<ul class="legend">${src.map(([k, v], i) => `<li><i style="background:${srcColors[i]}"></i><span>${esc(k)}</span><b class="num">${v}</b></li>`).join('')}</ul>
<h2 class="mt2">New per week</h2>${bars(R.weekly_new_8w, 300, 72)}<span class="axis"><span>8 wk ago</span><span>This wk</span></span></div></section>
<section class="sec rlist"><div class="filters" role="tablist">${states.map(([k, n], i) => `<button role="tab" aria-selected="${i === 0}">${k} <b class="num">${n}</b></button>`).join('')}</div>
<table class="rt"><thead><tr><th>Request</th><th>Source</th><th class="r">Mentions</th><th>Goal</th><th>State</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot num">${R.rows.length} of ${R.open}</div></section>
</div>`;
  return shell({
    page: 'requests', title: 'Requests',
    status: `<span class="chip c-plain num">${R.open} open</span>`,
    action: `<button class="btn pri">${ic('plus')}Add request</button>`, body,
  });
}

// =====================================================================
// PRD REVIEW
// =====================================================================
function prdReview() {
  const V = D.prd_review;
  const prd = D.prds.find(p => p.name === V.prd);
  const steps = D.journey_steps;
  const journey = steps.map((s, i) => {
    const n = i + 1, cls = n < prd.journey_index ? 'd' : n === prd.journey_index ? 'now' : '';
    return `<li class="${cls}"><i class="num">${cls === 'd' ? ic('check', 'ic xs') : n}</i><span>${esc(s)}</span></li>`;
  }).join('');
  const secIc = s => s === 'approved' ? `<i class="st ok">${ic('check', 'ic xs')}</i>` : s === 'in review' ? '<i class="st rv"></i>' : '<i class="st dr"></i>';
  const approved = V.sections.filter(s => s.status === 'approved').length;
  const sections = V.sections.map(s => `<li${s.current ? ' aria-current="true"' : ''}>${secIc(s.status)}<span>${esc(s.name)}</span></li>`).join('');
  const cur = V.sections.find(s => s.current);
  const reviewers = V.reviewers.map(r => `<li><span class="av">${esc(r.name.split(' ').map(x => x[0]).join(''))}</span><span>${esc(r.name)}</span>${stateChip(r.verdict)}</li>`).join('');
  const evTotal = sum(V.claim.evidence.map(e => e.count));
  const evMax = Math.max(...V.claim.evidence.map(e => e.count));
  const sugg = V.suggestions.map(s => {
    let act;
    if (s.state === 'open') act = `<span class="acts"><button class="btn sm pri">${ic('check', 'ic s')}Accept</button><button class="btn sm">${ic('x', 'ic s')}Reject</button></span>`;
    else if (s.state === 'rejected') act = `${stateChip('rejected')}<span class="why">${esc(s.reason)}</span>`;
    else act = stateChip('accepted');
    return `<li class="${s.state}"><div class="sb"><b>${esc(s.by)}</b></div><p>${esc(s.text)}</p><div class="sa">${act}</div></li>`;
  }).join('');
  const openSugg = V.suggestions.filter(s => s.state === 'open').length;
  const C = V.composition;
  const reqs = V.requirements.map(r => { const m = r.match(/^(FR-\d+) (.*)$/); return `<li><span class="id">${m[1]}</span><span>${esc(m[2])}</span></li>`; }).join('');

  const body = `<div class="pv">
<ol class="journey" aria-label="Journey">${journey}</ol>
<div class="pgrid">
<aside class="outline"><h2>Sections <span class="num">${approved}/${V.sections.length}</span></h2><ul class="secs">${sections}</ul>
<h2 class="mt2">Reviewers</h2><ul class="revs">${reviewers}</ul></aside>
<article class="docw">
  <div class="dbar"><div class="seg" aria-label="Version">${V.versions.map(v => `<button aria-pressed="${v === V.version}">${v}</button>`).join('')}</div><div class="seg" aria-label="View">${['Brief', 'Full'].map(v => `<button aria-pressed="${v === V.view}">${v}</button>`).join('')}</div></div>
  <div class="dh"><h2>${esc(cur.name)}</h2><span class="rev">${cur.revision}</span>${stateChip(cur.status)}</div>
  <div class="blockers"><h3>${ic('flag', 'ic s')}<span class="num">${V.blockers.length}</span> Blockers</h3><ul>${V.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>
  <p class="claimline"><mark class="claim">${esc(V.claim.text)}</mark></p>
  <ol class="frs">${reqs}</ol>
</article>
<aside class="insp">
  <section><h2>Evidence <span class="ringw">${ring(pct(V.claim.confidence), 40)}</span></h2>
  <ul class="ev">${V.claim.evidence.map(e => `<li><span>${esc(e.source)}</span><span class="tb"><i style="width:${((e.count / evMax) * 100).toFixed(1)}%"></i></span><b class="num">${e.count}</b></li>`).join('')}</ul>
  <div class="evt"><span>Total</span><b class="num">${evTotal}</b></div></section>
  <section><h2>Suggestions <span class="cnt num">${openSugg} open</span></h2><ul class="sugg">${sugg}</ul></section>
  <section><h2>Composition</h2><div class="pack">${esc(C.pack)}</div>
  <ul class="comp"><li><b class="num">${C.mandatory}</b><span>Mandatory</span></li><li><b class="num">${C.optional_on}</b><span>Optional on</span></li><li><b class="num">${C.optional_off}</b><span>Optional off</span></li></ul></section>
</aside>
</div></div>`;
  return shell({
    page: 'prds', title: `${V.prd}`,
    status: `<span class="chip c-plain">${esc(V.version)}</span>${stateChip(prd.state)}`,
    action: `<button class="btn pri">${ic('check')}Approve ${esc(cur.revision)}</button>`, body,
  });
}

// =====================================================================
// ROADMAP
// =====================================================================
function roadmap() {
  const M = D.roadmap;
  const tracks = D.tracks;
  const cell = (list, t, col) => {
    const it = list.find(x => x.track === t.name);
    if (!it) return '<div class="cell empty"><span class="dash">—</span></div>';
    const sel = it.state === 'at risk';
    const chips = [];
    if (it.state === 'at risk') chips.push(stateChip('at risk'));
    else if (it.state) chips.push(stateChip(it.state));
    if (it.slipped_from) chips.push(`<span class="chip c-warn">Slipped from ${esc(it.slipped_from)}</span>`);
    return `<div class="cell${col === 'now' ? ' now' : ''}${sel ? ' sel' : ''}"><b>${esc(it.milestone)}</b><span class="chips">${chips.join('')}</span>${it.at_risk_item ? `<span class="ri">${ic('flag', 'ic s')}${esc(it.at_risk_item)}</span>` : ''}</div>`;
  };
  const rows = tracks.map(t => `<div class="trow"><div class="th"><b>${esc(t.name)}</b><span class="tm">${meter(t.done, t.total)}</span><span class="tg">${t.serves.map(goalChip).join(' ')}</span></div>${cell(M.now, t, 'now')}${cell(M.next, t, 'next')}${cell(M.later, t, 'later')}</div>`).join('');
  const pend = M.pending.map(p => `<div class="trow pend"><div class="th"><b>${esc(p.prd)}</b><span class="tg">${D.prds.find(x => x.name === p.prd).serves.map(goalChip).join(' ')}</span></div><div class="pendcell"><span class="chip c-info">Pending publish</span><span class="pl">Joins after publish</span></div></div>`).join('');

  const t = tracks.find(x => x.at_risk);
  const now = M.now.find(x => x.track === t.name);
  const g = goal(t.serves[0]);
  const d = delta6(g);
  const insp = `<aside class="insp rinsp">
  <div class="ih"><span class="cap">${esc(t.name)}</span><h2>${esc(now.milestone)}</h2><span class="chips">${stateChip('at risk')}</span></div>
  <dl class="kv">
    <div><dt>At risk</dt><dd>${ic('flag', 'ic s')}${esc(t.at_risk_item)}</dd></div>
    <div><dt>Track</dt><dd>${stateChip(t.status)}</dd></div>
    <div><dt>Done</dt><dd class="prog">${meter(t.done, t.total)}</dd></div>
    <div><dt>Slipped</dt><dd class="num">${t.slipped}</dd></div>
  </dl>
  <div class="ig"><div class="gn">${goalChip(g.id)}<span>${esc(g.name)}</span></div>
  <div class="gv"><b class="big num">${fmtVal(g, g.current)}</b><span class="tgt num">${ic('arrow', 'ic s')}${fmtPlain(g, g.target)}</span></div>
  <div class="gc">${spark(g.trend_6m, 150, 40)}${ring(pct(g.confidence), 40)}</div>
  <div class="gf"><span class="num"><b>${gap(g)}</b> to go</span><span class="dl num ${d.good ? 'good' : 'bad'}">${d.txt} <span>6 mo</span></span></div></div>
</aside>`;

  const body = `<div class="rmw"><div class="rm">
<div class="rhead"><div></div><div class="h now"><i class="lime"></i>Now <span class="num">${M.now.length}</span></div><div class="h">Next <span class="num">${M.next.length}</span></div><div class="h">Later <span class="num">${M.later.length}</span></div></div>
${rows}${pend}
</div>${insp}</div>`;
  return shell({
    page: 'roadmap', title: 'Roadmap',
    status: `<span class="chip c-plain">Snapshot ${esc(M.from.split(' · ')[0].replace('Priority snapshot ', ''))}</span>`,
    action: `<button class="btn pri">${ic('runs')}Start roadmap run</button>`, body,
  });
}

fs.writeFileSync(path.join(OUT, 'home.html'), home());
fs.writeFileSync(path.join(OUT, 'requests.html'), requests());
fs.writeFileSync(path.join(OUT, 'prd-review.html'), prdReview());
fs.writeFileSync(path.join(OUT, 'roadmap.html'), roadmap());
console.log('built');
