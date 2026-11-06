// Writes ../picks.json from the frame list (captions) and the decisions below. Usage: node picks.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMES } from "./frames.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const fr = (prefix) => FRAMES.filter((f) => f.file.startsWith(prefix + "-")).map((f) => ({ file: `frames/${f.file}.html`, caption: f.caption }));

const picks = {
  title: "Goal ladder",
  subtitle: "Goals, their milestones and the features behind them, with what each feature waits on, laid out like the OKR ladder board, and every part of it added, changed, moved or deleted on the page.",
  decisions: [
    {
      code: "LD1",
      name: "Ladder layout",
      question: "Where does the ladder live, and how do goals, milestones and features stack?",
      common: "Invented data at real volume: 4 goals and a guardrail, 12 milestones, 65 features, 55 dependencies (some across goals), one feature serving two milestones, two with no goal, every status. Every proposal keeps the guardrail as a strip (never a goal card), joins no goal to another, shows each feature's code and name, status in colour (Done green, In progress blue, Planning and Backlog orange, Not on the eng board yet red) and its dates, month first. A feature is drawn once; its second milestone points to it. Clicking a feature opens the one feature panel as built (details, depends on and what depends on it, dates, goal and measure, all editable). There is no yearly goal box: Oracle has no goal above the goals, so the title and its one line sit there.",
      proposals: [
        { letter: "a", name: "Goal map becomes ladder", recommended: true,
          what: "The Goal map turns into the ladder. On top, the period strip: Rest of 2026 and Q1 2027 as week chips, today filled and named We are here, each milestone's week filled and named under it. Then the guardrail strip, then the goals as four columns in priority order. Under each goal card, straight stems down to a tinted column of its milestones as key-result cards (code, name, reading of target, date, area and status in colour), then a tinted column of the work behind it: each milestone's features under its name. Features with no goal sit in one row at the end. A phone shows one goal at a time.",
          why: "It is the board's shape on the page the owner already keeps as the scoreboard, so every gate keeps its reading and gaps stay flagged in one place. It scrolls only down at 1440 and 1512, never sideways, and the goal columns never touch, so nothing joins one goal to another.",
          plus: "One page for goals, milestones, features and their links; the readings stay; no sideways scroll; the phone keeps one goal at a time.",
          cost: "The areas by milestones grid (the earlier pick) goes; area becomes a word on each card. The longest goal column sets the page's length (about 4 screens at full volume). Web: the Goal map page redrawn as columns and a period strip read from milestone dates. API: no new change ops; it reuses set_milestone, set_goal, set_depends, add_item, delete_item, reorder, edit_goal_milestone and set_goal_measure, and the goal map read gains each feature's status, dates and depends.",
          frames: fr("ld1-a") },
        { letter: "b", name: "Ladder on the Roadmap", recommended: false,
          what: "A new Ladder format on the Roadmap beside Timeline, Gantt, Now / Next / Later and Waterfall. Columns are grouped by period like the board: each period has its week chips, and a goal gets a column in every period it has a milestone due, its milestones and their features under it. Milestones with no date sit in a last column. One labelled arrow joins two milestone columns of the same goal where a baseline sets the next target.",
          plus: "Closest to the board's period columns; time reads left to right; it sits with the other roadmap formats, so the roadmap filters apply.",
          cost: "About 2,400 wide at full volume: it scrolls sideways at every width and a goal's card shows once per period. The Goal map stays a separate scoreboard, so the same features show on two pages. Web: a fifth roadmap format. API: no new change ops (the same set_milestone, set_goal, set_depends, add_item, delete_item, reorder); the roadmap read gains milestones with their periods.",
          frames: fr("ld1-b") },
        { letter: "c", name: "Grid with arrows", recommended: false,
          what: "The Goal map's grid stays as built (areas as rows, milestones as columns), with the goal cards and the period strip on top and the dependencies drawn as arrows between the cards.",
          plus: "Smallest change; the earlier pick stays; areas stay rows.",
          cost: "Twelve milestone columns scroll sideways; most cells are empty; arrows cross area rows and run off screen. It does not read like the board. Web: an arrow layer on the grid. API: none new.",
          frames: fr("ld1-c") },
        { letter: "d", name: "Free canvas", recommended: false,
          what: "The ladder on a pan-and-zoom canvas like the board itself: cards start where the ladder places them and can be dragged anywhere; zoom, Fit, Tidy up and an overview in the corners.",
          plus: "Feels most like the board; people can arrange a corner for a meeting.",
          cost: "At a zoom that fits the four goals the names are about 10 pt; cards moved by hand drift from where the ladder would put them, so the page can say something the data does not. Saved positions per person. Web: a canvas with zoom and pan. API: a new place_card op (a card's position) on top of the ops in a.",
          frames: fr("ld1-d") },
      ],
    },
    {
      code: "LD2",
      name: "Dependencies on the ladder",
      question: "How do dependencies show on the ladder, and how is one added or removed?",
      common: "Shown on proposal LD1 a. A dependency reads the same everywhere: F-24 waits on F-34. Adding one that would make a loop is refused, with the reason behind (i). A commenter's same gesture makes a suggestion that goes to an approver; a viewer reads. The feature panel's Depends on stays as built, so every proposal can also add and remove there. Every add or remove has Undo.",
      proposals: [
        { letter: "a", name: "Arrows for the picked card", recommended: true,
          what: "No arrows at rest: each card counts what it waits on (←2) and what waits on it (3→). Picking a card lights its arrows both ways, across goals too, and dims the rest. While editing, a picked card shows a dot on its edge: drag from it onto another card to add the link. Pick an arrow to see which card waits on which, with Remove.",
          why: "With 55 links on 65 cards only the picked card's arrows stay readable; the counts still flag the busy cards at rest, and the drag from a dot is the board's own gesture.",
          plus: "Clean scoreboard at rest; the links of one card read at a glance, across goals; adding is one drag.",
          cost: "A link is seen only by picking a card; a printout shows counts, not arrows. Web: an arrow layer measured from the cards, the edge dot and the arrow pop-up. API: no new op; set_depends adds and removes, and the loop check the change engine has refuses the loop.",
          frames: fr("ld2-a") },
        { letter: "b", name: "Arrows always drawn", recommended: false,
          what: "Every dependency drawn as a thin arrow all the time; picking a card lights its own.",
          plus: "Every link is on the page with no click; reads like the board's arrows.",
          cost: "55 arrows over 65 cards: links inside one column bow over the next column's cards and the page reads as a net at 1440 and 1512. Web: the same arrow layer as a. API: none new (set_depends).",
          frames: fr("ld2-b") },
        { letter: "c", name: "Waits-on chips", recommended: false,
          what: "No arrows: each card lists what it waits on as chips with the feature's code and name. While editing, + Waits on opens a picker to search a feature; × on a chip removes it.",
          plus: "Readable at any size, on a phone and on paper; no layout work.",
          cost: "Only one direction shows on a card (what waits on it is in the panel); cards grow by a line per link. Web: chips and a picker. API: none new (set_depends).",
          frames: fr("ld2-c") },
      ],
    },
    {
      code: "LD3",
      name: "Changing the ladder",
      question: "How are goals, milestones and features added, changed, moved and deleted on the ladder?",
      common: "Shown on proposals LD1 a and LD2 a. Who may act goes through each item's can_change and can_propose: owners and approvers change, a commenter's same gesture makes a suggestion marked on the card, a viewer reads (Read only, reason behind a tooltip). Delete sends to Trash (restorable) with Undo; every change shows its result with Undo. Moving a feature to a milestone of another goal sets its goal too. The ⋯ menu on goals and milestones offers Edit and Delete like the Goal map's today.",
      proposals: [
        { letter: "b", name: "Edit ladder toggle", recommended: true,
          what: "At rest the ladder is clean. Edit ladder in the header shows grips, ⋯ menus on goals, milestones and features, + Add at each level and each milestone's work as a drop zone; the button reads Done. Drag a feature to another milestone or goal or to a new place in its list; the ⋯ menu has Open, Move to…, Move up, Move down, Waits on… and Delete (to Trash). A phone has no drag: Move to… opens a sheet.",
          why: "The owner keeps this page as the scoreboard: at rest it reads like the board, and one click turns on every add, move and delete without leaving it.",
          plus: "Clean board for reading and meetings; every change in one mode; the same toggle reads Suggest changes for a commenter.",
          cost: "One more click before a change. Web: the toggle, grips, drop zones, + slots and menus. API: reuses set_milestone, set_goal, reorder, add_item, delete_item and edit_goal_milestone; adds add_goal_milestone and delete_goal_milestone (to Trash) so a milestone can be added and deleted here.",
          frames: fr("ld3-b") },
        { letter: "a", name: "Always editable", recommended: false,
          what: "For those who may, the grips, ⋯ menus and + Add show on every card all the time; drag at any moment.",
          plus: "No mode; the fastest change.",
          cost: "Handles on all 65 cards and twelve + slots sit on the scoreboard for every reading, and a stray drag moves a feature (Undo fixes it). Web and API as in b.",
          frames: fr("ld3-a") },
        { letter: "c", name: "Menu and keys first", recommended: false,
          what: "No drag. Each card's ⋯ menu has Move to… (M), Move up and down (Alt ↑ ↓) and Delete (Del); Move to… lists every goal's milestones.",
          plus: "Works the same on a phone and with a keyboard; no stray drags.",
          cost: "Moving is three clicks instead of one drag; reordering a long list is many key presses. Web: menus, a Move to dialog, keys. API as in b.",
          frames: fr("ld3-c") },
      ],
    },
  ],
};
fs.writeFileSync(path.join(here, "..", "picks.json"), JSON.stringify(picks, null, 2) + "\n");
console.log("picks.json", picks.decisions.map((d) => `${d.code}: ${d.proposals.map((p) => `${p.letter}=${p.frames.length}`).join(" ")}`).join(" | "));
