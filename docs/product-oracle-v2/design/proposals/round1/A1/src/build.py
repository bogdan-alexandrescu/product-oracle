"""A1 Cockpit: build the four static HTML screens from quillfield.json.

Every number, name and state on screen is read from the data file or computed from it here.
"""
import json, os, html, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = pathlib.Path(os.environ.get("QF", "/workspace/att_157c175683f64730a8b9/work/repo/docs/product-oracle-v2/design/proposals/quillfield.json"))
D = json.loads(DATA.read_text())
e = html.escape

GOALS = {g["id"]: g for g in D["goals"]}
NY = D["needs_you"]
N_DEC, N_REV, N_Q = len(NY["decisions"]), len(NY["reviews"]), len(NY["questions"])
INBOX = N_DEC + N_REV + N_Q
RQ = D["requests"]


def fmt(v):
    return f"{v:g}"


def gap_closed(g):
    """Share of the gap to target closed since the start of trend_6m (0..100)."""
    start = g["trend_6m"][0]
    return round(100 * (g["current"] - start) / (g["target"] - start))


def delta6(g):
    return round(g["current"] - g["trend_6m"][0], 2)


def unit_short(g):
    return {"%": "pts", "min": "min", "clinics": "", "tickets": ""}[g["unit"]]


def num_html(g, v):
    u = g["unit"]
    if u == "%":
        return f"{fmt(v)}<small>%</small>"
    if u == "min":
        return f"{fmt(v)}<small>min</small>"
    return fmt(v)


def target_html(g):
    pre = "&lt;" if g["better"] == "down" and g["unit"] == "tickets" else ""
    u = {"%": "%", "min": " min"}.get(g["unit"], "")
    return f"{pre}{fmt(g['target'])}{u}"


# ---------- icons (16px stroke set, Atlas) ----------
P = {
    "home": '<path d="M2 7.5 8 2.5l6 5V14H2z"/><path d="M6.5 14v-4h3v4"/>',
    "requests": '<path d="M2 3h12v8H6.5L3.5 14v-3H2z"/><path d="M5 6.2h6M5 8.4h4"/>',
    "baseline": '<circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><path d="M5.5 5.5 7 10.5M10.5 5.5 9 10.5"/>',
    "prds": '<path d="M4 1.5h5.5L12.5 4.5V14.5H4z"/><path d="M9.5 1.5V4.5H12.5M6 8h4.5M6 10.5h4.5"/>',
    "priorities": '<path d="M3 3.5h10M3 8h7M3 12.5h4"/>',
    "roadmap": '<path d="M2 4h5M5 8h6M9 12h5"/><circle cx="2" cy="4" r=".6"/>',
    "runs": '<path d="M2 8h3l2-5 2 10 2-5h3"/>',
    "inbox": '<path d="M2 9.5 4 3h8l2 6.5V13H2z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
    "settings": '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    "more": '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
    "decision": '<path d="M8 1.5v13M3 4.5h10"/><path d="M3 4.5 1.5 9h3zM13 4.5 11.5 9h3z"/>',
    "review": '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    "question": '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4"/><circle cx="8" cy="11.6" r=".5"/>',
    "info": '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v4"/><circle cx="8" cy="5" r=".5"/>',
    "plus": '<path d="M8 3v10M3 8h10"/>',
    "check": '<path d="M3 8.5 6.5 12 13 4.5"/>',
    "x": '<path d="M4 4l8 8M12 4l-8 8"/>',
    "warn": '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r=".5"/>',
    "merge": '<path d="M4 2v4.5a3 3 0 0 0 3 3h5"/><path d="M10 7.5 12 9.5 10 11.5"/>',
    "flag": '<path d="M3.5 14V2.5M3.5 2.5h8l-1.5 3 1.5 3h-8"/>',
    "search": '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
    "filter": '<path d="M2 3h12L9.5 8.5V13l-3 1.5v-6z"/>',
    "doc": '<path d="M4 1.5h5.5L12.5 4.5V14.5H4z"/>',
    "link": '<path d="M6.5 9.5 9.5 6.5"/><path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8"/>',
    "lock": '<rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
    "slip": '<path d="M2 5h8M7 2l3 3-3 3"/><path d="M14 11H6M9 8l-3 3 3 3"/>',
    "chev": '<path d="M6 3.5 10.5 8 6 12.5"/>',
}


