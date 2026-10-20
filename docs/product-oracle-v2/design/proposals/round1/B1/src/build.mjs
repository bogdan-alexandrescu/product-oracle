// B1 Split generator. Every number, name and state below is read or derived from quillfield.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..');
const dataPath = process.env.QUILLFIELD || path.join(here, 'quillfield.json');
const D = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const css = fs.readFileSync(path.join(here, 'b1.css'), 'utf8');

// ---------- helpers ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = n => Math.round(n * 10) / 10;
const fmt = n => { const v = r1(n); return Number.isInteger(v) ? String(v) : v.toFixed(1); };
const signed = n => (r1(n) > 0 ? '+' : r1(n) < 0 ? '−' : '') + fmt(Math.abs(n));
const goal = id => D.goals.find(g => g.id === id);
const pct = (a, b) => Math.round((a / b) * 100);

const ICON = {
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  requests: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  baseline: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  prds: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  priorities: '<path d="M5 6h14M5 12h9M5 18h5"/>',
  roadmap: '<path d="M4 6h6M4 12h10M4 18h16"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/>',
  runs: '<circle cx="12" cy="12" r="8"/><path d="M10 9l5 3-5 3z"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  flag: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.7-1.6M12 6.5v11"/>',
  pause: '<circle cx="12" cy="12" r="8"/><path d="M10 9v6M14 9v6"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M9 13l2 2 4-4"/>',
  comment: '<path d="M4 5h16v11h-9l-5 4v-4H4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v4"/>',
  ask: '<circle cx="12" cy="12" r="8"/><path d="M9.8 9.5a2.3 2.3 0 114 1.6c-.8.6-1.8 1.1-1.8 2.4M12 16.5v.5"/>',
  track: '<path d="M4 18h16M4 12h10M4 6h6"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  merge: '<path d="M7 4v6a4 4 0 004 4h6M14 11l3 3-3 3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  slip: '<path d="M4 12h12M12 7l5 5-5 5M20 5v14"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

function sparkline(values, target, w, h, opts = {}) {
  const all = [...values, target];
  const min = Math.min(...all), max = Math.max(...all);
  const pad = 4, sx = (w - 2 * pad - 6) / (values.length - 1);
  const y = v => pad + (h - 2 * pad) * (1 - (v - min) / (max - min || 1));
  const pts = values.map((v, i) => [pad + i * sx, y(v)]);
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const area = `M${pts[0][0]},${h} L${pts.map(p => p.join(',')).join(' L')} L${pts.at(-1)[0]},${h} Z`;
  const ty = y(target).toFixed(1);
  const last = pts.at(-1);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="6 month trend ${values.join(', ')}; target ${target}">
<path d="${area}" fill="var(--spark-fill)"/>
<line x1="0" x2="${w}" y1="${ty}" y2="${ty}" stroke="var(--text2)" stroke-width="1.5" stroke-dasharray="4 4"/>
<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

function ring(p, size, stroke, label, tone = 'accent', fs = 14) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const col = tone === 'warn' ? 'var(--warn)' : tone === 'pass' ? 'var(--pass)' : 'var(--accent)';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}">
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="${stroke}"/>
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${fs}" fill="var(--text)">${Math.round(p * 100)}</text></svg>`;
}
const confTone = c => (c < 0.5 ? 'warn' : 'accent');

function bars(values, w, h, gap = 4) {
  const max = Math.max(...values), bw = (w - gap * (values.length - 1)) / values.length;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Weekly new requests, last 8 weeks: ${values.join(', ')}">` +
    values.map((v, i) => {
      const bh = Math.max(3, (v / max) * (h - 2));
      const last = i === values.length - 1;
      return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${last ? 'var(--accent)' : 'var(--accent-mid)'}"/>`;
    }).join('') + '</svg>';
}

const steps = D.journey_steps;
const jmini = idx => `<span class="jmini" aria-label="Journey ${idx} of ${steps.length}">${steps.map((s, i) => `<i class="${i + 1 < idx ? 'd' : i + 1 === idx ? 'c' : ''}"></i>`).join('')}</span>`;

const NAV = ['Home', 'Requests', 'Baseline', 'PRDs', 'Priorities', 'Roadmap', 'Runs', 'Inbox'];
const needs = D.needs_you;
const allNeeds = [...needs.decisions, ...needs.reviews, ...needs.questions];
const nNeeds = allNeeds.length;

