// Every frame of mk-goal-ladder: its URL switches (MOCK-HOOK in the web code), size, scroll and caption.
const M = "/simple/goals?";
const R = "/simple/roadmap?";
const W = [1512, 900];
const P = [390, 844];
const F15 = '[data-ld-card="f15"]';
const F3 = '[data-ld-card="f3"]';
const F24 = '[data-ld-card="f24"]';
export const FRAMES = [
  // LD1 a: the Goal map becomes the ladder
  { file: "ld1-a-rest", url: M + "ld1=a", caption: "At rest: the period strip with today and each milestone's week, the guardrail, four goal columns in priority order, each goal's milestones as key-result cards" },
  { file: "ld1-a-work", url: M + "ld1=a", scrollSel: F15, caption: "Scrolled down: under the milestones, the work behind each one, every feature with its code, name, status in colour and dates; ←2 and 3→ count what it waits on and what waits on it" },
  { file: "ld1-a-rest-1512", url: M + "ld1=a", size: W, scrollSel: '[data-ld-nogoal]', caption: "Hard case at 1512, the end of the page: all 65 features under their 12 milestones; the goal with the most work sets the page's length, and the two features with no goal sit in their own row at the end" },
  { file: "ld1-a-viewer", url: M + "ld1=a&as=viewer", caption: "A viewer: the same ladder marked Read only; no Edit ladder button" },
  { file: "ld1-a-phone", url: M + "ld1=a", size: P, caption: "Phone: one goal at a time picked from Goal 1 to Goal 4, each milestone with its features under it" },
  // LD1 b: a Ladder format on the Roadmap
  { file: "ld1-b-rest", url: R + "ld1=b", caption: "Roadmap, Ladder format beside Timeline and Gantt: columns grouped by period like the board, each period with its week chips; a goal has a column in every period it has a milestone due" },
  { file: "ld1-b-scrolled", url: R + "ld1=b", hscroll: 520, caption: "Scrolled right into Q1 2027: Goal 1 again as a name line, with M2 and M3 and their work under it" },
  { file: "ld1-b-rest-1512", url: R + "ld1=b", size: W, scroll: 420, caption: "Hard case at 1512: the two periods side by side make the page about 2,200 wide; it scrolls sideways at every width" },
  { file: "ld1-b-viewer", url: R + "ld1=b&as=viewer", caption: "A viewer on the Ladder format: Read only, no Edit ladder" },
  { file: "ld1-b-commenter", url: R + "ld1=b&as=commenter&edit=1&st=moved", scrollSel: F15, caption: "A commenter suggesting (the button reads Done suggesting): F-15 dragged to M6 stays where it is, marked Suggested: move to M6, and goes to an approver" },
  // LD1 c: the Goal map's grid with the ladder top and arrows
  { file: "ld1-c-rest", url: M + "ld1=c&ld2=b", caption: "The Goal map's grid as built, areas by milestones, with each goal card over its own milestone columns, the period strip on top and every dependency drawn as an arrow" },
  { file: "ld1-c-rest-1512", url: M + "ld1=c&ld2=b", size: W, scroll: 480, caption: "Hard case at 1512: twelve milestone columns at 200 wide each; the grid scrolls sideways and the arrows cross the areas" },
  { file: "ld1-c-select", url: M + "ld1=c&ld2=b&sel=f3", scroll: 480, scrollSel: F3, caption: "F-03 picked in the grid: its arrows lit, the rest dimmed" },
  { file: "ld1-c-viewer", url: M + "ld1=c&ld2=b&as=viewer", caption: "A viewer: the grid with its arrows, Read only" },
  // LD1 d: a pan and zoom canvas
  { file: "ld1-d-rest", url: M + "ld1=d", caption: "A canvas like the board: the same ladder at 72%, with zoom, Fit, Tidy up and a small overview; cards can be dragged anywhere" },
  { file: "ld1-d-rest-1512", url: M + "ld1=d", size: W, caption: "Hard case at 1512: at 72% the four goals fit, but feature names are small and most of the work is below the canvas edge" },

  { file: "ld1-d-placed", url: M + "ld1=d&st=placed", caption: "F-15 dragged by hand into the free space right of Goal 4, with Undo: the canvas now shows it where its goal and milestone do not put it, for everyone, until Tidy up puts it back" },
  { file: "ld1-d-viewer", url: M + "ld1=d&as=viewer", caption: "A viewer can pan and zoom but not move cards: no Tidy up" },
  // LD2 a: arrows only for the picked card, counts on each card
  { file: "ld2-a-rest", url: M + "ld1=a&ld2=a", scrollSel: F3, caption: "At rest: no arrows; each card counts what it waits on (←) and what waits on it (→)" },
  { file: "ld2-a-select", url: M + "ld1=a&ld2=a&sel=f3", scrollSel: F3, caption: "F-03 Renewal health score picked: what it waits on and what waits on it lit; the rest dimmed" },
  { file: "ld2-a-draw", url: M + "ld1=a&ld2=a&edit=1&st=draw&sel=f34", scrollSel: F24, caption: "Editing: dragging from F-34's edge dot onto F-24 draws the new arrow; F-24 lights up as the drop" },
  { file: "ld2-a-linked", url: M + "ld1=a&ld2=a&edit=1&st=linked&sel=f24", scrollSel: F24, caption: "Dropped: F-24 now waits on F-34, its arrows lit, with Undo" },
  { file: "ld2-a-arrow", url: M + "ld1=a&ld2=a&edit=1&st=arrow&sel=f3", scrollSel: F3, caption: "An arrow picked: F-02 to F-03 drawn thick; its pop-up says F-03 waits on F-02, with Remove" },
  { file: "ld2-a-unlinked", url: M + "ld1=a&ld2=a&edit=1&st=unlinked&sel=f3", scrollSel: F3, caption: "Removed: F-03 no longer waits on F-02, with Undo; F-03 no longer shows ←1" },
  { file: "ld2-a-loop", url: M + "ld1=a&ld2=a&edit=1&st=loop&sel=f2", scrollMid: ['[data-ld-card="f2"]', '[data-ld-card="f4"]'], caption: "A loop refused: the arrow drawn from F-04 onto F-02 stays red and dashed, and the message says why: F-04 already waits on F-02" },
  { file: "ld2-a-commenter", url: M + "ld1=a&ld2=a&edit=1&st=linked&sel=f24&as=commenter", scrollSel: F24, caption: "A commenter's same drag: the ladder stays as it was, F-24 shows the suggestion and it goes to an approver" },
  { file: "ld2-a-select-1512", url: M + "ld1=a&ld2=a&sel=f2", size: W, scrollSel: '[data-ld-card="f3"]', caption: "Hard case at 1512: F-02, the most waited-on feature, picked; its arrows reach into Goal 1 and Goal 4" },
  // LD2 b: all arrows drawn
  { file: "ld2-b-rest", url: M + "ld1=a&ld2=b", scrollSel: F3, caption: "Every dependency drawn as a thin arrow, all the time" },
  { file: "ld2-b-select", url: M + "ld1=a&ld2=b&sel=f3", scrollSel: F3, caption: "F-03 picked: its arrows lit on top of the rest" },
  { file: "ld2-b-rest-1512", url: M + "ld1=a&ld2=b", size: W, scrollSel: '[data-ld-card="f22"]', caption: "Hard case at 1512: 40 arrows over 65 cards; they fill the gaps between cards and pass under them, so one link is hard to follow" },
  { file: "ld2-b-viewer", url: M + "ld1=a&ld2=b&as=viewer", scrollSel: F3, caption: "A viewer sees every arrow; nothing to drag" },
  // LD2 c: chips, no arrows
  { file: "ld2-c-rest", url: M + "ld1=a&ld2=c", scrollSel: F3, caption: "No arrows: each card lists what it waits on as chips with the feature's code and name" },
  { file: "ld2-c-pick", url: M + "ld1=a&ld2=c&edit=1&st=pick", scrollSel: F24, caption: "Editing: + Waits on on F-24 opens a picker; typing 'report' finds F-34 Cross-team reports" },
  { file: "ld2-c-linked", url: M + "ld1=a&ld2=c&edit=1&st=linked", scrollSel: F24, caption: "Picked: F-24 shows Waits on F-34, with Undo; × on a chip removes it" },
  { file: "ld2-c-viewer", url: M + "ld1=a&ld2=c&as=viewer", scrollSel: F24, caption: "A viewer reads the chips; no × and no + Waits on" },

  { file: "ld2-c-commenter", url: M + "ld1=a&ld2=c&edit=1&st=linked&as=commenter", scrollSel: F24, caption: "A commenter picks F-34 the same way: F-24 shows Suggested: wait on F-34, sent to an approver" },
  // LD3 b: an Edit toggle
  { file: "ld3-b-rest", url: M + "ld1=a&ld3=b", scrollSel: F15, caption: "At rest the ladder is clean: no handles, no + slots; Edit ladder in the header" },
  { file: "ld3-b-edit", url: M + "ld1=a&ld3=b&edit=1", scrollMid: ['[data-ld-goal="g2"]', F15], caption: "Edit ladder on: grips, ⋯ menus on goals, milestones and features, + Add at each level, each milestone's work a drop zone; the button reads Done" },
  { file: "ld3-b-drag", url: M + "ld1=a&ld3=b&edit=1&st=drag", scrollMid: [F15, '[data-ld-group="m6"]'], caption: "Dragging F-15 Invite the whole team from M4 to M6: its old place in M4 dashed, the drop place at the top of M6 outlined" },
  { file: "ld3-b-moved", url: M + "ld1=a&ld3=b&edit=1&st=moved", scrollSel: '[data-ld-group="m6"]', caption: "Dropped: F-15 now serves M6, with Undo" },
  { file: "ld3-b-menu", url: M + "ld1=a&ld3=b&edit=1&st=menu", scrollSel: F15, caption: "F-15's ⋯ menu, under the card: Open, Move to…, Move up, Move down, Waits on…, and Delete (to Trash), which is picked" },
  { file: "ld3-b-deleted", url: M + "ld1=a&ld3=b&edit=1&st=deleted", scrollSel: '[data-ld-group="m4"]', caption: "Deleted: F-15 goes to Trash, with Open Trash and Undo" },
  { file: "ld3-b-add", url: M + "ld1=a&ld3=b&edit=1&st=add", scrollSel: '[data-ld-group="m5"]', caption: "+ Add feature under M5 opens a name field in place" },
  { file: "ld3-b-added", url: M + "ld1=a&ld3=b&edit=1&st=added", scrollSel: '[data-ld-group="m5"]', caption: "Added: F-66 under M5, marked New, with Undo" },
  { file: "ld3-b-commenter", url: M + "ld1=a&ld3=b&edit=1&st=moved&as=commenter", scrollSel: F15, caption: "A commenter suggesting (the button reads Done suggesting): the same drag leaves F-15 where it is, marked Suggested: move to M6, and goes to an approver" },
  { file: "ld3-b-viewer", url: M + "ld1=a&ld3=b&as=viewer", scrollSel: F15, caption: "A viewer: Read only, no Edit ladder button" },
  { file: "ld3-b-edit-1512", url: M + "ld1=a&ld3=b&edit=1", size: W, scrollSel: '[data-ld-card="f22"]', caption: "Hard case at 1512 while editing: the + slots and drop zones add a line under every milestone" },
  { file: "ld3-b-phone", url: M + "ld1=a&ld3=b&edit=1&st=menu", size: P, caption: "Phone while editing: no drag and no grips; Move to… opens a sheet of every goal's milestones" },
  // LD3 a: always editable
  { file: "ld3-a-rest", url: M + "ld1=a&ld3=a", scrollSel: F15, caption: "Always editable for an owner: grips, ⋯ and + Add show on every card all the time" },
  { file: "ld3-a-drag", url: M + "ld1=a&ld3=a&st=drag", scrollMid: [F15, '[data-ld-group="m6"]'], caption: "The same drag of F-15 to M6, with no mode to turn on first" },
  { file: "ld3-a-moved", url: M + "ld1=a&ld3=a&st=moved", scrollSel: '[data-ld-group="m6"]', caption: "Dropped, with Undo" },
  { file: "ld3-a-rest-1512", url: M + "ld1=a&ld3=a", size: W, scrollSel: '[data-ld-card="f22"]', caption: "Hard case at 1512: the handles on all 65 cards and 12 + slots stay on the scoreboard for every reading" },
  { file: "ld3-a-commenter", url: M + "ld1=a&ld3=a&st=moved&as=commenter", scrollSel: F15, caption: "A commenter's drag: F-15 stays, marked Suggested: move to M6" },
  { file: "ld3-a-viewer", url: M + "ld1=a&ld3=a&as=viewer", scrollSel: F15, caption: "A viewer: no handles, Read only" },
  // LD3 c: menu and keyboard first
  { file: "ld3-c-menu", url: M + "ld1=a&ld3=c&st=menu", scrollSel: F15, caption: "Each card's ⋯ menu with keys: Move to… (M), Move up and down (Alt ↑ ↓), Delete (Del)" },
  { file: "ld3-c-moveto", url: M + "ld1=a&ld3=c&st=moveto", scrollSel: F15, caption: "Move to… lists every goal's milestones; M6 picked" },
  { file: "ld3-c-moved", url: M + "ld1=a&ld3=c&st=moved", scrollSel: '[data-ld-group="m6"]', caption: "Moved to M6, with Undo" },
  { file: "ld3-c-commenter", url: M + "ld1=a&ld3=c&st=moved&as=commenter", scrollSel: F15, caption: "A commenter's Move to… makes a suggestion: F-15 stays under M4, marked Suggested: move to M6, sent to an approver" },
  { file: "ld3-c-phone", url: M + "ld1=a&ld3=c&st=menu", size: P, caption: "Phone: the same Move to… sheet" },
];