def ic(name, cls="ic"):
    return (f'<svg class="{cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" '
            f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{P[name]}</svg>')


# ---------- charts ----------
def spark(vals, w=132, h=34, cls="spark"):
    lo, hi = min(vals), max(vals)
    rng = (hi - lo) or 1
    pts = []
    for i, v in enumerate(vals):
        x = 3 + i * (w - 6) / (len(vals) - 1)
        y = 3 + (hi - v) * (h - 6) / rng
        pts.append((round(x, 1), round(y, 1)))
    poly = " ".join(f"{x},{y}" for x, y in pts)
    area = f"3,{h} " + poly + f" {w-3},{h}"
    lx, ly = pts[-1]
    return (f'<svg class="{cls}" viewBox="0 0 {w} {h}" width="{w}" height="{h}" aria-hidden="true">'
            f'<polygon points="{area}" class="sp-a"/><polyline points="{poly}" class="sp-l"/>'
            f'<circle cx="{lx}" cy="{ly}" r="4" class="sp-d"/></svg>')


def ring(pct, size=72, stroke=8, cls="ring", label=None):
    r = (size - stroke) / 2
    c = 2 * 3.14159265 * r
    on = c * max(0, min(pct, 100)) / 100
    lab = label if label is not None else f"{pct}<small>%</small>"
    return (f'<span class="{cls}" style="width:{size}px;height:{size}px">'
            f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}" aria-hidden="true">'
            f'<circle cx="{size/2}" cy="{size/2}" r="{r}" class="rg-t" stroke-width="{stroke}"/>'
            f'<circle cx="{size/2}" cy="{size/2}" r="{r}" class="rg-v" stroke-width="{stroke}" '
            f'stroke-dasharray="{on:.1f} {c:.1f}" transform="rotate(-90 {size/2} {size/2})"/></svg>'
            f'<b class="num">{lab}</b></span>')


def bars(vals, w=210, h=64, cls="bars", labels=True):
    h0 = 18 if labels else 2
    n = len(vals)
    gap = 6
    bw = (w - gap * (n - 1)) / n
    mx = max(vals)
    out = []
    for i, v in enumerate(vals):
        bh = max(3, (h - h0) * v / mx)
        x = i * (bw + gap)
        last = " now" if i == n - 1 else ""
        out.append(f'<rect class="b{last}" x="{x:.1f}" y="{h-h0-bh:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="3"/>')
        if labels: out.append(f'<text x="{x+bw/2:.1f}" y="{h-3}" text-anchor="middle">{v}</text>')
    return f'<svg class="{cls}" viewBox="0 0 {w} {h}" width="{w}" height="{h}" aria-hidden="true">{"".join(out)}</svg>'


def meter(done, total, w=90):
    return (f'<span class="meter" style="width:{w}px"><i style="width:{100*done/total:.1f}%"></i></span>'
            f'<b class="num mt">{done}/{total}</b>')


def chip(text, kind="na", icon=None):
    i = ic(icon) if icon else ""
    return f'<span class="chip c-{kind}">{i}{e(text)}</span>'


def cnt(v):
    return "" if v is None else '<b class="num">' + str(v) + '</b>'


def gchip(gid):
    return f'<span class="gid">{gid}</span>' if gid else '<span class="gid none">—</span>'