function shell(active, title, body, tabs = '') {
  const rail = NAV.map(n => `<a href="#"${n === active ? ' aria-current="page"' : ''}>${icon(n.toLowerCase())}${n}${n === 'Inbox' ? `<span class="badge num">${nNeeds}</span>` : ''}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>B1 Split · ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap">
<style>
${css}
</style>
</head>
<body>
<div class="app">
<nav class="rail" aria-label="Main"><div class="logo">Q</div>${rail}<span class="sp"></span><a href="#">${icon('settings')}Settings</a><div class="me" title="${esc(D.viewer.name)}">${esc(D.viewer.initials)}</div></nav>
<div class="main">
${body}
</div>
</div>
${tabs}
</body>
</html>
`;
}

function topbar(title, status, primary, primaryIcon = 'plus') {
  return `<header class="top"><h1>${title}</h1>${status}<span class="grow"></span><a class="btn primary" href="#">${icon(primaryIcon)}${primary}</a></header>`;
}

// ---------- HOME ----------
function goalTile(g, withTip) {
  const unit = g.unit === '%' ? '%' : '';
  const unitWord = g.unit === '%' ? '' : g.unit;
  const delta = g.trend_6m.at(-1) - g.trend_6m[0];
  const toGo = Math.abs(g.target - g.current);
  const improving = g.better === 'up' ? delta > 0 : delta < 0;
  return `<div class="goal">
  <div class="gname"><span class="gid${g.status === 'proposed' ? ' prop' : ''}">${g.id}</span><span>${esc(g.name)}</span></div>
  <div class="gnum"><div class="numeral">${fmt(g.current)}<small>${unit}</small></div><div class="gtarget">/ ${fmt(g.target)}${unit}${unitWord ? ` <span>${unitWord}</span>` : ''}</div><span class="grow"></span><div class="gring">${ring(g.confidence, 42, 5, `Confidence ${Math.round(g.confidence * 100)}`, confTone(g.confidence))}</div></div>
  <div class="gspark">${sparkline(g.trend_6m, g.target, 196, 40)}</div>
  <div class="gfoot"><span class="${improving ? 'up' : 'down'}">${signed(delta)} <span>6m</span></span><span><b>${fmt(toGo)}</b> to go</span></div>
</div>`;
}

function home() {
  const tip = `<span class="info open" aria-expanded="true">i<span class="tip" role="tooltip"><b>Confidence</b>: how well the evidence supports each goal figure. <b>Dashed line</b>: target.</span></span>`;
  const confirmed = D.goals.filter(g => g.status === 'confirmed').length;
  const proposed = D.goals.length - confirmed;
  const goalsPanel = `<section class="panel goals" aria-label="Goals">
  <div class="ph"><h2>Goals</h2><span class="chip pass num">${confirmed} confirmed</span>${D.goals.filter(g => g.status === 'proposed').map(g => `<span class="chip warn">${g.id} proposed</span>`).join('')}<span class="grow"></span><span class="legend"><svg width="22" height="4"><line x1="0" x2="22" y1="2" y2="2" stroke="var(--text2)" stroke-width="1.5" stroke-dasharray="4 4"/></svg>Target</span><span class="legend"><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--accent)" stroke-width="3"/></svg>Confidence</span>${tip}</div>
  <div class="gstrip">${D.goals.map(g => goalTile(g)).join('')}</div>
</section>`;

  const R = D.requests;
  const topThemes = R.themes.filter(t => t.goal).slice(0, 3);
  const maxT = Math.max(...R.themes.map(t => t.count));
  const reqPanel = `<section class="panel reqs" aria-label="Requests">
  <div class="ph"><h2>Requests</h2><span class="chip line num">${R.open} open</span><span class="grow"></span><a class="btn sec" href="#">Triage <b class="num">${R.unreviewed}</b></a></div>
  <div class="rflow"><div><div class="numeral">${R.new_this_week}</div><div class="cap">New this week</div></div><div class="rbars">${bars(R.weekly_new_8w, 200, 56)}<div class="cap rb-cap"><span>8w</span><span>now</span></div></div></div>
  <ul class="themes">${topThemes.map(t => `<li><span class="tn">${esc(t.name)}</span><span class="bar"><i style="width:${pct(t.count, maxT)}%"></i></span><b class="num">${t.count}</b><span class="gid">${t.goal}</span></li>`).join('')}</ul>
</section>`;

  const kindIcon = { 'Checkpoint': 'flag', 'Cost approval': 'coin', 'Overrun': 'pause', 'Approval': 'doc', 'Comments': 'comment', 'Interview': 'mic', 'Asked you': 'ask' };
  const action = { 'Checkpoint': 'Decide', 'Cost approval': 'Approve', 'Overrun': 'Decide', 'Approval': 'Review', 'Comments': 'Resolve', 'Interview': 'Answer', 'Asked you': 'Answer' };
  const forOf = n => n.context.split(' · ')[0];
  const runOf = n => (n.context.split(' · ')[1] || '').replace('run ', '');
  const costCell = n => {
    if (!n.cost) return '';
    const m = n.cost.match(/^(\$[\d.]+) of (\$[\d.]+)$/);
    return `<span class="cost">${m ? `${m[1]} / ${m[2]}` : n.cost.replace(' estimate', ' est.')}</span>`;
  };
  const needRow = n => `<div class="tr need"><span class="kind">${icon(kindIcon[n.kind])}<span class="kt">${n.kind}</span>${n.from ? `<span class="av" title="${esc(n.from)}">${n.from.split(' ').map(s => s[0]).join('')}</span>` : ''}</span><span class="t">${esc(n.title)}${n.cost ? ' ' + costCell(n) : ''}</span><span class="for">${esc(forOf(n))}</span><span class="run mono">${runOf(n)}</span><span class="age num r">${n.age}</span><span class="r"><a class="btn sec${n === allNeeds[0] ? ' solid' : ''}" href="#">${action[n.kind]}</a></span></div>`;

  const prd = D.prds.find(p => p.state === 'in review');
  const trackRow = t => {
    const tone = t.status === 'on track' ? 'pass' : 'warn';
    const risk = t.at_risk ? `<span class="chip crit num">${t.at_risk} at risk</span>` : '<span class="muted">—</span>';
    const slip = t.slipped ? `<span class="chip warn num">${t.slipped} slipped</span>` : '';
    return `<div class="tr mov"><span class="t">${esc(t.name)}</span><span><span class="chip ${tone}"><span class="dot"></span>${cap(t.status)}</span></span><span class="nx">${esc(t.now_milestone)}</span><span class="meter"><span class="bar"><i style="width:${pct(t.done, t.total)}%"></i></span><b class="num">${t.done}/${t.total}</b></span><span class="risk">${risk}${slip}</span><span class="gl">${t.serves.map(s => `<span class="gid">${s}</span>`).join(' ')}</span></div>`;
  };
  const prdRow = `<div class="tr mov sel"><span class="t">${esc(prd.name)} <span class="mono vv">${prd.version}</span></span><span><span class="chip acc"><span class="dot"></span>In review</span></span><span class="nx"><span class="chip now">${prd.journey_stage}</span></span><span class="meter">${jmini(prd.journey_index)}<b class="num">${prd.journey_index}/${steps.length}</b></span><span class="risk"><span class="chip crit num">${prd.blockers} blockers</span></span><span class="gl">${prd.serves.map(s => `<span class="gid">${s}</span>`).join(' ')}</span></div>`;

  const kinds = [['Decisions', needs.decisions.length], ['Reviews', needs.reviews.length], ['Questions', needs.questions.length]];
  const table = `<section class="panel work" aria-label="Waiting and moving">
  <div class="ph"><h2>Needs you</h2><span class="n num">${nNeeds}</span><span class="kcounts">${kinds.map(([k, n]) => `<span class="chip line num">${k} <b>${n}</b></span>`).join('')}</span><span class="grow"></span><a class="link" href="#">Inbox ${icon('arrow', 'sm')}</a></div>
  ${allNeeds.map(needRow).join('')}
  <div class="tr head mov movh"><span class="mh"><h2>Moving</h2><span class="n num">${D.tracks.length + 1}</span></span><span>Status</span><span>Next</span><span>Done</span><span>Risk</span><span>Goals</span></div>
  ${D.tracks.map(trackRow).join('')}
  ${prdRow}
</section>`;

  // inspector: the selected row, Online deposits at booking (PRD in review)
  const pr = D.prd_review;
  const secCount = s => pr.sections.filter(x => x.status === s).length;
  const forPrd = allNeeds.filter(n => n.context.startsWith('Online deposits'));
  const forKinds = [['Decisions', needs.decisions], ['Reviews', needs.reviews], ['Questions', needs.questions]].map(([k, arr]) => [k, arr.filter(n => forPrd.includes(n)).length]);
  const verdictChip = v => v === 'approved' ? '<span class="chip pass">Approved</span>' : v === 'changes requested' ? '<span class="chip warn">Changes</span>' : '<span class="chip">Pending</span>';
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="ihtop"><span class="cap">PRD · selected</span><a class="btn sec hb" href="#">Open</a></div><h3>${esc(prd.name)}</h3><div class="chips"><span class="chip mono">${prd.version}</span><span class="chip">In review</span></div></div>
  <div class="is"><div class="jt">${steps.map((s, i) => `<i class="${i + 1 < prd.journey_index ? 'd' : i + 1 === prd.journey_index ? 'c' : ''}" title="${s}"></i>`).join('')}</div><div class="jlab"><span>${steps[0]}</span><b>${prd.journey_stage}</b><span>${steps.at(-1)}</span></div></div>
  <div class="big3"><div><div class="numeral crit">${prd.blockers}</div><div class="cap">Blockers</div></div><div><div class="numeral">${secCount('approved')}<small>/${pr.sections.length}</small></div><div class="cap">Sections done</div></div><div><div class="numeral">${forPrd.length}</div><div class="cap">Waiting</div></div></div>
  <div class="is"><div class="cap capl"><span>Sections</span><span class="seclg">${[['ok', 'Approved', 'approved'], ['rv', 'In review', 'in review'], ['dr', 'Draft', 'draft']].map(([c, l, k]) => `<span><i class="${c}"></i>${l} <b class="num">${secCount(k)}</b></span>`).join('')}</span></div><div class="secs">${pr.sections.map(s => `<i class="${s.status === 'approved' ? 'ok' : s.status === 'in review' ? 'rv' : 'dr'}" title="${esc(s.name)}"></i>`).join('')}</div></div>
  <div class="is"><div class="cap">Reviewers</div><div class="revs">${pr.reviewers.map(r => `<span class="rv1"><span class="av" title="${esc(r.name)}">${r.name.split(' ').map(s => s[0]).join('')}</span>${verdictChip(r.verdict)}</span>`).join('')}</div></div>
  <div class="is"><div class="cap">Blockers</div><ul class="ilist">${pr.blockers.map(b => `<li><span class="bl">${icon('alert', 'sm')}</span><span class="grow">${esc(b)}</span></li>`).join('')}</ul></div>
</aside>`;

  const homeCss = `<style>
.home{display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-areas:"goals reqs" "work insp";gap:16px;align-items:start}
.goals{grid-area:goals}.reqs{grid-area:reqs;align-self:stretch;display:flex;flex-direction:column}.work{grid-area:work}.insp{grid-area:insp}
.legend{display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--text2);margin-right:6px}
.gstrip{display:grid;grid-template-columns:repeat(4,1fr)}
.goal{padding:10px 16px 10px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:6px;min-width:0}
.goal:last-child{border-right:0}
.gname{display:flex;gap:8px;align-items:flex-start;font-weight:600;line-height:20px;min-height:40px}
.gname .gid{margin-top:-2px}
.gnum{display:flex;align-items:flex-end;gap:6px}
.gnum .numeral{font-size:38px;line-height:40px}
.gnum{gap:5px}
.gtarget{font:500 15px/20px 'Inter',sans-serif;color:var(--text2);padding-bottom:4px;white-space:nowrap}
.gtarget span{font-size:14px}
.gnum .grow{flex:1}
.gspark svg{display:block;width:100%}
.gfoot{display:flex;gap:12px;align-items:center;font-size:14px;color:var(--text2);white-space:nowrap;min-height:26px}
.gfoot b{color:var(--text);font-weight:600}
.gfoot .up,.gfoot .down{color:var(--pass);font-weight:600}
.gfoot .up span,.gfoot .down span{color:var(--text2);font-weight:400}
.rflow{display:flex;align-items:flex-end;gap:20px;padding:12px 16px 10px}
.rflow .numeral{font-size:44px;line-height:44px}
.rbars{flex:1}.rbars svg{display:block;width:100%}
.rb-cap{display:flex;justify-content:space-between;margin-top:4px}
.themes{padding:0 16px 10px;margin-top:auto}
.themes li{display:grid;grid-template-columns:minmax(0,1fr) 80px 24px 34px;gap:10px;align-items:center;height:30px}
.themes .tn{white-space:nowrap;overflow:hidden}
.themes b{text-align:right;font-weight:600}
.ph .link{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--accent-ink)}
.kcounts{display:flex;gap:6px;margin-left:6px}
.kcounts b,.kmini b{font-weight:700;color:var(--text)}
.ph.sub{border-top:1px solid var(--line);margin-top:-1px}
.tr.need{grid-template-columns:150px minmax(0,1fr) 168px 44px 40px 84px;min-height:42px}
.tr.mov{grid-template-columns:minmax(0,1fr) 104px 128px 130px 150px 56px;column-gap:12px}
.tr.movh{min-height:48px;border-top:1px solid var(--line)}
.tr.movh .mh{display:flex;align-items:center;gap:10px;color:var(--text)}
.tr.movh h2{font:700 18px/1 'Bricolage Grotesque',sans-serif;letter-spacing:-.01em;color:var(--text)}
.tr.movh .n{font:700 18px/1 'Bricolage Grotesque',sans-serif;color:var(--accent-ink)}
.gid.prop{background:var(--warn-bg);color:var(--warn)}
.ihtop{display:flex;align-items:center;justify-content:space-between}
.ih .hb{background:transparent;color:var(--hero-text);border-color:var(--hero-text2)}
.revs{display:flex;justify-content:space-between}.rv1{display:flex;align-items:center;gap:8px}
.tr.mov .t{display:flex;align-items:center;gap:8px}
.tr.mov .t .ic{color:var(--text2)}
.vv{font-size:13px;color:var(--text2)}
.for{white-space:nowrap;color:var(--text)}
.run{color:var(--text2);font-size:13px}
.age{color:var(--text2)}
.risk{display:flex;gap:6px}
.muted{color:var(--text2)}
.gl{display:flex;gap:4px}
.kt{color:var(--text)}
.meter .jmini{flex:none}
.secs{display:grid;grid-template-columns:repeat(${pr.sections.length},1fr);gap:4px}
.secs i,.seclg i{display:block;height:14px;border-radius:4px}
.secs .ok,.seclg .ok{background:var(--pass)}.secs .rv,.seclg .rv{background:var(--accent)}.secs .dr,.seclg .dr{background:var(--surface2);box-shadow:inset 0 0 0 1px var(--line-strong)}
.seclg{display:flex;gap:10px;white-space:nowrap;font:400 14px/16px 'Inter',sans-serif;color:var(--text2);letter-spacing:0}
.capl{justify-content:space-between}
.seclg span{display:flex;align-items:center;gap:6px}.seclg i{width:12px;height:12px}
.seclg b{color:var(--text);font-weight:600}
.bl{color:var(--crit);display:grid}
.home .insp .is{padding:12px 20px}.home .insp .ih{padding:14px 20px 16px}.home .big3>div{padding:12px 0 10px 20px}
.iact{display:flex;align-items:center;gap:8px}.iact .kmini{display:flex;gap:6px;flex:1;flex-wrap:wrap}
@media (max-width:600px){
  .home{grid-template-columns:1fr;grid-template-areas:"goals" "work" "reqs";gap:12px}
  .insp,.legend,.ph .info,.kcounts,.ph .link{display:none}
  .gstrip{grid-template-columns:1fr 1fr}
  .goal{border-bottom:1px solid var(--line)}
  .goal:nth-child(2n){border-right:0}.goal:nth-child(n+3){border-bottom:0}
  .goal{padding:10px 12px}
  .gname{font-size:14px;line-height:19px;min-height:38px}
  .gnum .numeral{font-size:30px;line-height:32px}
  .gnum{flex-wrap:wrap;row-gap:0}.gtarget{order:3;width:100%;font-size:14px;padding:0}
  .gring svg{width:36px;height:36px}
  .gfoot{font-size:13px;gap:8px}.gfoot .chip{display:none}
  .gspark svg{height:34px}
  .tr{padding:0 12px;column-gap:10px}
  .tr.need{grid-template-columns:22px minmax(0,1fr) auto}
  .tr.need .kt,.tr.need .av,.tr.need .for,.tr.need .run,.tr.need .age{display:none}
  .tr.need .t{white-space:normal;line-height:20px;padding:10px 0}
  .tr.mov{grid-template-columns:minmax(0,1fr) auto 40px}
  .tr.mov .t{white-space:normal;line-height:20px;padding:10px 0}
  .tr.movh{grid-template-columns:1fr}.tr.movh>:not(.mh){display:none}
  .tr.mov>:nth-child(3),.tr.mov>:nth-child(5),.tr.mov>:nth-child(6){display:none}
  .tr.mov .meter .bar,.tr.mov .meter .jmini,.tr.mov .t .ic,.tr.mov .vv{display:none}
  .work>.ph:first-child{flex-wrap:wrap;height:auto;padding:12px 16px;row-gap:10px}
  .ph .kcounts-m{display:flex;width:100%;order:5}
  .rflow .numeral{font-size:40px}
  .themes li{grid-template-columns:minmax(0,1fr) 60px 24px 34px}
}
.kcounts-m{display:none;gap:6px}
</style>`;
  const status = `<span class="chip acc num">${nNeeds} waiting</span>`;
  const tabs = `<nav class="tabs" aria-label="Main">${[['Home', 'home'], ['Requests', 'requests'], ['PRDs', 'prds'], ['Inbox', 'inbox'], ['More', 'settings']].map(([n, i]) => `<a href="#"${n === 'Home' ? ' aria-current="page"' : ''}>${icon(i)}${n}${n === 'Inbox' ? `<span class="badge num">${nNeeds}</span>` : ''}</a>`).join('')}</nav>`;
  const body = topbar('Home', status, 'New idea') + homeCss + `<div class="home">${goalsPanel}${reqPanel}${table.replace('<span class="grow"></span><a class="link"', `<span class="kcounts-m">${kinds.map(([k, n]) => `<span class="chip line num">${k} <b>${n}</b></span>`).join('')}</span><span class="grow"></span><a class="link"`)}${insp}</div>`;
  return shell('Home', 'Home', body, tabs);
}
const cap = s => s[0].toUpperCase() + s.slice(1);

// ---------- REQUESTS ----------
function requests() {
  const R = D.requests;
  const srcTotal = Object.values(R.by_source).reduce((a, b) => a + b, 0);
  const srcTone = ['var(--accent)', 'var(--accent-mid)', 'var(--pass)', 'var(--warn)'];
  const sources = Object.entries(R.by_source);
  const maxT = Math.max(...R.themes.map(t => t.count));
  const strip = `<section class="panel rstrip" aria-label="Sources and themes">
  <div class="src"><div class="cap">Sources <b class="num">${srcTotal}</b></div>
    <div class="stack">${sources.map(([k, v], i) => `<i style="flex:${v};background:${srcTone[i]}" title="${k} ${v}"></i>`).join('')}</div>
    <ul class="slg">${sources.map(([k, v], i) => `<li><i style="background:${srcTone[i]}"></i>${k}<b class="num">${v}</b></li>`).join('')}</ul>
    <div class="dup">${icon('merge', 'sm')}<span>Merged duplicates</span><b class="num">${R.merged_duplicates}</b></div>
  </div>
  <div class="thm"><div class="cap">Themes</div>
    <ul>${R.themes.map(t => `<li><span class="tn">${esc(t.name)}</span><span class="bar"><i style="width:${pct(t.count, maxT)}%"></i></span><b class="num">${t.count}</b><span>${t.goal ? `<span class="gid">${t.goal}</span>` : '<span class="muted">—</span>'}</span><span class="tp">${t.prd ? esc(t.prd) : ''}</span></li>`).join('')}</ul>
  </div>
