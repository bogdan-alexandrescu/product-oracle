"""MOCK-HOOK: writes frames.json, the frame list capture.py snapshots."""
import json
from urllib.parse import quote

P = '/simple/priorities'
D = '/priorities'
MENU = ['eval', "() => { const b = document.querySelectorAll('[data-testid=prio-row]')[0].querySelectorAll('button'); b[b.length - 1].click(); }"]
DEL = ['click', 'text=Delete feature']
NOTES = ['click', '[data-testid=item-panel] button[aria-label="Change the notes"]']
TYPE = ['type', 'Ask two beta teams first']
T1 = '&today=' + quote('1 click on the name')
TR = '&today=' + quote('1 click in the rail')
F = []
THIRD = ['eval', "() => document.querySelectorAll('[data-testid=prio-title]')[2].click()"]


def f(file, path, steps=(), width=1440, theme='light', role=''):
    F.append({'file': file, 'path': path, 'steps': [list(s) for s in steps], 'width': width, 'theme': theme, 'role': role})


# KS1: grammar and the help sheet
f('ks1-a-rest', P + '?ks1=a&row=0')
f('ks1-a-open', P + '?ks1=a&row=0', [['key', '?']])
f('ks1-a-mid', P + '?ks1=a&row=0' + T1, [['key', 'j'], ['key', 'j']])
f('ks1-a-result', P + '?ks1=a&row=0' + T1, [['key', 'j'], ['key', 'j'], ['key', 'Enter']])
f('ks1-a-hard-1512', D + '?ks1=a&open=1', width=1512, theme='dark')
f('ks1-b-rest', P + '?ks1=b&row=0')
f('ks1-b-open', P + '?ks1=b&row=0', [['key', '?']])
f('ks1-b-mid', P + '?ks1=b&row=0', [['key', '?'], ['type', 'road']])
f('ks1-b-result', P + '?ks1=b&row=0' + TR, [['key', 'g'], ['key', 'r']])
f('ks1-b-hard-1512', D + '?ks1=b&open=1', width=1512, theme='dark')
f('ks1-c-rest', P + '?ks1=c&row=0')
f('ks1-c-open', P + '?ks1=c&row=0', [['press', 'Control+/']])
f('ks1-c-mid', P + '?ks1=c&row=0' + T1, [['press', 'Alt+ArrowDown'], ['press', 'Alt+ArrowDown']])
f('ks1-c-result', P + '?ks1=c&row=0' + T1, [['press', 'Alt+ArrowDown'], ['press', 'Alt+ArrowDown'], ['press', 'Alt+Enter']])
f('ks1-c-hard-1512', D + '?ks1=c&open=1', width=1512, theme='dark')
f('ks1-d-rest', P + '?ks1=d&row=0')
f('ks1-d-open', P + '?ks1=d&row=0', [['key', '?']])
f('ks1-d-mid', P + '?ks1=d&row=0', [['key', '?'], ['type', 'road']])
f('ks1-d-result', P + '?ks1=d&row=0' + TR, [['key', '?'], ['type', 'road'], ['press', 'Enter']])
f('ks1-d-hard-1512', D + '?ks1=d&open=1&q=pl', width=1512, theme='dark')

# KS2: teaching in place, focus on rows
f('ks2-a-rest', P + '?ks2=a&row=0')
f('ks2-a-open', P + '?ks2=a&row=0&tip=rail')
f('ks2-a-mid', P + '?ks2=a&row=0&tip=row&hover=2' + T1, [['key', 'j'], ['key', 'j']])
f('ks2-a-result', P + '?ks2=a&row=0&tip=close' + T1, [['key', 'j'], ['key', 'j'], ['key', 'Enter']])
f('ks2-a-hard-1512', P + '?ks2=a&row=2&tip=grip&hover=2', width=1512, theme='dark', role='commenter')
f('ks2-b-rest', P + '?ks2=b&row=0')
f('ks2-b-open', P + '?ks2=b&row=0&hover=2')
f('ks2-b-mid', P + '?ks2=b&row=0&hover=2', [['key', 'j']])
f('ks2-b-result', P + '?ks2=b&row=0' + T1, [['key', 'j'], ['key', 'Enter']])
f('ks2-b-hard-1512', P + '?ks2=b&row=0&hover=0&long=1', width=1512, theme='dark')
f('ks2-c-rest', P + '?ks2=c')
f('ks2-c-open', P + '?ks2=c&nudge=1')
f('ks2-c-mid', P + '?ks2=c&nudge=1', [['key', 'j']])
f('ks2-c-result', P + '?ks2=c&nudge=1', [['key', 'j'], ['click', 'text=Got it']])
f('ks2-c-hard-1512', P + '?ks2=c&nudge=1', [['click', '[data-testid=prio-title]']], width=1512, theme='dark')
f('ks2-d-rest', P + '?ks2=d&row=0')
f('ks2-d-open', P + '?ks2=d&row=0', [['key', '?']])
f('ks2-d-mid', P + '?ks2=d&row=0', [['key', 'j']])
f('ks2-d-result', P + '?ks2=d&row=0' + T1, [['key', 'j'], ['key', 'Enter']])
f('ks2-d-hard-1512', P + '?ks2=d&row=0&long=1', [['key', 'Enter']], width=1512, theme='dark')

# KS3: typing, dialogs, phone
for o in 'abc':
    f(f'ks3-{o}-rest', P + f'?ks3={o}&row=2', [['key', 'Enter']])
    f(f'ks3-{o}-open', P + f'?ks3={o}&row=2', [['key', 'Enter'], NOTES])
    f(f'ks3-{o}-mid', P + f'?ks3={o}&row=2', [['key', 'Enter'], NOTES, TYPE, ['type', ' jk']])
    last = ['press', 'Control+Enter'] if o == 'b' else ['press', 'Escape']
    f(f'ks3-{o}-result', P + f'?ks3={o}&row=2', [['key', 'Enter'], NOTES, TYPE, ['type', ' jk'], last])
    hard = {
        'a': [['key', 'Shift+J'], ['type', 'jk']],
        'b': [['key', 'Shift+J'], ['type', 'Ready sooner']],
        'c': [['key', 'Shift+J'], ['type', 'Ready sooner'], ['press', 'Tab'], ['press', '?']],
    }[o]
    f(f'ks3-{o}-hard-1512', P + f'?ks3={o}&row=3', hard, width=1512, theme='dark')
for o in 'abc':
    f(f'ks3-{o}-phone-390', P + f'?ks3={o}' + ('&swipe=1' if o == 'c' else ''), [THIRD], width=390)

# phone 390 for KS1 and KS2, the viewer and commenter frames, and Detailed's focus look
for o in 'abcd':
    f(f'ks1-{o}-phone-390', P + f'?ks1={o}&open=1', width=390)
    f(f'ks2-{o}-phone-390', P + f'?ks2={o}&row=0' + ('&nudge=1' if o == 'c' else ''), width=390)
f('ks1-b-viewer', P + '?ks1=b&row=0&open=1', role='viewer')
f('ks1-b-commenter', P + '?ks1=b&row=0&open=1', role='commenter')
f('ks2-a-viewer', P + '?ks2=a&row=1&tip=grip&hover=1', role='viewer')
f('ks2-a-detailed', D + '?ks2=a&row=0')

json.dump(F, open('frames.json', 'w'), indent=1)
print(len(F))