STATUS_KIND = {"on track": "pass", "drifting": "warn", "at risk": "crit", "in review": "info",
               "approved": "pass", "draft": "na", "changes requested": "crit", "pending": "warn",
               "open": "info", "accepted": "pass", "rejected": "crit", "confirmed": "pass", "proposed": "warn",
               "Qualified": "pass", "Merged": "info", "New": "warn", "Disqualified": "crit"}


def cap(s):
    return s[0].upper() + s[1:]


# ---------- shell ----------
NAV = [("home", "Home"), ("requests", "Requests"), ("baseline", "Baseline"), ("prds", "PRDs"),
       ("priorities", "Priorities"), ("roadmap", "Roadmap"), ("runs", "Runs"), ("inbox", "Inbox")]
BADGE = {"inbox": INBOX, "requests": RQ["unreviewed"]}
CSS = (ROOT / "src" / "a1.css").read_text()
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700'
         '&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=block">')


def rail(active):
    items = []
    for key, label in NAV:
        cur = ' aria-current="page"' if key == active else ""
        b = f'<span class="badge num">{BADGE[key]}</span>' if key in BADGE else ""
        items.append(f'<a href="#"{cur}>{ic(key)}<span>{label}</span>{b}</a>')
    return (f'<nav class="rail" aria-label="Oracle"><span class="logo" aria-label="Product Oracle">PO</span>{"".join(items)}'
            f'<span class="sp"></span><a href="#">{ic("settings")}<span>Settings</span></a>'
            f'<span class="me" aria-label="{e(D["viewer"]["name"])}">{e(D["viewer"]["initials"])}</span></nav>')


def tabbar(active):
    tabs = [("home", "Home"), ("requests", "Requests"), ("prds", "PRDs"), ("inbox", "Inbox"), ("more", "More")]
    out = []
    for key, label in tabs:
        cur = ' aria-current="page"' if key == active else ""
        b = f'<span class="badge num">{BADGE[key]}</span>' if key in BADGE else ""
        out.append(f'<a href="#"{cur}>{ic(key)}<span>{label}</span>{b}</a>')
    return f'<nav class="tabbar" aria-label="Oracle (mobile)">{"".join(out)}</nav>'


def topbar(title, status_html, action_label, action_icon="plus", crumb=None):
    cr = f'<span class="crumb">{crumb}</span>' if crumb else ""
    return (f'<header class="top"><div class="tl">{cr}<h1>{title}</h1>{status_html}</div>'
            f'<button class="btn primary" type="button">{ic(action_icon)}{e(action_label)}</button></header>')


def page(name, active, body, title):
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">'
            f'<title>A1 Cockpit · {title}</title>{FONTS}<style>{CSS}</style></head>'
            f'<body class="pg-{name}"><div class="app">{rail(active)}<main class="main">{body}</main></div>{tabbar(active)}</body></html>')


# ---------- HOME ----------
def goal_tile(g):
    good_dir = (delta6(g) > 0) == (g["better"] == "up")
    d = delta6(g)
    us = unit_short(g)
    dtxt = f"{'+' if d > 0 else '−'}{fmt(abs(d))}{(' ' + us) if us else ''}"
    st = chip("Proposed", "hwarn") if g["status"] == "proposed" else ""
    conf = round(g["confidence"] * 100)
    unit_lbl = {"clinics": "clinics", "tickets": "per clinic"}.get(g["unit"], "")
    ul = f'<span class="ul">{unit_lbl}</span>' if unit_lbl else ""
    tip = ""
    return f'''<div class="goal">
  <div class="gh"><span class="gid h">{g["id"]}</span><span class="gn">{e(g["name"])}</span>{st}</div>
  <div class="gm"><div class="gv"><b class="big num">{num_html(g, g["current"])}</b>{ul}<span class="tg num">{ic("flag")}{target_html(g)}</span></div>
    <div class="gr">{ring(gap_closed(g))}<span class="rl">To target{tip}</span></div></div>
  <div class="gs">{spark(g["trend_6m"])}<span class="dl {'good' if good_dir else 'bad'} num">{dtxt}</span><span class="m6">6 mo</span></div>
  <div class="gc"><span class="cl">Conf</span><span class="cbar"><i style="width:{conf}%"></i></span><b class="num">{conf}%</b></div>
</div>'''