</section>`;
  const filters = [['All', R.open], ['New', R.unreviewed], ['Qualified', R.qualified], ['Merged', R.merged_duplicates], ['Disqualified', R.disqualified]];
  const stateChip = s => ({ Qualified: 'pass', Merged: 'acc', New: 'warn', Disqualified: 'crit' })[s];
  const maxM = Math.max(...R.rows.map(r => r.mentions));
  // merged rows nest directly under the request they were merged into
  const ordered = [];
  R.rows.filter(r => !r.merged_into).forEach(r => { ordered.push(r); R.rows.filter(m => m.merged_into === r.title).forEach(m => ordered.push(m)); });
  const sel = R.rows[0];
  const row = r => `<div class="tr rq${r === sel ? ' sel' : ''}${r.merged_into ? ' child' : ''}"><span class="t">${r.merged_into ? `<span class="mg">${icon('merge', 'sm')}</span>` : ''}${esc(r.title)}</span><span>${r.source}</span><span class="meter"><span class="bar"><i style="width:${pct(r.mentions, maxM)}%"></i></span><b class="num">${r.mentions}</b></span><span>${r.goal ? `<span class="gid">${r.goal}</span>` : '<span class="muted">—</span>'}</span><span><span class="chip ${stateChip(r.state)}">${r.state}</span></span><span class="oc">${r.linked ? `${icon('prds', 'sm')}${esc(r.linked)}` : r.reason ? `<span class="chip line">${esc(r.reason)}</span>` : r.merged_into ? '' : `<a class="btn sec" href="#">Qualify</a>`}</span></div>`;
  const table = `<section class="panel" aria-label="Requests table">
  <div class="ph"><nav class="seg" aria-label="State">${filters.map(([k, n], i) => `<a href="#"${i === 0 ? ' aria-current="true"' : ''}>${k} <b class="num">${n}</b></a>`).join('')}</nav><span class="grow"></span><a class="btn sec" href="#">${icon('filter', 'sm')}Source</a><a class="btn sec" href="#">${icon('filter', 'sm')}Goal</a></div>
  <div class="tr head rq"><span>Request</span><span>Source</span><span>Mentions</span><span>Goal</span><span>State</span><span>Outcome</span></div>
  ${ordered.map(row).join('')}
  <div class="tr foot"><span class="muted num">${R.rows.length} of ${R.open}</span></div>
