import json
F=[]
def add(file,q,dev="desktop",theme="light",w=1440): F.append(dict(file=file,q=q,dev=dev,theme=theme,w=w))
G="&fmt=gantt"; H="&phase=hard&many=1&fmt=gantt"
# MS1
for st in ["rest","open","mid","done","second"]: add(f"ms1-a-{st}", f"ms1=a&phase={st}")
add("ms1-a-done-gantt","ms1=a&phase=done"+G); add("ms1-a-board","ms1=a&phase=board&fmt=board"); add("ms1-a-hard-1512","ms1=a"+H,w=1512)
add("ms1-a-dark","ms1=a&phase=done",theme="dark")
for st in ["rest","open","mid","done","second"]: add(f"ms1-b-{st}", f"ms1=b&phase={st}")
add("ms1-b-done-gantt","ms1=b&phase=done"+G); add("ms1-b-hard-1512","ms1=b"+H); add("ms1-b-dark","ms1=b&phase=done"+G,theme="dark",w=1512)
for st in ["rest","open","done","second"]: add(f"ms1-c-{st}", f"ms1=c&phase={st}")
add("ms1-c-done-gantt","ms1=c&phase=done"+G); add("ms1-c-hard-1512","ms1=c"+H); add("ms1-c-dark","ms1=c&phase=done"+G,theme="dark",w=1512)
for st in ["rest","open","mid","done","second"]: add(f"ms1-d-{st}", f"ms1=d&phase={st}")
add("ms1-d-done-gantt","ms1=d&phase=done"+G); add("ms1-d-hard-1512","ms1=d"+H); add("ms1-d-dark","ms1=d&phase=done"+G,theme="dark",w=1512)
# MS2
for o in "abc":
    for st in ["rest","open","mid","done","second"]: add(f"ms2-{o}-{st}", f"ms2={o}&phase={st}")
    add(f"ms2-{o}-done-gantt",f"ms2={o}&phase=done"+G); add(f"ms2-{o}-hard-1512",f"ms2={o}"+H,w=1512)
    add(f"ms2-{o}-dark",f"ms2={o}&phase=done"+G,theme="dark")
add("ms2-a-move","ms2=a&phase=move"); add("ms2-a-removed","ms2=a&phase=removed")
# MS3
for st in ["rest","open","mid","done"]: add(f"ms3-a-{st}", f"ms3=a&phase={st}")
add("ms3-a-done-gantt","ms3=a&phase=done"+G); add("ms3-a-hard-1512","ms3=a"+H); add("ms3-a-dark","ms3=a&phase=done",theme="dark",w=1512)
for st in ["rest","open","mid"]: add(f"ms3-b-{st}", f"ms3=b&phase={st}")
add("ms3-b-hard-1512","ms3=b"+H); add("ms3-b-dark","ms3=b&phase=rest",theme="dark",w=1512)
for st in ["rest","open","done"]: add(f"ms3-c-{st}", f"ms3=c&phase={st}")
add("ms3-c-done-gantt","ms3=c&phase=done"+G); add("ms3-c-hard-1512","ms3=c"+H); add("ms3-c-dark","ms3=c&phase=done",theme="dark",w=1512)
# phones last
P="phone"
add("ms1-a-phone","ms1=a&phase=mid"+G,P); add("ms1-a-phone-done","ms1=a&phase=done"+G,P); add("ms1-a-phone-dark","ms1=a&phase=done"+G,P,"dark")
add("ms1-b-phone","ms1=b&phase=open"+G,P); add("ms1-c-phone","ms1=c&phase=open"+G,P); add("ms1-d-phone","ms1=d&phase=rest"+G,P)
add("ms2-a-phone","ms2=a&phase=done"+G,P); add("ms2-b-phone","ms2=b&phase=mid"+G,P); add("ms2-c-phone","ms2=c&phase=done"+G,P)
add("ms3-a-phone","ms3=a&phase=open"+G,P); add("ms3-b-phone","ms3=b&phase=open"+G,P); add("ms3-c-phone","ms3=c&phase=done"+G,P)
json.dump(F,open("frames.json","w"),indent=0); print(len(F))
