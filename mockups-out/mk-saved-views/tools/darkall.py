import json, sys
from swarm_browser import live
frames=json.load(open('frames.json')); BASE=sys.argv[1]
OUT='/workspace/att_29c1f97ad092422dbc96/work/repo/mockups-out/mk-saved-views/frames'
pw,b,ctx=live(); p=ctx.new_page(); p.goto(BASE+'frames/'+frames[0]['file']+'.html')
for fr in frames:
    w,h=fr['w'],fr['h']; sc=1
    p.set_content(f'<body style="margin:0"><iframe id=f src="{BASE}frames/{fr["file"]}.html?theme=dark" style="border:0;width:{w}px;height:{h}px;transform:scale({sc});transform-origin:0 0;display:block"></iframe></body>')
    p.wait_for_timeout(1200); p.mouse.move(2,2)
    p.screenshot(path=f'{OUT}/{fr["file"]}-dark.png', full_page=True, clip={'x':0,'y':0,'width':w,'height':h})
p.close(); pw.stop(); print('dark done', len(frames))
