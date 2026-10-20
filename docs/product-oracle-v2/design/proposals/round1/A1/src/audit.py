"""Audit every rendered text node: font size, colour vs effective background, clipping."""
import pathlib, json
from playwright.sync_api import sync_playwright
A1 = pathlib.Path(__file__).resolve().parent.parent
JS = r"""() => {
 const rgb = s => { const m = s.match(/[\d.]+/g); return m ? m.map(Number) : [0,0,0,0]; };
 const lum = c => { const f = v => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
 const hex = c => '#'+c.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
 const bgOf = el => { const stack=[]; for (let e=el; e; e=e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c[3]===undefined) c[3]=1; if (c[3]>0) { stack.push(c); if (c[3]>=1) break; } }
   let out=[255,255,255]; for (let i=stack.length-1;i>=0;i--){ const c=stack[i], a=c[3]; out=[0,1,2].map(k=>c[k]*a+out[k]*(1-a)); } return out; };
 const res=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
 let n; while(n=w.nextNode()){ const t=n.textContent.trim(); if(!t) continue; const el=n.parentElement; const cs=getComputedStyle(el);
   if (cs.visibility==='hidden'||el.closest('.sr-only')) continue; const r=el.getBoundingClientRect(); if(!r.width) continue;
   let fg = el.closest('svg') ? rgb(cs.fill) : rgb(cs.color); const bg=bgOf(el);
   const a=fg[3]===undefined?1:fg[3]; fg=[0,1,2].map(k=>fg[k]*a+bg[k]*(1-a));
   const L1=lum(fg), L2=lum(bg); const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
   const clip = el.scrollWidth>el.clientWidth+1 && cs.overflow!=='visible';
   res.push({t:t.slice(0,40), size:parseFloat(cs.fontSize), fg:hex(fg), bg:hex(bg), ratio:+ratio.toFixed(2), clip, weight:cs.fontWeight}); }
 return res; }"""
FR = [("home", "light", 1440), ("home", "dark", 1440), ("home", "light", 390), ("requests", "light", 1440), ("prd-review", "light", 1440), ("roadmap", "light", 1440)]
out = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    for pg_, sch, w in FR:
        c = b.new_context(viewport={"width": w, "height": 900}, color_scheme=sch); pg = c.new_page()
        pg.goto((A1 / f"{pg_}.html").as_uri()); pg.wait_for_timeout(500)
        out[f"{pg_}-{sch}-{w}"] = pg.evaluate(JS); c.close()
    b.close()
(A1 / "src" / "audit.json").write_text(json.dumps(out, indent=1))
for k, rows in out.items():
    small = [r for r in rows if r["size"] < 13]
    low = [r for r in rows if r["ratio"] < 4.5]
    body = [r for r in rows if r["size"] >= 15 and r["ratio"] < 7]
    clip = [r for r in rows if r["clip"]]
    print(k, "nodes", len(rows), "min size", min(r["size"] for r in rows), "| <13:", small[:4], "| <4.5:", low[:6], "| clip:", clip[:3])
    print("   body<7:", sorted({(r["fg"], r["bg"], r["ratio"]) for r in body}))