</section>`;

  const g = goal(sel.goal);
  const merged = R.rows.filter(m => m.merged_into === sel.title);
  const theme = R.themes.find(t => t.prd === sel.linked);
  const prd = D.prds.find(p => p.name === sel.linked);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Request · selected</div><h3>${esc(sel.title)}</h3><div class="chips"><span class="chip">${sel.state}</span><span class="chip">${sel.source}</span></div></div>
  <div class="big3 two"><div><div class="numeral">${sel.mentions}</div><div class="cap">Mentions</div></div><div><div class="numeral">${merged.length}</div><div class="cap">Merged</div></div></div>
  <div class="is"><div class="cap">Goal</div><div class="ig"><span class="gid">${g.id}</span><span class="grow">${esc(g.name)}</span>${ring(g.confidence, 44, 5, 'Confidence', confTone(g.confidence))}</div>
    <div class="ig2"><div class="numeral">${fmt(g.current)}<small>${g.unit === '%' ? '%' : ''}</small></div><span class="gt">/ ${fmt(g.target)}${g.unit === '%' ? '%' : ''}</span>${sparkline(g.trend_6m, g.target, 200, 44)}</div></div>
  <div class="is"><div class="cap">Linked PRD</div><div class="ig"><span class="grow"><b>${esc(prd.name)}</b> <span class="mono vv">${prd.version}</span></span><span class="chip now">${prd.journey_stage}</span></div><div class="ij">${jmini(prd.journey_index)}<b class="num">${prd.journey_index}/${steps.length}</b></div></div>
  <div class="is"><div class="cap">Theme</div><div class="ig"><span class="grow">${esc(theme.name)}</span><b class="num">${theme.count}</b></div></div>
  <div class="is"><div class="cap">Merged in</div><ul class="ilist">${merged.map(m => `<li>${icon('merge', 'sm')}<span class="grow">${esc(m.title)}</span><span class="muted">${m.source}</span><b class="num">${m.mentions}</b></li>`).join('')}</ul></div>
  <div class="is iact"><a class="btn sec" href="#">Change goal</a><a class="btn sec" href="#">Disqualify</a></div>
</aside>`;
  const pageCss = `<style>
.split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.left{display:flex;flex-direction:column;gap:16px;min-width:0}
.rstrip{display:grid;grid-template-columns:270px minmax(0,1fr)}
.src{padding:14px 16px;border-right:1px solid var(--line)}
.src .cap b,.thm .cap b{color:var(--text);font-weight:700}
.stack{display:flex;gap:3px;height:14px;margin:10px 0 12px}.stack i{border-radius:4px}
.slg{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
.slg li{display:flex;align-items:center;gap:8px}.slg li i{width:10px;height:10px;border-radius:3px}.slg b{margin-left:auto;font-weight:600}
.dup{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}.dup .ic{color:var(--accent-ink)}.dup b{margin-left:auto;font-weight:700;font-size:18px}
.thm{padding:14px 16px}
.thm li{display:grid;grid-template-columns:186px 64px 22px 34px minmax(0,1fr);gap:12px;align-items:center;height:30px}
.thm .tn{white-space:nowrap}.thm b{text-align:right;font-weight:600}
.thm .chip{height:24px}
.tp{display:flex;align-items:center;gap:6px;white-space:nowrap;color:var(--text)}.tp .ic{color:var(--text2)}
.tr.rq{grid-template-columns:minmax(0,1fr) 80px 84px 36px 108px 214px;column-gap:12px}
.tr.rq .meter .bar{min-width:0;max-width:44px}
.tr.rq .t{display:flex;align-items:center;gap:8px}
.tr.child .t{padding-left:22px}
.mg{color:var(--accent-ink);display:grid}
.oc{display:flex;align-items:center;gap:6px;white-space:nowrap}.oc .ic{color:var(--text2)}
.tr.foot{min-height:40px}
.muted{color:var(--text2)}
.vv{font-size:13px;color:var(--text2)}
.ig{display:flex;align-items:center;gap:10px}
.ig2{display:flex;align-items:flex-end;gap:8px;margin-top:8px}.ig2 .gt{color:var(--text2);padding-bottom:4px;flex:1}
.ij{display:flex;align-items:center;gap:10px;margin-top:8px}
.ilist .ic{color:var(--accent-ink)}
.iact{display:flex;gap:8px}
.big3.two{grid-template-columns:1fr 1fr}
</style>`;
  const body = topbar('Requests', `<span class="chip acc num">${R.new_this_week} new</span>`, 'Add request') + pageCss + `<div class="split"><div class="left">${strip}${table}</div>${insp}</div>`;
  return shell('Requests', 'Requests', body);
}

