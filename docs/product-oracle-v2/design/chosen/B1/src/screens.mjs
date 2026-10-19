// B1 Split, round 2: the seven screens added in round 2, plus PRD review and roadmap reworked.
import { critCount, D, esc, fmt, goal, pct, cap, initials, toGoHtml, curTxt, icon, sparkline, ring, confTone, steps, jmini, jbar, statusChip, gid, goalBlock, shell, topbar, verdictChip, splitParen, blockerLi, needs, allNeeds } from './build.mjs';

const LOW = 0.6; // a feature-goal link under 0.6 counts as low confidence (baseline.low_confidence_links)

// ---------- BASELINE ----------
export function baseline() {
  const B = D.baseline;
  const feats = D.features;
  const lowLinks = feats.flatMap(f => Object.values(f.serves)).filter(v => v < LOW).length;
  const kpi = [
    [`${B.confirmed_goals}<small>/${B.goals}</small>`, 'Goals confirmed'],
    [`${B.features_traced}<small>/${B.features}</small>`, 'Features traced'],
    [B.evidence_items, 'Evidence items'],
    [B.sources, 'Sources'],
    [lowLinks, 'Low-confidence links', 'warn'],
  ];
  const strip = `<section class="panel kstrip" aria-label="Baseline counts">${kpi.map(([n, l, t]) => `<div><div class="numeral${t ? ' ' + t : ''}">${n}</div><div class="cap">${l}</div></div>`).join('')}</section>`;
  const sel = feats.find(f => f.state === 'in build');
  const stTone = { shipped: 'pass', 'in build': 'acc', planned: '', proposed: 'warn' };
  const head = `<div class="mx mxh"><div class="mxf"><span class="cap">Feature</span></div><div class="cap">State</div>${D.goals.map(g => `<div class="gh"><div class="ghn">${gid(g.id)} ${esc(g.name)}</div><div class="ghv"><span class="numeral sm">${curTxt(g)}</span><span class="grow"></span>${ring(g.confidence, 36, 4, `Confidence ${Math.round(g.confidence * 100)}`, confTone(g.confidence), 13)}</div><div class="ghg">${toGoHtml(g)}</div>${sparkline(g.trend_6m, g.target, 120, 26)}</div>`).join('')}</div>`;
  const cell = (f, g) => {
    const v = f.serves[g.id];
    if (v == null) return `<div class="mc"><span class="nil"></span></div>`;
    return `<div class="mc">${ring(v, 40, 5, `${f.name} serves ${g.id}: ${Math.round(v * 100)}`, v < LOW ? 'warn' : 'accent', 13)}</div>`;
  };
  const rows = feats.map(f => `<div class="mx${f === sel ? ' sel' : ''}"><div class="mxf"><span class="ell fn">${esc(f.name)}</span>${f.flag ? `<span class="chip crit">Flagged</span>` : ''}</div><div><span class="chip ${stTone[f.state]}">${cap(f.state)}</span></div>${D.goals.map(g => cell(f, g)).join('')}</div>`).join('');
  const matrix = `<section class="panel" aria-label="Feature by goal">
  <div class="ph"><h2>Feature × goal</h2><span class="n num">${feats.length}</span><span class="grow"></span><span class="chip crit num">Flagged ${B.flagged}</span><span class="chip warn num">Conflicts ${B.conflicts}</span><span class="chip acc num">Proposals ${B.proposals}</span></div>
  ${head}${rows}
</section>`;
  const g = goal(Object.keys(sel.serves)[0]);
  const tr = D.tracks.find(t => t.name === sel.name);
  const prd = D.prds.find(p => p.name === sel.name);
  const theme = D.requests.themes.find(t => t.prd === sel.name);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="ihtop"><span class="cap">Feature · selected</span><a class="btn sec hb" href="#">Open</a></div><h3>${esc(sel.name)}</h3><div class="chips"><span class="chip">${cap(sel.state)}</span><span class="chip mono">PRD ${prd.version}</span><span class="chip">${cap(prd.state)}</span></div></div>
  <div class="big3"><div class="r1">${ring(sel.serves[g.id], 46, 6, 'Link strength', 'accent', 14)}<div class="cap">Link to ${g.id}</div></div><div><div class="numeral">${tr.done}<small>/${tr.total}</small></div><div class="cap">Done</div></div><div><div class="numeral crit">${tr.at_risk}</div><div class="cap">At risk</div></div></div>
  <div class="is"><div class="cap">Goal</div>${goalBlock(g)}</div>
  <div class="is"><div class="cap">Track</div><div class="ig"><span class="grow ell"><b>${esc(tr.now_milestone)}</b></span>${statusChip(tr.status)}</div><div class="ig"><span class="bl">${icon('alert', 'sm')}</span><span class="grow ell">${esc(tr.at_risk_item)}</span><span class="chip crit">At risk</span></div></div>
  <div class="is"><div class="cap">Requests</div><div class="ig"><span class="grow ell">${esc(theme.name)}</span>${gid(theme.goal)}<b class="num">${theme.count}</b></div></div>
  <div class="is iact"><a class="btn sec" href="#">Edit links</a><a class="btn sec" href="#">Evidence</a></div>
</aside>`;
  const pageCss = `<style>
.kstrip{display:grid;grid-template-columns:repeat(5,1fr);margin-bottom:16px}
.kstrip>div{padding:12px 18px;border-right:1px solid var(--line)}.kstrip>div:last-child{border-right:0}
.mx{display:grid;grid-template-columns:minmax(0,1fr) 100px repeat(4,134px);align-items:center;column-gap:0;border-bottom:1px solid var(--line);min-height:52px;position:relative}
.mx:last-child{border-bottom:0}
.mx>*{padding:0 12px;min-width:0}
.mx>.mxf{padding-left:16px;display:flex;align-items:center;gap:8px}
.mx .fn{font-weight:500}
.mx.sel{background:var(--accent-soft)}
.mx.sel::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
.mxh{align-items:stretch;background:var(--surface2);min-height:0}
.mxh>.mxf,.mxh>.cap{padding-top:12px}
.mx>.gh{padding:10px 8px 8px 10px;border-left:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
.ghn{font:500 13px/18px 'Inter',sans-serif;min-height:54px;color:var(--text)}.ghn .gid{height:20px;padding:0 5px;margin-right:2px}
.ghv .ring{flex:none}.gh .numeral.sm{font-size:24px;line-height:28px}
.ghv{display:flex;align-items:center;gap:6px}
.ghg .togo{font-size:14px}
.gh .spark{display:block;width:100%}
.mc{border-left:1px solid var(--line);align-self:stretch;display:grid;place-items:center}
.nil{width:6px;height:6px;border-radius:50%;background:var(--line-strong)}
.r1{display:flex;flex-direction:column;gap:2px}.r1 svg{margin:-4px 0 0}
</style>`;
  const body = topbar('Baseline', `<span class="chip line">Snapshot ${esc(B.snapshot)}</span><span class="chip pass num">${B.confirmed_goals} confirmed</span>`, 'Run baseline', 'runs') + pageCss + `<div class="split"><div class="left"><div>${strip}${matrix}</div></div>${insp}</div>`;
  return shell('Baseline', 'Baseline', body, 'More');
}

// ---------- IDEA INTERVIEW ----------
export function interview() {
  const I = D.idea_interview;
  const prd = D.prds.find(p => p.name === I.idea);
  const stepIdx = steps.indexOf(I.step) + 1;
  const wait = I.turns.find(t => t.waiting);
  const item = needs.questions.find(n => n.kind === 'Interview');
  const me = D.viewer;
  const turns = I.turns.map(t => `<div class="turn o${t.waiting ? ' sel' : ''}"><span class="av ora">O</span><div class="bub">${esc(t.q)}</div>${t.waiting ? `<span class="chip warn">${icon('clock', 'sm')}Waiting for you</span>` : ''}</div>${t.a ? `<div class="turn me"><div class="bub">${esc(t.a)}</div><span class="av">${initials(t.by)}</span></div>` : ''}`).join('');
  const qr = ['ask', 'clock', 'user', 'search'];
  const chat = `<section class="panel chat" aria-label="Interview">
  <div class="ph"><h2>Interview</h2><span class="chip acc">${esc(I.asked_by)}</span><span class="grow"></span><span class="jtiny">${jmini(stepIdx)}<b>${esc(I.step)}</b></span></div>
  <div class="turns">${turns}</div>
  <div class="reply"><div class="qr">${I.quick_replies.map((q, i) => `<a class="btn sec" href="#">${icon(qr[i], 'sm')}${esc(q)}</a>`).join('')}</div>
  <div class="composer"><span class="ph2">Answer</span><span class="grow"></span><a class="btn sec solid sendb" href="#" aria-label="Send">${icon('send')}</a></div></div>
</section>`;
  const gaps = I.gaps;
  const gs = prd.serves.map(goal);
  const theme = D.requests.themes.find(t => t.prd === I.idea);
  const people = Object.values(D.people).map(p => p.split(' (')[0]);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Gap · waiting</div><h3>${esc(item.title)}</h3><div class="chips"><span class="chip">${esc(I.step)}</span><span class="chip">${esc(item.age)}</span></div></div>
  <div class="big3"><div><div class="numeral">${gaps.open}</div><div class="cap">Open</div></div><div><div class="numeral">${gaps.answered}</div><div class="cap">Answered</div></div><div><div class="numeral crit">${gaps.critical}</div><div class="cap">Critical</div></div></div>
  <div class="is"><div class="cap">Goals</div>${gs.map(g => `<div class="ig">${gid(g.id)}<span class="grow ell">${esc(g.name)}</span>${toGoHtml(g)}</div>`).join('')}</div>
  <div class="is"><div class="cap">Requests</div><div class="ig"><span class="grow ell">${esc(theme.name)}</span>${gid(theme.goal)}<b class="num">${theme.count}</b></div></div>
  <div class="is"><div class="cap">Ask someone</div>${people.map(p => `<div class="ig"><span class="av">${initials(p)}</span><span class="grow ell">${esc(p)}</span><a class="btn sec" href="#">Ask</a></div>`).join('')}</div>
</aside>`;
  const pageCss = `<style>
.chat{display:flex;flex-direction:column}
.jtiny{display:flex;align-items:center;gap:8px}.jtiny b{font-weight:600}
.turns{padding:16px 20px 8px;display:flex;flex-direction:column;gap:12px}
.turn{display:flex;align-items:flex-end;gap:10px}
.turn.me{justify-content:flex-end}
.bub{max-width:560px;padding:10px 14px;border-radius:14px;background:var(--surface2);font-size:16px;line-height:23px}
.turn.o .bub{border-bottom-left-radius:4px}
.turn.me .bub{background:var(--accent);color:var(--on-accent);border-bottom-right-radius:4px}
.turn.sel .bub{background:var(--hero);color:var(--hero-text);font-weight:600}
.av.ora{background:var(--lime);color:var(--on-lime);border-color:transparent}
.reply{padding:12px 20px 18px;border-top:1px solid var(--line);margin-top:8px}
.qr{display:flex;gap:8px;flex-wrap:wrap}
.qr .btn{height:36px;font-size:15px}.qr .ic{color:var(--accent-ink)}
.composer{display:flex;align-items:center;gap:10px;margin-top:12px;height:52px;border:1.5px solid var(--accent);border-radius:12px;padding:0 6px 0 16px;background:var(--surface)}
.ph2{color:var(--text2)}
.sendb{width:40px;height:40px;padding:0;justify-content:center}
.chat .turns{min-height:430px}
@media (max-width:600px){
  .chat .turns{min-height:0;padding:14px 12px 6px}
  .bub{max-width:270px;font-size:15px;line-height:22px}
  .turn .chip{display:none}
  .reply{padding:12px 12px 14px}
  .qr .btn{height:34px;padding:0 10px}
  .chat .ph .chip{display:none}
}
</style>`;
  const body = topbar(esc(I.idea), `<span class="chip now">${esc(I.step)}</span><span class="chip warn num">${gaps.open} open</span>`, 'Finish interview', 'check') + pageCss + `<div class="split"><div class="left">${chat}</div>${insp}</div>`;
  return shell('PRDs', 'Idea interview', body);
}

// ---------- PRD REVIEW ----------
export function prdReview() {
  const pr = D.prd_review;
  const prd = D.prds.find(p => p.name === pr.prd);
  const cur = pr.sections.find(s => s.current);
  const journey = `<div class="journey" aria-label="PRD journey">${steps.map((s, i) => `<span class="${i + 1 < prd.journey_index ? 'd' : i + 1 === prd.journey_index ? 'c' : ''}"><i>${i + 1 < prd.journey_index ? '✓' : i + 1}</i>${s}</span>`).join('')}</div>`;
  const tools = `<div class="tools">${journey}<span class="grow"></span><nav class="seg" aria-label="Version">${pr.versions.map(v => `<a href="#"${v === pr.version ? ' aria-current="true"' : ''}><span class="mono">${v}</span></a>`).join('')}</nav><nav class="seg" aria-label="View">${['Brief', 'Full'].map(v => `<a href="#"${v === pr.view ? ' aria-current="true"' : ''}>${v}</a>`).join('')}</nav></div>`;
  const approved = pr.sections.filter(s => s.status === 'approved').length;
  const secStrip = `<div class="secstrip"><span class="cap">Sections <b class="num">${approved}/${pr.sections.length}</b></span><nav class="sectabs" aria-label="Sections">${pr.sections.map(s => `<a href="#" class="${s.status === 'approved' ? 'ok' : s.status === 'in review' ? 'rv' : 'dr'}"${s.current ? ' aria-current="true"' : ''}>${s.status === 'approved' ? icon('check', 'sm') : s.status === 'in review' ? icon('dot', 'sm') : ''}${esc(s.name)}</a>`).join('')}</nav></div>`;
  const claim = `<div class="claim sel" aria-label="Claim"><span class="cl">Claim</span><span class="ctext">${esc(pr.claim.text)}</span><span class="ca">${icon('arrow', 'sm')}</span></div>`;
  const reqs = pr.requirements.map(t => { const m = t.match(/^(FR-\d+) (.*)$/); return `<div class="tr fr"><span class="mono id">${m[1]}</span><span class="txt">${esc(m[2])}</span></div>`; }).join('');
  const sugState = s => s.state === 'open' ? `<a class="btn sec solid" href="#">${icon('check', 'sm')}Accept</a><a class="btn sec" href="#">Reject</a>` : s.state === 'accepted' ? `<span class="chip pass">${icon('check', 'sm')}Accepted</span>` : `<span class="chip crit">Rejected</span><span class="chip line">${esc(s.reason)}</span>`;
  const openSug = pr.suggestions.filter(s => s.state === 'open').length;
  const doc = `<section class="panel doc" aria-label="Section">
  <div class="ph"><h2>${esc(cur.name)}</h2><span class="chip mono">${cur.revision}</span><span class="chip acc">In review</span><span class="grow"></span><span class="cap num">${pr.requirements.length} requirements</span></div>
  ${claim}
  ${reqs}
  <div class="ph sub"><h2>Suggestions</h2><span class="n num">${pr.suggestions.length}</span><span class="chip warn num">${openSug} open</span></div>
  ${pr.suggestions.map(s => `<div class="tr sg"><span class="by"><span class="av">${initials(s.by)}</span><span class="bn">${esc(s.by)}</span></span><span class="txt ell">${esc(s.text)}</span><span class="act">${sugState(s)}</span></div>`).join('')}
</section>`;
  const evTotal = pr.claim.evidence.reduce((a, e) => a + e.count, 0);
  const evMax = Math.max(...pr.claim.evidence.map(e => e.count));
  const comp = pr.composition;
  const compTotal = comp.mandatory + comp.optional_on + comp.optional_off;
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Claim · selected</div><div class="ihr">${ring(pr.claim.confidence, 64, 7, 'Confidence', 'accent', 18, true)}<div><div class="hnum num">${evTotal}</div><div class="cap">Evidence items</div></div><div><div class="hnum num">${pr.claim.evidence.length}</div><div class="cap">Sources</div></div></div></div>
  <div class="is"><div class="cap">Sources</div><ul class="ev">${pr.claim.evidence.map(e => `<li><span class="ell">${esc(e.source)}</span><span class="bar"><i style="width:${pct(e.count, evMax)}%"></i></span><b class="num">${e.count}</b></li>`).join('')}</ul></div>
  <div class="is"><div class="cap">Reviewers</div><div class="revs">${pr.reviewers.map(r => `<span class="rv1" title="${esc(r.name)}"><span class="av">${initials(r.name)}</span>${verdictChip(r.verdict)}</span>`).join('')}</div></div>
  <div class="is"><div class="cap">Blockers <span class="chip crit num">${pr.blockers.length}</span><span class="chip crit num">${critCount(pr.blockers)} critical</span></div><ul class="ilist">${pr.blockers.map(blockerLi).join('')}</ul></div>
  <div class="is"><div class="cap">Composition <b class="num cnum">${compTotal}</b></div><div class="ig"><span class="grow ell"><b>${esc(comp.pack)}</b></span></div>
    <div class="cbar"><i class="m" style="flex:${comp.mandatory}"></i><i class="on" style="flex:${comp.optional_on}"></i><i class="off" style="flex:${comp.optional_off}"></i></div>
    <ul class="clg"><li><i class="m"></i>Mandatory<b class="num">${comp.mandatory}</b></li><li><i class="on"></i>Optional on<b class="num">${comp.optional_on}</b></li><li><i class="off"></i>Optional off<b class="num">${comp.optional_off}</b></li></ul></div>
</aside>`;
  const pageCss = `<style>
.tools{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.secstrip{display:flex;align-items:center;gap:12px;margin-bottom:16px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 12px 8px 16px}
.secstrip .cap{white-space:nowrap}
.secstrip .cap b{color:var(--text);font-weight:700}
.sectabs{display:flex;gap:4px}
.sectabs a{display:flex;align-items:center;gap:5px;height:32px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:500;white-space:nowrap;color:var(--text)}
.sectabs a.ok .ic{color:var(--pass)}.sectabs a.dr{color:var(--text2)}
.sectabs a[aria-current]{background:var(--accent);color:var(--on-accent)}
.sectabs a[aria-current] .ic{color:var(--on-accent)}
.revs{display:flex;justify-content:space-between}.rv1{display:flex;align-items:center;gap:6px}
.claim{display:grid;grid-template-columns:64px minmax(0,1fr) 24px;align-items:center;gap:12px;margin:12px 16px 4px;padding:12px 14px;border-radius:10px;background:var(--accent-soft);box-shadow:inset 4px 0 0 var(--accent)}
.claim .cl{font:600 13px/1 'Inter',sans-serif;color:var(--accent-ink);text-transform:uppercase;letter-spacing:.06em}
.claim .ctext{font-weight:600;font-size:16px}
.claim .ca{color:var(--accent-ink);display:grid}
.tr.fr{grid-template-columns:52px minmax(0,1fr);min-height:44px}
.tr.fr .id{font-size:13px;color:var(--text2)}
.tr.fr .txt{white-space:nowrap}
.ph.sub{border-top:1px solid var(--line)}
.tr.sg{grid-template-columns:150px minmax(0,1fr) 250px;min-height:46px}
.by{display:flex;align-items:center;gap:8px;white-space:nowrap;font-weight:500}
.act{display:flex;gap:6px;justify-content:flex-end}
.ev li{display:grid;grid-template-columns:minmax(0,1fr) 64px 24px;gap:10px;align-items:center;height:32px}.ev b{text-align:right;font-weight:600}
.ilist li{min-height:32px}
.cnum{color:var(--text);font-weight:700}
.cbar{display:flex;gap:3px;height:12px;margin:8px 0}.cbar i{border-radius:4px}
.cbar .m,.clg .m{background:var(--accent)}.cbar .on,.clg .on{background:var(--accent-mid)}.cbar .off,.clg .off{background:var(--surface2);box-shadow:inset 0 0 0 1px var(--line-strong)}
.clg{display:flex;justify-content:space-between}.clg li{display:flex;align-items:center;gap:6px;height:24px;font-size:14px;white-space:nowrap}.clg i{width:10px;height:10px;border-radius:3px}.clg b{font-weight:600}
.tv{font-size:20px;color:var(--text2);font-weight:500}
.tools .jm{display:none;align-items:center;gap:8px}.tools .jm b{font-weight:600}
@media (max-width:600px){
  .tools{margin-bottom:10px}
  .journey{display:none}
  .tools .jm{display:flex}
  .secstrip{flex-wrap:wrap;padding:10px 12px;row-gap:8px}
  .sectabs a:not([aria-current]){display:none}
  .secstrip .grow{display:none}
  .claim{grid-template-columns:minmax(0,1fr) 20px;margin:10px 12px 4px}
  .claim .cl{grid-column:1 / -1}
  .tr.fr{grid-template-columns:44px minmax(0,1fr);padding-top:10px;padding-bottom:10px}
  .tr.fr .txt{white-space:normal;line-height:21px}
  .doc>.ph:first-child .cap,.doc>.ph:first-child .chip.acc{display:none}
  .tr.sg{grid-template-columns:28px minmax(0,1fr) auto}
  .tr.sg .bn{display:none}
  .tr.sg .txt{white-space:normal;overflow:visible;line-height:21px;padding:9px 0}
  .tr.sg .act{flex-direction:column;align-items:flex-end;gap:4px;padding:6px 0}
  .tr.sg .act .chip.line{display:none}
  .ih .ihr{gap:14px}
}
</style>`;
  const jm = `<span class="jm">${jmini(prd.journey_index)}<b>${prd.journey_stage}</b><span class="muted num">${prd.journey_index}/${steps.length}</span></span>`;
  const body = topbar(`${esc(prd.name)} <span class="mono tv">${prd.version}</span>`, `<span class="chip acc">In review</span><span class="chip crit num">${pr.blockers.length} blockers</span>`, `Approve ${cur.revision}`, 'check') + pageCss + tools.replace('<span class="grow"></span>', jm + '<span class="grow"></span>') + secStrip + `<div class="split">${doc}${insp}</div>`;
  return shell('PRDs', 'PRD review', body);
}

// ---------- PRIORITIES ----------
export function priorities() {
  const P = D.priorities;
  const sel = P.order[0];
  const hzTone = { Now: 'now', Next: 'acc', Pending: 'line', Unplanned: '' };
  const fitTone = { high: 'pass', medium: 'warn', low: 'crit' };
  const hz = ['Now', 'Next', 'Pending', 'Unplanned'];
  const filters = [['All', P.order.length], ...hz.map(h => [h, P.order.filter(o => o.horizon === h).length])];
  const row = o => `<div class="tr pr${o === sel ? ' sel' : ''}"><span class="handle" aria-label="Drag">${icon('grip')}</span><b class="num rk">${o.rank}</b><span class="t ell">${esc(o.feature)}</span><span>${gid(o.goal)}</span><span><span class="chip ${fitTone[o.fit]}">${cap(o.fit)}</span></span><span class="meter"><span class="bar"><i style="width:${Math.round(o.confidence * 100)}%"></i></span><b class="num">${Math.round(o.confidence * 100)}</b></span><span><span class="eff mono">${o.effort}</span></span><span class="ell ms">${o.milestone ? esc(cap(o.milestone)) : '<span class="muted">—</span>'}</span><span><span class="chip ${hzTone[o.horizon]}">${o.horizon}</span></span></div>`;
  const table = `<section class="panel" aria-label="Priority order">
  <div class="ph"><nav class="seg" aria-label="Horizon">${filters.map(([k, n], i) => `<a href="#"${i === 0 ? ' aria-current="true"' : ''}>${k} <b class="num">${n}</b></a>`).join('')}</nav><span class="grow"></span><a class="btn sec" href="#">${icon('filter', 'sm')}Goal</a></div>
  <div class="tr head pr"><span></span><span>#</span><span>Feature</span><span>Goal</span><span>Fit</span><span>Confidence</span><span>Effort</span><span>Milestone</span><span>Horizon</span></div>
  ${P.order.map(row).join('')}
</section>`;
  // goal fit summary: features per goal in this order
  const byGoal = D.goals.map(g => [g, P.order.filter(o => o.goal === g.id)]);
  const maxN = Math.max(...byGoal.map(([, l]) => l.length));
  const mix = `<section class="panel" aria-label="Order by goal">
  <div class="ph"><h2>By goal</h2><span class="n num">${D.goals.length}</span></div>
  <div class="tr head bg"><span></span><span>Goal</span><span>Ranked features</span><span>Top rank</span><span class="r">To go</span></div>
  ${byGoal.map(([g, list]) => `<div class="tr bg"><span>${gid(g.id)}</span><span class="t ell">${esc(g.name)}</span><span class="meter"><span class="bar"><i style="width:${pct(list.length, maxN)}%"></i></span><b class="num">${list.length}</b></span><span class="num">${list.length ? '#' + Math.min(...list.map(o => o.rank)) : '<span class="muted">—</span>'}</span><span class="r">${toGoHtml(g)}</span></div>`).join('')}
</section>`;
  const g = goal(sel.goal);
  const tr = D.tracks.find(t => t.now_milestone === sel.milestone);
  const theme = D.requests.themes.find(t => t.prd === tr.name);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="ihtop"><span class="cap">Feature · selected</span><a class="btn sec hb" href="#">Open</a></div><h3>${esc(sel.feature)}</h3><div class="chips"><span class="chip now">${sel.horizon}</span><span class="chip">Effort ${sel.effort}</span><span class="chip">${cap(sel.fit)} fit</span></div></div>
  <div class="big3"><div><div class="numeral">#${sel.rank}</div><div class="cap">Rank</div></div><div class="r1">${ring(sel.confidence, 46, 6, 'Confidence', confTone(sel.confidence), 14)}<div class="cap">Confidence</div></div><div><div class="numeral">${sel.effort}</div><div class="cap">Effort</div></div></div>
  <div class="is"><div class="cap">Goal</div>${goalBlock(g)}</div>
  <div class="is"><div class="cap">Milestone</div><div class="ig"><span class="grow ell"><b>${esc(sel.milestone)}</b></span>${statusChip(tr.status)}</div><div class="ig"><span class="grow ell">${esc(tr.name)}</span><span class="meter"><span class="bar" style="width:60px"><i style="width:${pct(tr.done, tr.total)}%"></i></span><b class="num">${tr.done}/${tr.total}</b></span></div></div>
  <div class="is"><div class="cap">Requests</div><div class="ig"><span class="grow ell">${esc(theme.name)}</span>${gid(theme.goal)}<b class="num">${theme.count}</b></div></div>
</aside>`;
  const pageCss = `<style>
.tr.pr{grid-template-columns:16px 18px minmax(0,1fr) 34px 74px 72px 44px 188px 90px;column-gap:10px;min-height:48px}
.tr.pr .meter .bar{min-width:0;max-width:32px}
.tr.pr .t{font-weight:500}
.rk{font-weight:700;color:var(--text)}
.handle .ic{width:18px;height:18px;fill:currentColor;stroke:none}
.eff{display:inline-grid;place-items:center;width:28px;height:26px;border-radius:6px;border:1px solid var(--line-strong);font-size:13px}
.ms{color:var(--text)}
.tr.bg{grid-template-columns:34px minmax(0,1fr) 150px 60px 130px;column-gap:12px;min-height:44px}
.tr.bg .bar{max-width:120px}
.r1{display:flex;flex-direction:column;gap:2px}.r1 svg{margin:-4px 0 0}
</style>`;
  const snap = P.snapshot.split(' · ')[0];
  const body = topbar('Priorities', `<span class="chip line mono">${esc(snap)}</span><span class="chip acc num">${P.order.length} ranked</span>`, 'Save order', 'check') + pageCss + `<div class="split"><div class="left">${table}${mix}</div>${insp}</div>`;
  return shell('Priorities', 'Priorities', body, 'More');
}

// ---------- ROADMAP ----------
// Ledger table grouped by Now / Next / Later (O4), one line per milestone; Online deposits sits below, in flight.
export function roadmap() {
  const RM = D.roadmap;
  const snap = RM.from.split(' · ')[0].replace('Priority snapshot ', '');
  const sel = D.tracks.find(t => t.at_risk);
  const groups = [['now', 'Now'], ['next', 'Next'], ['later', 'Later']];
  const stateCell = x => x.state === 'at risk' ? `<span class="chip crit"><span class="dot"></span>At risk</span><span class="chip line">${icon('alert', 'sm')}${esc(x.at_risk_item)}</span>`
    : x.state ? statusChip(x.state)
    : x.slipped_from ? `<span class="chip warn">${icon('slip', 'sm')}Slipped<span class="sf">from ${x.slipped_from}</span></span>` : '<span class="muted">—</span>';
  const row = (x, col) => { const t = D.tracks.find(k => k.name === x.track); return `<div class="tr rm${t === sel && col === 'now' ? ' sel' : ''}${x.state === 'at risk' ? ' atrisk' : ''}"><span class="t ell">${esc(x.milestone)}</span><span class="ell trk">${esc(x.track)}</span><span class="st">${stateCell(x)}</span><span class="gl">${t.serves.map(gid).join('')}</span></div>`; };
  const table = `<section class="panel" aria-label="Roadmap">
  <div class="tr head rm"><span>Milestone</span><span>Track</span><span>State</span><span>Goal</span></div>
  ${groups.map(([k, l]) => `<div class="grp"><span class="chip ${k === 'now' ? 'now' : 'acc'}">${l}</span><b class="num">${RM[k].length}</b></div>${RM[k].map(x => row(x, k)).join('')}`).join('')}
  <div class="grp fl"><span class="chip line">In flight</span><b class="num">${RM.pending.length}</b><span class="cap">${cap(RM.pending[0].note)}</span></div>
  ${RM.pending.map(p => { const pp = D.prds.find(x => x.name === p.prd); return `<div class="tr rm pend"><span class="t ell">${esc(p.prd)} <span class="mono vv">${pp.version}</span></span><span class="jcell">${jmini(pp.journey_index)}<b class="num">${pp.journey_index}/${steps.length}</b></span><span class="st"><span class="chip acc">${cap(pp.state)}</span><span class="chip now">${pp.journey_stage}</span></span><span class="gl">${pp.serves.map(gid).join('')}</span></div>`; }).join('')}
</section>`;
  const g = goal(sel.serves[0]);
  const prd = D.prds.find(p => p.name === sel.name);
  const theme = D.requests.themes.find(t => t.prd === sel.name);
  const nowM = RM.now.find(x => x.track === sel.name);
  const item = D.priorities.order.find(o => o.feature === nowM.at_risk_item);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="ihtop"><span class="cap">Milestone · selected</span><a class="btn sec hb" href="#">Open</a></div><h3>${esc(nowM.milestone)}</h3><div class="chips"><span class="chip now">Now</span><span class="chip">${cap(nowM.state)}</span><span class="chip mono">PRD ${prd.version}</span></div></div>
  <div class="big3"><div><div class="numeral">${sel.done}<small>/${sel.total}</small></div><div class="cap">Track done</div></div><div><div class="numeral crit">${sel.at_risk}</div><div class="cap">At risk</div></div><div><div class="numeral warn">${sel.slipped}</div><div class="cap">Slipped</div></div></div>
  <div class="is"><div class="cap">At risk</div><div class="ig"><span class="bl">${icon('alert', 'sm')}</span><span class="grow ell"><b>${esc(item.feature)}</b></span><span class="chip line num">#${item.rank}</span><span class="eff mono">${item.effort}</span>${ring(item.confidence, 40, 5, 'Confidence', confTone(item.confidence), 13)}</div></div>
  <div class="is"><div class="cap">Goal</div>${goalBlock(g)}</div>
  <div class="is"><div class="cap">Requests</div><div class="ig"><span class="grow ell">${esc(theme.name)}</span>${gid(theme.goal)}<b class="num">${theme.count}</b></div></div>
  <div class="is iact"><a class="btn sec" href="#">Priorities</a><a class="btn sec" href="#">Track</a></div>
</aside>`;
  const pageCss = `<style>
.tr.rm{grid-template-columns:minmax(0,1fr) 250px 290px 64px;column-gap:14px;min-height:46px}
.tr.rm .t{font-weight:600}
.trk{color:var(--text)}
.st{display:flex;gap:6px;align-items:center}
.tr.rm.atrisk .st .chip.line .ic{color:var(--crit)}
.grp{display:flex;align-items:center;gap:8px;padding:10px 16px 8px;border-bottom:1px solid var(--line);background:var(--surface)}
.grp b{font-weight:700}
.grp:not(:nth-child(2)){border-top:1px solid var(--line);margin-top:-1px}
.grp.fl{border-top:2px solid var(--line-strong)}
.tr.pend{background:repeating-linear-gradient(135deg,transparent 0 10px,var(--surface2) 10px 12px)}
.tr.pend .chip.line,.tr.pend .chip.acc{background:var(--surface)}
.jcell{display:flex;align-items:center;gap:8px}.jcell b{font-weight:600}
.gl{display:flex;gap:4px}
.tr.tk{grid-template-columns:minmax(0,1fr) 120px 150px 200px;column-gap:14px;min-height:46px}
.tr.tk .t{font-weight:500}
.risk{display:flex;gap:6px}
.eff{display:inline-grid;place-items:center;width:28px;height:26px;border-radius:6px;border:1px solid var(--line-strong);font-size:13px}
.lanes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.lane{display:flex;flex-direction:column;gap:6px;min-width:0}
.lane .cap{margin:0}
.lane.now .cap{display:inline-flex;align-self:flex-start;background:var(--lime);color:var(--on-lime);border-radius:999px;padding:3px 10px}
.lm{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:8px;background:var(--surface2);font-weight:600;font-size:14px;min-width:0}
.lm .ic{flex:none}
.lm.risk{box-shadow:inset 3px 0 0 var(--crit)}.lm.risk .ic{color:var(--crit)}
.lm.slip .ic{color:var(--warn)}
.lm.empty{background:transparent;color:var(--text2)}
@media (max-width:600px){
  .tr.head.rm,.tr.head.tk{display:none}
  .tr.rm{grid-template-columns:minmax(0,1fr) auto;min-height:48px}
  .tr.rm .trk,.tr.rm .gl,.tr.rm .st .chip.line,.tr.rm .jcell{display:none}
  .tr.pend .st .chip.acc,.tr.rm .sf,.tr.pend .vv{display:none}
  .tr.tk{grid-template-columns:minmax(0,1fr) auto 44px}
  .tr.tk .risk{display:none}
  .tr.tk .meter .bar{display:none}
}
</style>`;
  const atRisk = RM.now.filter(x => x.state === 'at risk').length;
  const body = topbar('Roadmap', `<span class="chip line mono">${snap}</span><span class="chip crit num">${atRisk} at risk</span>`, 'Run roadmap', 'runs') + pageCss + `<div class="split"><div class="left">${table}</div>${insp}</div>`;
  return shell('Roadmap', 'Roadmap', body);
}

// ---------- RUNS ----------
export function runs() {
  const RS = D.runs;
  const sel = RS[0];
  const segSel = sel.segments.find(s => s.checkpoint.startsWith('waiting'));
  const stTone = s => s.includes('review') ? 'acc' : s.includes('cost') ? 'warn' : s.includes('overrun') ? 'crit' : '';
  const act = r => r.state.includes('review') ? 'Decide' : r.state.includes('cost') ? 'Approve' : 'Decide';
  const costOf = r => { const m = r.cost.match(/^(\$[\d.]+) of (\$[\d.]+)$/); return m ? `${m[1]} / ${m[2]}` : r.cost.replace(' estimate', ' est.'); };
  // cost is shown only on the cost approval and the overrun (P3d)
  const showCost = r => r.state.includes('cost') || r.state.includes('overrun');
  const runRow = r => `<div class="tr ru${r === sel ? ' sel' : ''}"><span class="mono rid">${r.id}</span><span class="t ell">${esc(r.for)}</span><span class="ell">${esc(r.flow)}</span><span class="stc"><span class="chip ${stTone(r.state)}">${cap(r.state)}</span>${showCost(r) ? `<span class="cost">${costOf(r)}</span>` : ''}</span><span class="r"><a class="btn sec${r === sel ? ' solid' : ''}" href="#">${act(r)}</a></span></div>`;
  const runsT = `<section class="panel" aria-label="Runs">
  <div class="ph"><h2>Runs</h2><span class="n num">${RS.length}</span><span class="grow"></span><span class="chip warn num">${RS.length} waiting</span></div>
  <div class="tr head ru"><span>Run</span><span>For</span><span>Flow</span><span>State</span><span></span></div>
  ${RS.map(runRow).join('')}
</section>`;
  const segState = s => s.state === 'succeeded' ? `<span class="chip pass">${icon('check', 'sm')}Succeeded</span>` : `<span class="chip">${cap(s.state)}</span>`;
  const cp = s => s.checkpoint.startsWith('waiting') ? `<span class="chip warn">${icon('clock', 'sm')}Waiting</span>` : s.checkpoint.startsWith('approved') ? `<span class="cpk">${icon('check', 'sm')}<span class="av">${initials(s.checkpoint.replace('approved by ', ''))}</span></span>` : `<span class="chip line">${cap(s.checkpoint.replace('stops for ', ''))}</span>`;
  const segRow = s => `<div class="tr sgm${s === segSel ? ' sel' : ''}"><b class="num sn">${s.n}</b><span class="t ell">${esc(s.name)}</span><span class="roles">${s.roles.map(r => `<span class="chip acc">${r}</span>`).join('')}</span><span>${segState(s)}</span><span>${cp(s)}</span></div>`;
  const segT = `<section class="panel" aria-label="Segments">
  <div class="ph"><h2>Run <span class="mono">${sel.id}</span></h2><span class="chip line">${esc(sel.flow)}</span><span class="chip line">${cap(sel.depth)}</span><span class="grow"></span><span class="cap num">${sel.segments.filter(s => s.state === 'succeeded').length}/${sel.segments.length} segments</span></div>
  <div class="tr head sgm"><span>#</span><span>Segment</span><span>Roles</span><span>State</span><span>Checkpoint</span></div>
  ${sel.segments.map(segRow).join('')}
</section>`;
  const who = segSel.checkpoint.replace('waiting: ', '');
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="ihtop"><span class="cap">Checkpoint · waiting</span><span class="cost hcost">${costOf(sel)}</span></div><h3>${esc(segSel.name)}</h3><div class="chips"><span class="chip">Segment ${segSel.n} of ${sel.segments.length}</span>${segSel.roles.map(r => `<span class="chip">${r}</span>`).join('')}</div></div>
  <div class="is"><div class="cap">Proposed order <b class="num cnum">${segSel.items.length}</b><span class="grow"></span>${[...new Set(segSel.items.map(it => it.match(/\((G\d)\)$/)[1]))].map(gid).join('')}</div><ul class="olist">${segSel.items.map((it, i) => `<li><b class="num">${i + 1}</b><span class="grow ell">${esc(it.replace(/ \(G\d\)$/, ''))}</span></li>`).join('')}</ul></div>
  <div class="is"><div class="cap">Approver</div><div class="ig">${icon('user', 'sm')}<span class="grow">${cap(who)}</span><span class="av">${D.viewer.initials}</span></div></div>
  <div class="is"><div class="cap">Next</div><div class="ig"><b class="num">${sel.segments.at(-1).n}</b><span class="grow ell">${esc(sel.segments.at(-1).name)}</span>${sel.segments.at(-1).roles.map(r => `<span class="chip acc">${r}</span>`).join('')}</div></div>
  <div class="is iact"><a class="btn sec solid" href="#">${icon('check', 'sm')}Approve order</a><a class="btn sec" href="#">Send back</a></div>
</aside>`;
  const pageCss = `<style>
.tr.ru{grid-template-columns:44px minmax(0,1fr) 116px 300px 84px;column-gap:12px;min-height:50px}
.stc{display:flex;align-items:center;gap:10px}
.tr.ru .t{font-weight:500}
.rid{color:var(--accent-ink);font-size:14px}
.segdots{display:inline-flex;gap:4px}.segdots i{width:12px;height:12px;border-radius:3px;background:var(--surface2);box-shadow:inset 0 0 0 1px var(--line-strong)}
.segdots i.d{background:var(--pass);box-shadow:none}.segdots i.c{background:var(--lime);box-shadow:inset 0 0 0 2px var(--on-lime)}
.tr.sgm{grid-template-columns:24px minmax(0,1fr) 210px 130px 170px;column-gap:12px;min-height:52px}
.tr.sgm .t{font-weight:500}
.sn{font-weight:700}
.roles{display:flex;gap:6px}
.cpk{display:inline-flex;align-items:center;gap:6px;color:var(--pass)}
.ph h2 .mono{font-size:16px}
.hcost{color:var(--hero-text2);font-size:13px}
.olist li{display:flex;align-items:center;gap:10px;min-height:36px}.olist b{width:18px;font-weight:700}
.cnum{color:var(--text);font-weight:700}
.insp .ig .ic{color:var(--accent-ink)}
</style>`;
  const body = topbar('Runs', `<span class="chip warn num">1 checkpoint</span>`, 'New run', 'plus') + pageCss + `<div class="split"><div class="left">${runsT}${segT}</div>${insp}</div>`;
  return shell('Runs', 'Runs', body, 'More');
}

// ---------- PUBLISH ----------
// T2: the ten advisory criteria (docs/product-oracle-v2/build-prompt.md §18). Statuses spread to match quillfield.json publish.advisory (7 pass, 2 warning, 1 critical).
const CRITERIA = [
  ['Problem and user clarity', 'pass'],
  ['Business goal alignment', 'warn'],
  ['Source evidence and provenance', 'pass'],
  ['Alternatives and trade-offs', 'pass'],
  ['Blocker and feasibility resolution', 'crit'],
  ['Scope, non-goals, testable requirements', 'warn'],
  ['Economic and scaling assumptions', 'pass'],
  ['Validation plan and metrics', 'pass'],
  ['Ownership and operational readiness', 'pass'],
  ['Downstream design consistency', 'pass'],
];
export function publish() {
  const P = D.publish;
  const A = P.advisory;
  const counts = { pass: CRITERIA.filter(c => c[1] === 'pass').length, warn: CRITERIA.filter(c => c[1] === 'warn').length, crit: CRITERIA.filter(c => c[1] === 'crit').length };
  if (counts.pass !== A.pass || counts.warn !== A.warn || counts.crit !== A.fail) throw new Error('advisory counts disagree with quillfield.json');
  const advChip = s => s === 'pass' ? `<span class="chip pass">${icon('check', 'sm')}Pass</span>` : s === 'warn' ? '<span class="chip warn">Warning</span>' : '<span class="chip crit">Critical</span>';
  const fails = P.hard_checks.filter(h => h.state === 'fail').length;
  const blockRow = (b, i) => { const [t, q] = splitParen(b); return `<div class="tr pb${i === 0 ? ' sel' : ''}"><span class="bl">${icon('alert', 'sm')}</span><span class="t ell">${esc(t)}</span><span>${q ? `<span class="chip crit">${esc(cap(q))}</span>` : '<span class="chip warn">Proposed goal</span>'}</span><span class="r"><a class="btn sec${i === 0 ? ' solid' : ''}" href="#">Resolve</a></span></div>`; };
  const hardRow = h => `<div class="tr pb"><span class="${h.state === 'pass' ? 'ok' : 'bl'}">${icon(h.state === 'pass' ? 'check' : 'x', 'sm')}</span><span class="t ell">${esc(h.name)}</span><span>${h.state === 'pass' ? '<span class="chip pass">Pass</span>' : '<span class="chip crit">Fail</span>'}</span><span class="r num">${h.detail ? esc(h.detail) : ''}</span></div>`;
  const advRow = ([n, s], i) => `<div class="tr pa"><b class="num muted">${i + 1}</b><span class="t ell">${esc(n)}</span><span>${advChip(s)}</span></div>`;
  const half = Math.ceil(CRITERIA.length / 2);
  const panel = `<section class="panel" aria-label="Publish readiness">
  <div class="ph"><h2>Blocks</h2><span class="n num">${P.blocks.length}</span></div>
  ${P.blocks.map(blockRow).join('')}
  <div class="ph sub"><h2>Hard checks</h2><span class="n num">${P.hard_checks.length}</span><span class="chip crit num">${fails} fail</span></div>
  ${P.hard_checks.map(hardRow).join('')}
  <div class="ph sub"><h2>Advisory</h2><span class="n num">${CRITERIA.length}</span><span class="chip pass num">${A.pass} pass</span><span class="chip warn num">${A.warn} warning</span><span class="chip crit num">${A.fail} critical</span></div>
  <div class="adv"><div>${CRITERIA.slice(0, half).map((c, i) => advRow(c, i)).join('')}</div><div>${CRITERIA.slice(half).map((c, i) => advRow(c, i + half)).join('')}</div></div>
</section>`;
  const [bt, bq] = splitParen(P.blocks[0]);
  const ask = needs.questions.find(n => n.from);
  const insp = `<aside class="insp" aria-label="Inspector">
  <div class="ih"><div class="cap">Block · selected</div><h3>${esc(bt)}</h3><div class="chips"><span class="chip">${esc(cap(bq))}</span><span class="chip">Hard check</span></div></div>
  <div class="is"><div class="cap">Question</div><div class="ig"><span class="av">${initials(ask.from)}</span><span class="grow ell">${esc(ask.title)}</span><span class="age num muted">${ask.age}</span></div><div class="iact mt"><a class="btn sec solid" href="#">Answer</a><a class="btn sec" href="#">Ask Oracle</a></div></div>
  <div class="is"><div class="cap">Risk</div><div class="ig"><a class="btn sec" href="#">Accept risk</a><span class="chip line">${icon('lock', 'sm')}Owners only</span></div>
    <div class="cap apcap">As approver</div><div class="ig apv">${icon('lock', 'sm')}<span class="grow">Only an owner can accept this risk</span></div></div>
  <div class="is"><div class="cap">On publish</div><ul class="rec">${P.records.map(r => `<li>${icon('doc', 'sm')}<span class="ell">${esc(cap(r.split(':')[0]))}</span></li>`).join('')}</ul></div>
</aside>`;
  const pageCss = `<style>
.tr.pb{grid-template-columns:22px minmax(0,1fr) 150px 110px;min-height:42px}
.tr.pb .t{font-weight:500}
.ok{color:var(--pass);display:grid}
.ph.sub{border-top:1px solid var(--line)}
.adv{display:grid;grid-template-columns:1fr 1fr}
.adv>div:first-child{border-right:1px solid var(--line)}
.tr.pa{grid-template-columns:22px minmax(0,1fr) auto;min-height:42px}
.adv .tr.pa:last-child{border-bottom:0}
.apcap{margin:10px 0 4px}.mt{margin-top:8px}
.apv{padding:6px 10px;border-radius:8px;background:var(--surface2);gap:8px;color:var(--text)}
.apv .grow{font-weight:500}
.rec li{display:flex;align-items:center;gap:8px;min-height:30px}.rec .ic{color:var(--accent-ink)}
</style>`;
  const body = topbar(`Publish <span class="mono tv">${esc(P.prd.replace(/ v\d+$/, ''))} ${P.prd.match(/v\d+$/)[0]}</span>`, `<span class="chip crit num">${P.blocks.length} blocks</span>`, `Publish ${P.prd.match(/v\d+$/)[0]}`, 'lock', true) + `<style>.tv{font:500 20px 'Inter',sans-serif;color:var(--text2);margin-left:6px}</style>` + pageCss + `<div class="split">${panel}${insp}</div>`;
  return shell('PRDs', 'Publish', body);
}