def tracks_block():
    rows = []
    for t in D["tracks"]:
        g = t["serves"][0]
        if t["at_risk"]:
            risk = chip(f'{t["at_risk"]} · {t["at_risk_item"]}', "crit", "warn")
        else:
            risk = f'<span class="zero num">{t["at_risk"]}</span>'
        rows.append(f'''<tr><th scope="row">{e(t["name"])}</th><td>{chip(cap(t["status"]), STATUS_KIND[t["status"]])}</td>
<td>{e(t["now_milestone"])}</td><td class="dn">{meter(t["done"], t["total"], 56)}</td><td>{risk}</td></tr>''')
    p = D["prds"][0]
    steps = D["journey_steps"]
    ji = p["journey_index"]
    dots = "".join(f'<i class="{"d" if k < ji else ("c" if k == ji else "")}"></i>' for k in range(1, len(steps) + 1))
    blk = chip(str(p["blockers"]) + " blockers", "crit", "lock")
    rows.append(f'''<tr class="prd"><th scope="row">{ic("prds")}{e(p["name"])} <span class="ver">{p["version"]}</span></th><td>{chip(cap(p["state"]), "info")}</td>
<td><span class="jr">{dots}</span><b class="js">{e(p["journey_stage"])}</b></td>
<td class="dn"><b class="num mt">{ji}/{len(steps)}</b></td><td>{blk}</td></tr>''')
    return f'''<section class="panel tracks" aria-label="Tracks">
<div class="ph"><h2>Tracks</h2><span class="cnt num">{len(D["tracks"])}</span><h2 class="ph2">In review</h2><span class="cnt num">1</span><a class="lnk" href="#">Roadmap{ic("chev")}</a></div>
<table class="lanes"><thead><tr><th>Track</th><th>Status</th><th><span class="now">Now</span></th><th>Done</th><th>At risk</th></tr></thead><tbody>{"".join(rows)}</tbody></table></section>'''


def requests_block(mobile=False):
    w = RQ["weekly_new_8w"]
    wd = w[-1] - w[-2]
    themes = [t for t in RQ["themes"] if t["goal"]][:3]
    mx = max(t["count"] for t in RQ["themes"])
    th = "".join(f'<li><span class="tn">{e(t["name"])}</span><span class="tb"><i style="width:{100*t["count"]/mx:.0f}%"></i></span>'
                 f'<b class="num">{t["count"]}</b>{gchip(t["goal"])}</li>' for t in themes)
    states = [("Qualified", RQ["qualified"], "pass"), ("New", RQ["unreviewed"], "warn"),
              ("Merged", RQ["merged_duplicates"], "info"), ("Disqualified", RQ["disqualified"], "crit")]
    tot = sum(s[1] for s in states)
    assert tot == RQ["open"], tot
    stack = "".join(f'<i class="s-{k}" style="width:{100*v/tot:.2f}%"></i>' for _, v, k in states)
    leg = "".join(f'<li><i class="s-{k}"></i>{n}<b class="num">{v}</b></li>' for n, v, k in states)
    return f'''<section class="panel reqs" aria-label="Requests">
<div class="ph"><h2>Requests</h2><a class="lnk" href="#">All{ic("chev")}</a></div>
<div class="rq">
 <div class="rq-new"><span class="lbl">New this week</span><div class="nv"><b class="big num">{RQ["new_this_week"]}</b><span class="dl good num">{'+' if wd>=0 else '−'}{abs(wd)}</span></div>{bars(w, 196 if not mobile else 150, 48, labels=False)}<span class="lbl sm">8 weeks</span></div>
 <div class="rq-th"><span class="lbl">Top themes</span><ul class="themes">{th}</ul></div>
 <div class="rq-st"><span class="lbl">Open</span><b class="mid num">{RQ["open"]}</b><span class="stack">{stack}</span><ul class="leg">{leg}</ul></div>
</div></section>'''


