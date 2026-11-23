# mk-prd-review: hand-off

## Today's friction, checked in the mock app (Nov 23, mock build, signed in as the mock owner)

- Roadmap feature panel (F-01 Setup checklist): 15 'Change' links; each opens its field with Save and Cancel,
  so every field is open, edit, Save (3 to 4 clicks per field).
- Roadmap add: the field says "Type a title, then drag it into place" (click, type, drag); dates, owner and
  goal are then set one 'Change' at a time in the panel.
- A draft with no owner is a flag; picking the owner is a separate trip (Pick an owner, then the list, then Save).
- Milestones are added from the axis's "+ Milestone" hint, apart from the items: pick a kind, name it, Propose.
- One-pager: features are bullet lines with flow boxes; owners and dates are not on the line; edits show in a
  "Changes and proposals" margin, apart from the line they change.

## How to see the variants

`cd web && npm run dev:mock`, sign in, then `/simple/one-pagers/<any>?pr1=a|b|c|d`, `?pr2=a|b|c`, `?pr3=a|b|c|d`,
with `&phase=open|mid|done`, `&task=section|feature|owner|date|milestone`, `&big=1`, `&who=viewer`;
the roadmap result: `/simple/roadmap?mkprd=1&phase=done&pr2=a`. Every hook line is marked MOCK-HOOK.

## Notes

- The live browser only has the desktop (1440x900) and phone-390 presets; 1512 frames are drawn with the page
  zoomed to 1440/1512, so their layout is 1512 wide (the PNG is 1440 px across, the html says 1512x945).
- Frame states come from URL switches; pr2-a-feature-added is the Enter actually pressed in the add row.

## Review round (Nov 23)

- The add story uses one feature throughout: F-227 Bulk reply to similar requests, Mara Quint (the PRD's owner),
  Feb 1 – Feb 26, after Reply templates; the owner-open frames already carry it. The roadmap result no longer
  adds a milestone, so its header counts the 3 changes it marks.
- Owner lists are drawn open as a list (a native list can't be snapshotted open), the pointer on Dot Varga.
- Still true: the live browser has no 1512 preset, so *-long-1512 frames remain 1440 px PNGs of a 1512 layout.
