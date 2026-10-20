# Contrast for every text/background token pair the A5 screens use.
import json,sys
T=json.load(open(sys.argv[1]))['color']
def lum(h):
    h=h.lstrip('#'); c=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def ratio(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
# (text, background, use, body?)
P=[("text","bg","page title, header",1),("text","surface","tile body, rows, requirements",1),("text2","surface","labels, sources, ages, legend",1),
("text2","bg","--",0),("text","surface2","segmented filters, merged row, pending lane",1),("text","critBg","blocker text",1),
("accentSoftText","surface","PRD links",1),("accentSoftText","accentSoft","goal ids, counts, In review chip, current section",0),
("onAccent","accent","primary button",0),("pass","passBg","On track, Approved, Accepted chips",0),("warn","warnBg","Drifting, Slipped, Proposed chips",0),
("crit","critBg","At risk, blockers, Rejected chips",0),("crit","surface","outlined reason chips, confidence < 50%",0),("pass","surface","confidence >= 70%, deltas",0),
("warn","surface","confidence 50-69%",0),("highlightText","highlight","Now cells, claim",1),("heroText","hero","Needs me titles, tooltip",1),
("heroText2","hero","Needs me ages, count labels",1),("lime","hero","Needs me total, tooltip label",0),("segQ","hero","cost figures",0),
("heroText","heroBtn","ghost buttons on Needs me",0),("onLime","lime","lime buttons, Now header, Inbox badge",0),("onLime","segR","asker avatar",0),
("navText","navBg","rail, tab bar",0),("navActiveText","navActiveBg","active nav item",0),("text2","surface2","source in merged row, section counts",1)]
seen=set(); out=["| Theme | Text | Background | Ratio | Used for | Need | Result |","|---|---|---|---|---|---|---|"]; bad=0
for th in ("light","dark"):
    for a,b,use,body in P:
        if use=="--" or (th,a,b) in seen: continue
        seen.add((th,a,b)); r=ratio(T[th][a],T[th][b]); need=7 if body else 4.5; ok=r>=need; bad+=not ok
        out.append(f"| {th} | `{a}` {T[th][a]} | `{b}` {T[th][b]} | {r:.2f} | {use} | {need}:1 {'body' if body else ''} | {'pass' if ok else 'FAIL'} |")
print("\n".join(out)); print(f"\nfailures: {bad}",file=sys.stderr)