ACT = {"Checkpoint": "Approve", "Cost approval": "Approve", "Overrun": "Decide", "Approval": "Review",
       "Comments": "Resolve", "Interview": "Answer", "Asked you": "Answer"}


def needs_block(mobile=False):
    def rows(items, kind):
        out = []
        for it in items:
            cost = ""
            if "cost" in it:
                c = it["cost"].replace(" estimate", "").replace(" of ", "/")
                cost = f'<span class="cost num">{e(c)}</span>'
            age = ""
            out.append(f'<li class="k-{kind}">{ic(kind)}<span class="it">{e(it["title"])}</span>{cost}{age}'
                       f'<button class="btn sm" type="button">{ACT[it["kind"]]}</button></li>')
        return "".join(out)
    return f'''<section class="panel needs" aria-label="Needs me">
<div class="ph"><h2>Needs me</h2><a class="lnk" href="#">Inbox{ic("chev")}</a></div>
<div class="kinds"><div class="k-decision">{ic("decision")}<b class="num">{N_DEC}</b><span>Decisions</span></div>
<div class="k-review">{ic("review")}<b class="num">{N_REV}</b><span>Reviews</span></div>
<div class="k-question">{ic("question")}<b class="num">{N_Q}</b><span>Questions</span></div></div>
<ul class="items">{rows(NY["decisions"], "decision")}<li class="sep"></li>{rows(NY["reviews"], "review")}<li class="sep"></li>{rows(NY["questions"], "question")}</ul>
</section>'''


def home():
    goals = "".join(goal_tile(g) for g in D["goals"])
    status = chip(f"{INBOX} waiting", "warn")
    body = (topbar("Home", status, "New idea")
            + f'<section class="hero" aria-label="Goals"><div class="hh"><h2>Goals</h2><span class="hc num">{len(D["goals"])}</span>'
            f'<span class="tipwrap"><button class="ibtn" type="button" aria-label="About To target" aria-expanded="true">{ic("info")}</button>'
            f'<span class="tip" role="tooltip">To target: share of the gap to target closed in the last six months.</span></span></div>{goals}</section>'
            + f'<div class="deck"><div class="left">{tracks_block()}{requests_block()}</div>{needs_block()}</div>')
    return page("home", "home", body, "Home")