// ---------- PRD REVIEW ----------
function prdReview() {
  const pr = D.prd_review;
  const prd = D.prds.find(p => p.name === pr.prd);
  const cur = pr.sections.find(s => s.current);
  const journey = `<div class="journey" aria-label="PRD journey">${steps.map((s, i) => `<span class="${i + 1 < prd.journey_index ? 'd' : i + 1 === prd.journey_index ? 'c' : ''}"><i>${i + 1 < prd.journey_index ? '✓' : i + 1}</i>${s}</span>`).join('')}</div>`;
  const tools = `<div class="tools">${journey}<span class="grow"></span><nav class="seg" aria-label="Version">${pr.versions.map(v => `<a href="#"${v === pr.version ? ' aria-current="true"' : ''}><span class="mono">${v}</span></a>`).join('')}</nav><nav class="seg" aria-label="View">${['Brief', 'Full'].map(v => `<a href="#"${v === pr.view ? ' aria-current="true"' : ''}>${v}</a>`).join('')}</nav></div>`;
  const stChip = s => s === 'approved' ? `<span class="chip pass">${icon('check', 'sm')}Approved</span>` : s === 'in review' ? '<span class="chip acc">In review</span>' : '<span class="chip">Draft</span>';
  const comp = pr.composition;
  const compTotal = comp.mandatory + comp.optional_on + comp.optional_off;
  const sections = `<section class="panel secs" aria-label="Sections">
  <div class="ph"><h2>Sections</h2><span class="n num">${pr.sections.length}</span></div>
  ${pr.sections.map(s => `<div class="tr sc${s.current ? ' sel' : ''}"><span class="t">${esc(s.name)}</span>${stChip(s.status)}</div>`).join('')}
  <div class="ph sub"><h2>Composition</h2><span class="n num">${compTotal}</span></div>
  <div class="comp"><div class="cpack">${esc(comp.pack)}</div>
    <div class="cbar"><i class="m" style="flex:${comp.mandatory}"></i><i class="on" style="flex:${comp.optional_on}"></i><i class="off" style="flex:${comp.optional_off}"></i></div>
    <ul class="clg"><li><i class="m"></i>Mandatory<b class="num">${comp.mandatory}</b></li><li><i class="on"></i>Optional on<b class="num">${comp.optional_on}</b></li><li><i class="off"></i>Optional off<b class="num">${comp.optional_off}</b></li></ul></div>
</section>`;
  const claimRow = `<div class="tr fr claim sel"><span class="mono id">Claim</span><span class="txt">${esc(pr.claim.text)}</span><span class="r ca">${icon('arrow', 'sm')}</span></div>`;
  const reqs = pr.requirements.map(t => { const m = t.match(/^(FR-\d+) (.*)$/); return `<div class="tr fr"><span class="mono id">${m[1]}</span><span class="txt">${esc(m[2])}</span><span></span></div>`; });
  const sugState = s => s.state === 'open' ? `<a class="btn sec solid" href="#">${icon('check', 'sm')}Accept</a><a class="btn sec" href="#">Reject</a>` : s.state === 'accepted' ? `<span class="chip pass">${icon('check', 'sm')}Accepted</span>` : `<span class="chip crit">Rejected</span><span class="chip line">${esc(s.reason)}</span>`;
  const openSug = pr.suggestions.filter(s => s.state === 'open').length;
  const doc = `<section class="panel doc" aria-label="Section">
  <div class="ph"><h2>${esc(cur.name)}</h2><span class="chip mono">${cur.revision}</span><span class="chip acc">In review</span></div>
  ${reqs[0]}${claimRow}${reqs.slice(1).join('')}
  <div class="ph sub"><h2>Suggestions</h2><span class="n num">${pr.suggestions.length}</span><span class="chip warn num">${openSug} open</span></div>
  ${pr.suggestions.map(s => `<div class="tr sg"><span class="by"><span class="av">${s.by.startsWith('Oracle') ? 'O' : s.by.split(' ').map(x => x[0]).join('')}</span>${esc(s.by)}</span><span class="txt">${esc(s.text)}</span><span class="act">${sugState(s)}</span></div>`).join('')}
</section>`;
  const evTotal = pr.claim.evidence.reduce((a, e) => a + e.count, 0);
  const evMax = Math.max(...pr.claim.evidence.map(e => e.count));
  const verdictChip = v => v === 'approved' ? '<span class="chip pass">Approved</span>' : v === 'changes requested' ? '<span class="chip warn">Changes</span>' : '<span class="chip">Pending</span>';
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Claim · selected</div><h3>${esc(pr.claim.text)}</h3><div class="ihr"><div class="cring">${ring(pr.claim.confidence, 64, 7, 'Confidence', 'accent', 18).replace('fill="var(--text)"', 'fill="var(--hero-text)"').replace('stroke="var(--surface2)"', 'stroke="var(--hero-line)"').replace('stroke="var(--accent)"', 'stroke="var(--lime)"')}</div><div><div class="hnum num">${evTotal}</div><div class="cap">Evidence items</div></div></div></div>
  <div class="is"><div class="cap">Sources</div><ul class="ev">${pr.claim.evidence.map(e => `<li><span class="grow">${esc(e.source)}</span><span class="bar"><i style="width:${pct(e.count, evMax)}%"></i></span><b class="num">${e.count}</b></li>`).join('')}</ul></div>
  <div class="is"><div class="cap">Reviewers</div><ul class="ilist">${pr.reviewers.map(r => `<li><span class="av">${r.name.split(' ').map(s => s[0]).join('')}</span><span class="grow">${esc(r.name)}</span>${verdictChip(r.verdict)}</li>`).join('')}</ul></div>
  <div class="is"><div class="cap">Blockers <span class="chip crit num">${pr.blockers.length}</span></div><ul class="ilist">${pr.blockers.map(b => `<li><span class="bl">${icon('alert', 'sm')}</span><span class="grow">${esc(b)}</span></li>`).join('')}</ul></div>
</aside>`;
  const pageCss = `<style>
.tools{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.cols{display:grid;grid-template-columns:276px minmax(0,1fr) 372px;gap:16px;align-items:start}
.tr.sc{grid-template-columns:minmax(0,1fr) auto;min-height:42px}
.tr.sc .t{white-space:normal;line-height:20px;padding:8px 0}
.ph.sub{border-top:1px solid var(--line)}
.comp{padding:12px 16px 14px}
.cpack{font-weight:600}
.cbar{display:flex;gap:3px;height:14px;margin:10px 0}.cbar i{border-radius:4px}
.cbar .m,.clg .m{background:var(--accent)}.cbar .on,.clg .on{background:var(--accent-mid)}.cbar .off,.clg .off{background:var(--surface2);box-shadow:inset 0 0 0 1px var(--line-strong)}
.clg li{display:flex;align-items:center;gap:8px;height:26px}.clg i{width:10px;height:10px;border-radius:3px}.clg b{margin-left:auto;font-weight:600}
.tr.fr{grid-template-columns:52px minmax(0,1fr) 40px;padding-top:10px;padding-bottom:10px;align-items:start}
.tr.fr .id{font-size:13px;color:var(--text2);padding-top:1px}
.tr.claim{align-items:center}.tr.claim .id{color:var(--accent-ink)}
.tr.claim .txt{font-weight:600}
.tr.sg{grid-template-columns:150px minmax(0,1fr) auto;padding-top:9px;padding-bottom:9px}
.by{display:flex;align-items:center;gap:8px;white-space:nowrap;font-weight:500}
.act{display:flex;gap:6px;justify-content:flex-end}
.ihr{display:flex;align-items:center;gap:16px}
.hnum{font:700 28px/32px 'Bricolage Grotesque',sans-serif}.hnum span{font:500 15px 'Inter',sans-serif;color:var(--hero-text2)}
.tr.claim .ca{color:var(--accent-ink);display:grid;justify-content:end}
.ev li{display:grid;grid-template-columns:minmax(0,1fr) 64px 22px;gap:10px;align-items:center;height:34px}.ev b{text-align:right;font-weight:600}
.bl{color:var(--crit);display:grid}
</style>`;
  const body = topbar(`${esc(prd.name)} <span class="mono tv">${prd.version}</span>`, `<span class="chip acc">In review</span>`, `Approve ${cur.revision}`, 'check').replace('<h1>', '<h1 class="ptitle">') +
    `<style>.tv{font-size:20px;color:var(--text2);font-weight:500}</style>` + pageCss + tools + `<div class="cols">${sections}${doc}${insp}</div>`;
  return shell('PRDs', 'PRD review', body);
}

// ---------- ROADMAP ----------
function roadmap() {
  const RM = D.roadmap;
  const snap = RM.from.split(' · ')[0].replace('Priority snapshot ', '');
  const tracks = D.tracks.map(t => t.name);
  const cell = (col, track) => RM[col].filter(x => x.track === track).map(x => {
    const atRisk = x.state === 'at risk';
    const tone = x.state === 'on track' ? 'pass' : atRisk ? 'crit' : '';
    return `<div class="ms ${col}${atRisk ? ' risk' : ''}"><div class="mt">${esc(x.milestone)}</div><div class="mc">${x.state ? `<span class="chip ${tone}"><span class="dot"></span>${cap(x.state)}</span>` : ''}${x.at_risk_item ? `<span class="chip line">${icon('alert', 'sm')}${esc(x.at_risk_item)}</span>` : ''}${x.slipped_from ? `<span class="chip warn">${icon('slip', 'sm')}Slipped from ${x.slipped_from}</span>` : ''}</div></div>`;
  }).join('') || '<span class="muted">—</span>';
  const sel = D.tracks.find(t => t.at_risk);
  const row = name => {
    const t = D.tracks.find(x => x.name === name);
    const tone = t.status === 'on track' ? 'pass' : 'warn';
    return `<div class="tr rm${t === sel ? ' sel' : ''}"><div class="tk"><div class="tn">${esc(t.name)}</div><div class="tm"><span class="chip ${tone}"><span class="dot"></span>${cap(t.status)}</span><span class="meter"><span class="bar"><i style="width:${pct(t.done, t.total)}%"></i></span><b class="num">${t.done}/${t.total}</b></span>${t.serves.map(s => `<span class="gid">${s}</span>`).join('')}</div></div><div>${cell('now', name)}</div><div>${cell('next', name)}</div><div>${cell('later', name)}</div></div>`;
  };
  const pend = RM.pending.map(p => { const pp = D.prds.find(x => x.name === p.prd); return `<div class="tr rm pend"><div class="tk"><div class="tn">${esc(p.prd)} <span class="mono vv">${pp.version}</span></div><div class="tm"><span class="chip acc">${cap(pp.state)}</span>${pp.serves.map(s => `<span class="gid">${s}</span>`).join('')}</div></div><div class="pspan"><span class="chip line">${icon('prds', 'sm')}Pending publish</span>${jmini(pp.journey_index)}<b class="num">${pp.journey_index}/${steps.length}</b></div></div>`; }).join('');
  const table = `<section class="panel" aria-label="Roadmap">
  <div class="tr head rm"><span>Track</span><span><span class="chip now">Now</span> <b class="num">${RM.now.length}</b></span><span>Next <b class="num">${RM.next.length}</b></span><span>Later <b class="num">${RM.later.length}</b></span></div>
  ${tracks.map(row).join('')}
  ${pend}
</section>`;
  const g = goal(sel.serves[0]);
  const prd = D.prds.find(p => p.name === sel.name);
  const theme = D.requests.themes.find(t => t.prd === sel.name);
  const nowM = RM.now.find(x => x.track === sel.name);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Track · selected</div><h3>${esc(sel.name)}</h3><div class="chips"><span class="chip">${cap(sel.status)}</span><span class="chip mono">${prd.version}</span><span class="chip">${cap(prd.state)}</span></div></div>
  <div class="big3"><div><div class="tring">${ring(sel.done / sel.total, 56, 6, `${sel.done} of ${sel.total} done`, 'accent', 15)}</div><div class="cap num">${sel.done}/${sel.total} done</div></div><div><div class="numeral crit">${sel.at_risk}</div><div class="cap">At risk</div></div><div><div class="numeral warn">${sel.slipped}</div><div class="cap">Slipped</div></div></div>
  <div class="is"><div class="cap">Now</div><div class="ig"><b class="grow">${esc(nowM.milestone)}</b></div><div class="ig mt8">${icon('alert', 'sm')}<span class="grow">${esc(nowM.at_risk_item)}</span><span class="chip crit">At risk</span></div></div>
  <div class="is"><div class="cap">Goal</div><div class="ig"><span class="gid">${g.id}</span><span class="grow">${esc(g.name)}</span>${ring(g.confidence, 44, 5, 'Confidence', confTone(g.confidence))}</div>
    <div class="ig2"><div class="numeral">${fmt(g.current)}</div><span class="gt">/ ${fmt(g.target)} ${g.unit}</span>${sparkline(g.trend_6m, g.target, 180, 44)}</div></div>
  <div class="is"><div class="cap">Requests</div><div class="ig"><span class="grow">${esc(theme.name)}</span><span class="gid">${theme.goal}</span><b class="num">${theme.count}</b></div></div>
  <div class="is iact"><a class="btn sec" href="#">Open track</a><a class="btn sec" href="#">Milestones</a></div>
</aside>`;
  const pageCss = `<style>
.split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:16px;align-items:start}
.tr.rm{grid-template-columns:270px repeat(3,minmax(0,1fr));align-items:stretch;column-gap:0;padding:0}
.tr.rm>*{padding:18px 16px;border-right:1px solid var(--line)}
.tr.rm>*:last-child{border-right:0}
.tr.head.rm>*{display:flex;align-items:center;gap:8px;padding:8px 16px}
.tr.head.rm b{color:var(--text);font-weight:700}
.tk .tn{font:700 18px/23px 'Bricolage Grotesque',sans-serif}
.tm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.tm .meter{width:120px}
.ms{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface)}
.ms.now{border-color:var(--line-strong)}
.ms.risk{border-color:var(--crit);box-shadow:inset 3px 0 0 var(--crit)}
.ms .mt{font-weight:600}
.mc{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.mc:empty{display:none}
.mc .ic{color:var(--crit)}
.mc .chip.warn .ic{color:var(--warn)}
.tr.pend .pspan{grid-column:2 / span 3;display:flex;align-items:center;gap:12px;background:repeating-linear-gradient(135deg,transparent 0 10px,var(--surface2) 10px 12px)}
.tr.pend .pspan b{font-weight:600}
.tr.pend .pspan .chip{background:var(--surface)}
.muted{color:var(--text2)}
.vv{font-size:13px;color:var(--text2)}
.tring{height:36px;display:flex;align-items:center}.tring svg{width:44px;height:44px;margin-top:-6px}
.big3 .cap{margin-top:2px}
.ig{display:flex;align-items:center;gap:10px}.mt8{margin-top:8px}.ig .ic{color:var(--crit)}
.ig2{display:flex;align-items:flex-end;gap:8px;margin-top:8px}.ig2 .gt{color:var(--text2);padding-bottom:4px;flex:1;white-space:nowrap}
.iact{display:flex;gap:8px}
</style>`;
  const atRisk = RM.now.filter(x => x.state === 'at risk').length;
  const body = topbar('Roadmap', `<span class="chip line mono">${snap}</span><span class="chip crit num">${atRisk} at risk</span>`, 'Derive roadmap', 'roadmap') + pageCss + `<div class="split">${table}${insp}</div>`;
  return shell('Roadmap', 'Roadmap', body);
}

fs.writeFileSync(path.join(out, 'home.html'), home());
fs.writeFileSync(path.join(out, 'requests.html'), requests());
fs.writeFileSync(path.join(out, 'prd-review.html'), prdReview());
fs.writeFileSync(path.join(out, 'roadmap.html'), roadmap());
console.log('built');
