# MOCK-HOOK (whole file): the frame stories for mk-inbox-keys.
import json
S='/simple/inbox?'; D='/inbox?'
F=[]
def fr(file,url,steps=(),w=1440,h=900,as_='owner'):
    F.append({'file':file,'url':url,'steps':list(steps),'w':w,'h':h,'as':as_})
P=dict(w=390,h=844)
# IK1 a: focused row, keys on its buttons, ? lists them
fr('ik1-a-rest',S+'ik1=a')
fr('ik1-a-open',S+'ik1=a',['k:j','k:?'])
fr('ik1-a-mid',S+'ik1=a',['k:j','k:j','k:j','k:j'])
fr('ik1-a-result',S+'ik1=a&cost=ik1-a',['k:j','k:j','k:j','k:j','k:Enter'])
fr('ik1-a-hard-1512',D+'ik1=a&long=1&many=1',['k:j']*22+['v:[data-focused]'],w=1512)
fr('ik1-a-phone-390',S+'ik1=a',**P)
fr('ik1-a-commenter-1512',S+'ik1=a&role=commenter',['k:j','k:j'],w=1512,as_='commenter')
fr('ik1-a-viewer-1512',S+'ik1=a&role=viewer',['k:j'],w=1512,as_='viewer')
# IK1 b: reading pane
fr('ik1-b-rest',S+'ik1=b')
fr('ik1-b-open',S+'ik1=b',['k:j','k:j','k:j'])
fr('ik1-b-mid',S+'ik1=b',['k:j','k:j','k:j','c:[data-testid=ik-pane] input','t:Yes: keep edits on the phone until the signal is back'])
fr('ik1-b-result',S+'ik1=b&cost=ik1-b',['k:j','k:j','k:j','c:[data-testid=ik-pane] input','t:Yes: keep edits on the phone until the signal is back','k:Enter'])
fr('ik1-b-hard-1512',D+'ik1=b&long=1&many=1',['k:j']*3,w=1512)
fr('ik1-b-phone-390',S+'ik1=b',['c:[data-ik-row=i3]'],**P)
# IK1 d: tick rows, act on them together
fr('ik1-d-rest',S+'ik1=d')
T3=['k:j','k:x','k:j','k:j','k:x','k:j','k:x']
fr('ik1-d-open',S+'ik1=d',['k:j']*6+['k:x'])
fr('ik1-d-mid',S+'ik1=d',['k:j']*5+T3)
fr('ik1-d-result',S+'ik1=d&cost=ik1-d',['k:j']*5+T3+['k:a'])
fr('ik1-d-hard-1512',S+'ik1=d&many=1',['k:j']*15+['k:x','k:j']*14+['A:'],w=1512)
fr('ik1-d-phone-390',S+'ik1=d',['k:j']*5+T3+['A:'],**P)
# IK2 a: act at once, one Undo
fr('ik2-a-rest',S+'ik2=a',['k:j','k:j'])
fr('ik2-a-open',S+'ik2=a',['k:j','k:j','k:Enter'])
fr('ik2-a-mid',S+'ik2=a&cost=ik2-a',['k:j','k:j','k:Escape','k:a'])
fr('ik2-a-result',S+'ik2=a',['k:j','k:j','k:Escape','k:a','k:z'])
fr('ik2-a-hard-1512',S+'ik2=a&role=commenter',['k:j','k:j','k:j','k:a'],w=1512,as_='commenter')
fr('ik2-a-viewer-1512',S+'ik2=a&role=viewer',['k:j','k:j'],w=1512,as_='viewer')
fr('ik2-a-phone-390',S+'ik2=a',['r:button|Approve'],**P)
# IK2 b: mark, then apply
fr('ik2-b-rest',S+'ik2=b',['k:j','k:j'])
fr('ik2-b-open',S+'ik2=b',['k:j','k:j','k:a'])
fr('ik2-b-mid',S+'ik2=b',['k:j','k:j','k:a','k:d','k:e','k:j','k:w'])
fr('ik2-b-result',S+'ik2=b&cost=ik2-b',['k:j','k:j','k:a','k:d','k:e','k:j','k:w','k:Shift+Enter'])
fr('ik2-b-hard-1512',S+'ik2=b&role=commenter',['k:j','k:j','k:j','k:a','k:e','A:'],w=1512,as_='commenter')
fr('ik2-b-phone-390',S+'ik2=b',['r:button|Approve','r:button|Accept','A:'],**P)
# IK2 c: one key opens the row's actions
fr('ik2-c-rest',S+'ik2=c',['k:j','k:j'])
fr('ik2-c-open',S+'ik2=c',['k:j','k:j','k:Space'])
fr('ik2-c-mid',S+'ik2=c&cost=ik2-c',['k:j','k:j','k:Space','k:a'])
fr('ik2-c-result',S+'ik2=c',['k:j','k:j','k:Space','k:a','r:button|Undo'])
fr('ik2-c-hard-1512',S+'ik2=c&role=commenter',['k:j','k:j','k:j','k:Space'],w=1512,as_='commenter')
fr('ik2-c-phone-390',S+'ik2=c',['c:[data-ik-row=i2] button[aria-expanded]'],**P)
# IK3 a: menu of times, a Snoozed tab
F3=['k:j']*8
fr('ik3-a-rest',S+'ik3=a&snoozed=1',F3)
fr('ik3-a-open',S+'ik3=a&snoozed=1',F3+['k:s'])
fr('ik3-a-mid',S+'ik3=a&snoozed=1',F3+['k:s','k:4'])
fr('ik3-a-result',S+'ik3=a&snoozed=1&cost=ik3-a',F3+['k:s','k:4','k:1','c:[data-testid=inbox-needs] button:has-text(\"Snoozed\")'])
fr('ik3-a-hard-1512',S+'ik3=a&now=nov25&long=1',[],w=1512)
fr('ik3-a-phone-390',S+'ik3=a&snoozed=1',['c:[data-ik-row=i8] button[aria-label=Snooze]'],**P)
fr('ik3-a-phone-result-390',S+'ik3=a&snoozed=1',['c:[data-ik-row=i8] button[aria-label=Snooze]','c:[role=menuitem]:has-text("Tomorrow")','v:[data-testid=ik-notice]'],**P)
fr('ik3-a-commenter-1512',S+'ik3=a&snoozed=1&role=commenter',['k:j','k:j','k:j','k:s'],w=1512,as_='commenter')
fr('ik3-a-viewer-1512',S+'ik3=a&snoozed=1&role=viewer',['k:j'],w=1512,as_='viewer')
# IK3 b: one key for tomorrow, a fold at the foot
fr('ik3-b-rest',S+'ik3=b&snoozed=1',F3)
fr('ik3-b-open',S+'ik3=b&snoozed=1',F3+['k:Shift+S'])
fr('ik3-b-mid',S+'ik3=b&snoozed=1',F3+['k:Escape','k:s'])
fr('ik3-b-result',S+'ik3=b&snoozed=1&cost=ik3-b',F3+['k:Escape','k:s','c:[data-testid=ik-snoozed-fold] button'])
fr('ik3-b-hard-1512',S+'ik3=b&now=nov25&long=1',[],w=1512)
fr('ik3-b-phone-390',S+'ik3=b&snoozed=1&swipe=i8',['v:[data-ik-row=i8]'],**P)
fr('ik3-b-phone-result-390',S+'ik3=b&snoozed=1&swipe=i8',['v:[data-ik-row=i8]','c:[data-ik-row=i8] button:has-text("Tomorrow")','v:[data-testid=ik-notice]'],**P)
# IK3 c: until a time or until something happens
fr('ik3-c-rest',S+'ik3=c&snoozed=1',F3)
fr('ik3-c-open',S+'ik3=c&snoozed=1',F3+['v:[data-ik-row=i8]','k:s'])
fr('ik3-c-mid',S+'ik3=c&snoozed=1',F3+['v:[data-ik-row=i8]','k:s','k:ArrowDown','k:ArrowDown','k:ArrowDown'])
fr('ik3-c-result',S+'ik3=c&snoozed=1&cost=ik3-c',F3+['v:[data-ik-row=i8]','k:s','k:ArrowDown','k:ArrowDown','k:ArrowDown','k:Enter','c:[data-testid=inbox-needs] button:has-text(\"Seen\")'])
fr('ik3-c-hard-1512',S+'ik3=c&snoozed=1&long=1',['k:j','k:j','k:s'],w=1512)
fr('ik3-c-back-1512',S+'ik3=c&now=nov26&long=1',[],w=1512)
fr('ik3-c-phone-390',S+'ik3=c&snoozed=1',['c:[data-ik-row=i8] button[aria-label=Snooze]'],**P)
fr('ik3-c-phone-result-390',S+'ik3=c&snoozed=1',['c:[data-ik-row=i8] button[aria-label=Snooze]','c:[role=menuitem]:has-text("Until Product sync")','v:[data-testid=ik-notice]'],**P)
json.dump({'MOCK-HOOK':'mk-inbox-keys frame stories, written by gen_frames.py','frames':F},open('frames.json','w'),indent=1)
print(len(F))