# ---------- REQUESTS ----------
def requests():
    rows = RQ["rows"]
    filt = [("All", None), ("New", RQ["unreviewed"]), ("Qualified", RQ["qualified"]),
            ("Merged", RQ["merged_duplicates"]), ("Disqualified", RQ["disqualified"])]
    fl = "".join(f'<button type="button" aria-pressed="{"true" if i == 0 else "false"}">{n}{cnt(v)}</button>'
                 for i, (n, v) in enumerate(filt))
    src = RQ["by_source"]
    mx = max(src.values())
    srcbar = "".join(f'<li><span class="tn">{k}</span><span class="tb"><i style="width:{100*v/mx:.0f}%"></i></span><b class="num">{v}</b></li>' for k, v in src.items())
    tmx = max(t["count"] for t in RQ["themes"])
    themes = "".join(
        f'<li><span class="tn">{e(t["name"])}</span><span class="tb"><i style="width:{100*t["count"]/tmx:.0f}%"></i></span><b class="num">{t["count"]}</b>{gchip(t["goal"])}</li>'
        for t in RQ["themes"])
    order = []
    for r in rows:
        if r["state"] == "Merged":
            continue
        order.append(r)
        order += [m for m in rows if m.get("merged_into") == r["title"]]
    trs = []
    for r in order:
        merged = r["state"] == "Merged"
        state = chip(r["state"], STATUS_KIND[r["state"]], "merge" if merged else None)
        if r.get("reason"):
            state += f'<span class="reason">{e(r["reason"])}</span>'
        if r.get("linked"):
            link = f'<span class="plink">{ic("prds")}{e(r["linked"])}</span>'
        elif merged:
            link = ""
        else:
            link = ""
        act = ""
        if r["state"] == "New":
            act = (f'<button class="btn sm" type="button">{ic("check")}Qualify</button>'
                   f'<button class="btn sm ghost" type="button" aria-label="Disqualify">{ic("x")}</button>')
        cls = ' class="merged"' if merged else ""
        title = f'{ic("merge", "ic mi")}{e(r["title"])}' if merged else e(r["title"])
        trs.append(f'<tr{cls}><th scope="row">{title}</th><td>{e(r["source"])}</td><td class="r num">{r["mentions"]}</td>'
                   f'<td>{gchip(r["goal"])}</td><td><div class="oc">{state}{link}{act}</div></td></tr>')
    w = RQ["weekly_new_8w"]
    body = (topbar("Requests", chip(f'{RQ["open"]} open', "info"), "Add request")
            + f'''<div class="rqgrid"><section class="panel tablep" aria-label="Requests list">
<div class="filters" role="group" aria-label="State">{fl}<span class="sp"></span><span class="search">{ic("search")}<span>Search</span></span></div>
<table class="tbl"><thead><tr><th>Request</th><th>Source</th><th class="r">Mentions</th><th>Goal</th><th>State</th></tr></thead>
<tbody>{"".join(trs)}</tbody></table>
<div class="pager num">1–{len(rows)} of {RQ["open"]}</div></section>
<aside class="panel insp" aria-label="Themes and sources">
<div class="ph"><h2>Themes</h2><span class="cnt num">{len(RQ["themes"])}</span></div><ul class="themes wide">{themes}</ul>
<div class="ph"><h2>Sources</h2></div><ul class="themes wide src">{srcbar}</ul>
<div class="ph"><h2>New per week</h2></div>{bars(w, 316, 72)}
</aside></div>''')
    return page("requests", "requests", body, "Requests")


