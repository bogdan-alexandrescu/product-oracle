import json, sys
from swarm_browser import live
frames=json.load(open('frames.json')); BASE=sys.argv[1]
OUT='/workspace/att_ba3d1374145642d6a0e9/work/repo/mockups-out/mk-saved-views/frames'
pw,b,ctx=live(); p=ctx.new_page(); p.goto(BASE+'frames/'+frames[0]['file']+'.html')
for fr in frames:
    w,h=fr['w'],fr['h']; sc=min(1,1440/w)
    p.set_content(f'<body style="margin:0"><iframe id=f src="{BASE}frames/{fr["file"]}.html?theme=dark" style="border:0;width:{w}px;height:{h}px;transform:scale({sc});transform-origin:0 0;display:block"></iframe></body>')
    p.wait_for_timeout(1200); p.mouse.move(2,2)
    p.query_selector('#f').screenshot(path=f'{OUT}/{fr["file"]}-dark.png')
p.close(); pw.stop(); print('dark done', len(frames))
