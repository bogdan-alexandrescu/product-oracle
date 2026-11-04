# Writes frames.json: every frame of the feature panel mock-ups (web/e2e-frames/capture.spec.ts snapshots them).
import json
R, G, H = "/simple/roadmap", "/simple/priorities?tab=buckets", "/simple"
def u(page, **q):
    base = {"fp1": "a", "fp2": "a", "fp3": "a"}
    base.update(q)
    sep = "&" if "?" in page else "?"
    return page + sep + "&".join(f"{k}={v}" for k, v in base.items())
F = []
def fr(file, url, **kw): F.append({"file": file, "url": url, **kw})
for x in "abcd":
    fr(f"fp1-{x}-roadmap", u(R, fp1=x, open=1))
    fr(f"fp1-{x}-goals", u(G, fp1=x, open=1))
    fr(f"fp1-{x}-home", u(H, fp1=x, open=1))
    fr(f"fp1-{x}-mid", u(R, fp1=x, open=1, phase="mid"))
    fr(f"fp1-{x}-hard-1512", u(R, fp1=x, open=1, feat="big", viewer="read"), w=1512)
    fr(f"fp1-{x}-phone-390", u(H, fp1=x, open=1), w=390)
    fr(f"fp1-{x}-dark", u(G, fp1=x, open=1, theme="dark"), theme="dark")
for x in "abc":
    fr(f"fp2-{x}-rest", u(R, fp2=x, open=1))
    fr(f"fp2-{x}-mid", u(R, fp2=x, open=1, phase="mid"))
    fr(f"fp2-{x}-set", u(R, fp2=x, open=1, phase="set"))
    fr(f"fp2-{x}-done", u(R, fp2=x, phase="done", what="date"))
    fr(f"fp2-{x}-read-1512", u(R, fp2=x, open=1, feat="big", viewer="read"), w=1512)
    fr(f"fp2-{x}-mid-390", u(H, fp2=x, open=1, phase="mid"), w=390)
    fr(f"fp2-{x}-set-dark", u(G, fp2=x, open=1, phase="set", theme="dark"), theme="dark")
for x in "abc":
    fr(f"fp3-{x}-rest", u(R, fp3=x, open=1), js=["document.querySelector('[data-fp-section=links]')?.scrollIntoView({block:'start'})"])
    fr(f"fp3-{x}-mid", u(R, fp3=x, open=1, phase="deps"))
    fr(f"fp3-{x}-added", u(R, fp3=x, open=1, phase="added"))
    fr(f"fp3-{x}-done", u(R, fp3=x, phase="done", what="link"))
    fr(f"fp3-{x}-hard-1512", u(R, fp3=x, open=1, feat="big"), w=1512, js=["document.querySelector('[data-fp-section=links]')?.scrollIntoView({block:'start'})"])
    fr(f"fp3-{x}-goals-mid", u(G, fp3=x, open=1, phase="deps"))
    fr(f"fp3-{x}-mid-390", u(H, fp3=x, open=1, phase="deps"), w=390)
    fr(f"fp3-{x}-added-dark", u(R, fp3=x, open=1, phase="added", theme="dark"), theme="dark")
FIND = "(()=>{const w=document.createTreeWalker(document.querySelector('main')||document.body,NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){if(n.textContent.trim().startsWith('Weekly alert digest')&&!n.parentElement.closest('[data-fp-mock]')){n.parentElement.scrollIntoView({block:'%s'});return}}})()"
LINKS = "document.querySelector('[data-fp-section=links]')?.scrollIntoView({block:'start'})"
for f in F:
    js = []
    if f["url"].startswith(H + "?"): js.append(FIND % ("start" if f.get("w") == 390 else "center"))
    if "phase=deps" in f["url"] or "phase=added" in f["url"]: js.append(LINKS)
    f["js"] = js + [j for j in f.get("js", []) if j not in js]
json.dump(F, open("frames.json", "w"), indent=1)
print(len(F))