# ---------- PRD REVIEW ----------
def prd_review():
    R = D["prd_review"]
    p = D["prds"][0]
    steps = D["journey_steps"]
    ji = p["journey_index"]
    jt = "".join(
        f'<span class="{"done" if k < ji else ("cur" if k == ji else "")}"><i class="num">{"✓" if k < ji else k}</i>{s}</span>'
        for k, s in enumerate(steps, 1))
    secs = "".join(
        f'<li class="{"cur" if s.get("current") else ""}"><span class="sd s-{STATUS_KIND[s["status"]]}"></span><span class="sn">{e(s["name"])}</span>'
        '</li>' for s in R["sections"])
    n_appr = sum(1 for s in R["sections"] if s["status"] == "approved")
    vers = "".join(f'<button type="button" aria-pressed="{"true" if v == R["version"] else "false"}">{v}</button>' for v in R["versions"])
    view = "".join(f'<button type="button" aria-pressed="{"true" if v == R["view"] else "false"}">{v}</button>' for v in ("Brief", "Full"))
    reqs = "".join(f'<li><span class="fid num">{e(r.split(" ", 1)[0])}</span><span>{e(r.split(" ", 1)[1])}</span></li>' for r in R["requirements"])
    sug = []
    for s in R["suggestions"]:
        if s["state"] == "open":
            st = (f'<button class="btn sm" type="button">{ic("check")}Accept</button>'
                  f'<button class="btn sm ghost" type="button">{ic("x")}Reject</button>')
        elif s["state"] == "rejected":
            st = chip("Rejected", "crit") + f'<span class="reason">{e(s["reason"])}</span>'
        else:
            st = chip("Accepted", "pass", "check")
        sug.append(f'<li><span class="by">{e(s["by"])}</span><span class="stx">{e(s["text"])}</span><span class="sa">{st}</span></li>')
    rv = "".join(f'<li><span class="av">{"".join(w[0] for w in r["name"].split())}</span><span class="rn">{e(r["name"])}</span>{chip(cap(r["verdict"]), STATUS_KIND[r["verdict"]])}</li>' for r in R["reviewers"])
    cl = R["claim"]
    ev_tot = sum(x["count"] for x in cl["evidence"])
    emx = max(x["count"] for x in cl["evidence"])
    ev = "".join(f'<li><span class="tn">{e(x["source"])}</span><span class="tb"><i style="width:{100*x["count"]/emx:.0f}%"></i></span><b class="num">{x["count"]}</b></li>' for x in cl["evidence"])
    C = R["composition"]
    ctot = C["mandatory"] + C["optional_on"] + C["optional_off"]
    comp = (f'<span class="stack c3"><i class="s-acc" style="width:{100*C["mandatory"]/ctot:.2f}%"></i><i class="s-soft" style="width:{100*C["optional_on"]/ctot:.2f}%"></i><i class="s-off" style="width:{100*C["optional_off"]/ctot:.2f}%"></i></span>'
            f'<ul class="leg"><li><i class="s-acc"></i>Mandatory<b class="num">{C["mandatory"]}</b></li><li><i class="s-soft"></i>Optional on<b class="num">{C["optional_on"]}</b></li><li><i class="s-off"></i>Optional off<b class="num">{C["optional_off"]}</b></li></ul>')
    blk = "".join(f'<li>{ic("lock")}<span>{e(b)}</span></li>' for b in R["blockers"])
    cur = next(s for s in R["sections"] if s.get("current"))
    n_open = sum(1 for s in R["suggestions"] if s["state"] == "open")
    status = chip(cap(p["state"]), "info")
    body = (topbar(e(R["prd"]), status, f'Approve {cur["revision"]}', "check", crumb=f'PRDs{ic("chev")}')
            + f'<div class="journey" aria-label="PRD journey">{jt}</div>'
            + f'''<div class="rvgrid">
<nav class="panel secs" aria-label="Sections"><div class="ph"><h2>Sections</h2><span class="cnt num">{n_appr}/{len(R["sections"])}</span></div><ul>{secs}</ul></nav>
<article class="panel doc">
 <div class="dtool"><div class="seg" role="group" aria-label="Version">{vers}</div><div class="seg" role="group" aria-label="View">{view}</div></div>
 <div class="dh"><h2>{e(cur["name"])}</h2><span class="rev num">{cur["revision"]}</span>{chip(cap(cur["status"]), "info")}</div>
 <p class="claim"><mark>{e(cl["text"])}</mark><span class="cev">{ic("link")}Evidence</span></p>
 <ol class="frs">{reqs}</ol>
 <div class="ph sub"><h3>Suggestions</h3><span class="cnt num">{n_open} open</span></div>
 <ul class="sugs">{"".join(sug)}</ul>
</article>
<aside class="insp" aria-label="Inspector">
 <section class="panel"><div class="ph"><h2>Evidence</h2><span class="cnt num">{ev_tot}</span></div>
  <div class="evh">{ring(round(cl["confidence"]*100), 64, 7)}<span class="lbl">Confidence</span></div><ul class="themes ev">{ev}</ul></section>
 <section class="panel"><div class="ph"><h2>Reviewers</h2><span class="cnt num">{sum(1 for r in R["reviewers"] if r["verdict"]=="approved")}/{len(R["reviewers"])}</span></div><ul class="rvw">{rv}</ul></section>
 <section class="panel"><div class="ph"><h2>Composition</h2><span class="pack">{e(C["pack"])}</span></div>{comp}</section>
 <section class="panel blk"><div class="ph"><h2>Blockers</h2><span class="cnt crit num">{len(R["blockers"])}</span></div><ul class="blks">{blk}</ul></section>
</aside></div>''')
    return page("prd-review", "prds", body, "PRD review")


# ---------- ROADMAP ----------
def roadmap():
    RM = D["roadmap"]
    tr = {t["name"]: t for t in D["tracks"]}
    names = [t["name"] for t in D["tracks"]]

    def card(it, col):
        if not it:
            return '<div class="cell empty"></div>'
        cls = "rc"
        tags = ""
        if it.get("state") == "at risk":
            cls += " risk sel"
            tags += chip("At risk", "crit", "warn") + f'<span class="ri">{ic("flag")}{e(it["at_risk_item"])}</span>'
        if it.get("slipped_from"):
            cls += " slipped"
            tags += chip(f'Slipped from {it["slipped_from"]}', "warn", "slip")
        return f'<div class="cell"><div class="{cls}"><b>{e(it["milestone"])}</b><span class="tags">{tags}</span></div></div>'

    rows = []
    for n in names:
        t = tr[n]
        cells = "".join(card(next((x for x in RM[c] if x["track"] == n), None), c) for c in ("now", "next", "later"))
        rows.append(f'<div class="lane"><div class="lh"><b>{e(n)}</b><span class="lm">{chip(cap(t["status"]), STATUS_KIND[t["status"]])}{gchip(t["serves"][0])}{meter(t["done"], t["total"], 64)}</span></div>{cells}</div>')
    p = D["prds"][0]
    pend = RM["pending"][0]
    pblk = chip(str(p["blockers"]) + " blockers", "crit", "lock")
    rows.append(f'<div class="lane pend"><div class="lh"><b>{ic("prds")}{e(pend["prd"])}</b><span class="lm">{chip("Pending publish", "info")}{"".join(gchip(x) for x in p["serves"])}</span></div>'
                f'<div class="cell span3"><div class="ghost"><span>{e(p["journey_stage"])}</span><b class="num">{p["journey_index"]}/{len(D["journey_steps"])}</b>{pblk}</div></div></div>')
    sel = next(x for x in RM["now"] if x.get("state") == "at risk")
    t = tr[sel["track"]]
    g = GOALS[t["serves"][0]]
    nxt = next(x for x in RM["next"] if x["track"] == sel["track"])
    body = (topbar("Roadmap", chip(RM["from"].split(" · ")[0].replace("Priority snapshot ", "Snapshot "), "na"), "Run roadmap", "runs")
            + f'''<div class="rmgrid"><section class="panel board" aria-label="Now, Next, Later">
<div class="cols"><span></span><span class="hnow">Now<b class="num">{len(RM["now"])}</b></span><span>Next<b class="num">{len(RM["next"])}</b></span><span>Later<b class="num">{len(RM["later"])}</b></span></div>
{"".join(rows)}</section>
<aside class="panel insp" aria-label="Inspector"><div class="ph"><h2>{e(sel["milestone"])}</h2></div>
<div class="kv"><span>Slipped</span><b class="num">{t["slipped"]}</b></div>
<div class="ph"><h2>Moves</h2>{gchip(g["id"])}</div>
<div class="mv"><span class="gn2">{e(g["name"])}</span><div class="mvr"><b class="mid num">{num_html(g, g["current"])}</b><span class="tg num">{ic("flag")}{target_html(g)}</span>{spark(g["trend_6m"], 120, 34, "spark lt")}</div>
<div class="mvc">{ring(gap_closed(g), 56, 6)}<span class="rl">To target</span><span class="cl">Conf</span><span class="cbar"><i style="width:{round(g["confidence"]*100)}%"></i></span><b class="num">{round(g["confidence"]*100)}%</b></div></div>
</aside></div>''')
    return page("roadmap", "roadmap", body, "Roadmap")


if __name__ == "__main__":
    for name, fn in (("home", home), ("requests", requests), ("prd-review", prd_review), ("roadmap", roadmap)):
        (ROOT / f"{name}.html").write_text(fn())
    print("built")
