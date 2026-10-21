/**
 * Mock of the brief and full layers (O1f): which sections are brief, presenter notes,
 * the deck Present mode shows, and the Brief / Full / Deck exports. The real API
 * renders slides server-side (oracle.export.deck); this is a small stand-in with the
 * same shape.
 */
import type { Schemas } from "@/lib/api/client";
import { parseBlocks, type Block, type Inline } from "@/lib/markdown";

type Section = { section_key: string; level: number; heading: string; body_md: string; layer?: Schemas["SectionOut"]["layer"] };
type Layered = { brief_source: Schemas["VersionOut"]["brief_source"]; brief: Set<string> };

const NOTES = /^```[ \t]*notes[ \t]*\n([\s\S]*?)^```[ \t]*$\n?/gm;
const COMMENT = /<!--([\s\S]*?)-->/g;
const LINK = /\]\(#([A-Za-z0-9][\w.:-]*)\)/g;

/** Front matter brief, else the sections before a level-1 {#full} heading (minus the title). */
export function resolveBrief(sections: { section_key: string; level: number }[], brief?: string[]): Layered {
  const keys = sections.map((s) => s.section_key);
  const sources = keys.indexOf("sources");
  const excluded = new Set(["full", ...(sources >= 0 ? keys.slice(sources) : [])]);
  if (brief) return { brief_source: "draft", brief: new Set(brief.filter((k) => keys.includes(k) && !excluded.has(k))) };
  const full = sections.findIndex((s) => s.section_key === "full" && s.level === 1);
  if (full > 0) {
    const before = sections.slice(sections[0].level === 1 ? 1 : 0, full).map((s) => s.section_key);
    if (before.length) return { brief_source: "full_heading", brief: new Set(before) };
  }
  return { brief_source: "none", brief: new Set() };
}

export function slideBody(md: string): string {
  return md.replace(NOTES, "").replace(COMMENT, "").trim();
}

/** Presenter notes come only from ```notes blocks (O1g); guidance is never used. */
export function presenterNotes(md: string): string | null {
  const notes = [...md.matchAll(NOTES)].map((m) => m[1].trim()).filter(Boolean);
  return notes.length ? notes.join("\n\n") : null;
}

function linked(md: string): string[] {
  return [...new Set([...slideBody(md).matchAll(LINK)].map((m) => m[1]))];
}

/** The section and the deeper sections after it. */
export function subtree<T extends { section_key: string; level: number }>(sections: T[], key: string): T[] {
  const i = sections.findIndex((s) => s.section_key === key);
  if (i < 0) return [];
  const out = [sections[i]];
  for (const s of sections.slice(i + 1)) {
    if (s.level <= sections[i].level) break;
    out.push(s);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(nodes: Inline[], links: (key: string, inner: string) => string): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return esc(n.v);
        case "code":
          return `<code>${esc(n.v)}</code>`;
        case "strong":
          return `<strong>${inline(n.c, links)}</strong>`;
        case "em":
          return `<em>${inline(n.c, links)}</em>`;
        case "link":
          return n.href.startsWith("#") ? links(n.href.slice(1), inline(n.c, links)) : `<a href="${esc(n.href)}">${inline(n.c, links)}</a>`;
        case "img":
          return /^https:\/\//i.test(n.src) ? `<img src="${esc(n.src)}" alt="${esc(n.alt)}">` : "";
        case "cite":
          return "";
      }
    })
    .join("");
}

export function toHtml(md: string, links: (key: string, inner: string) => string): string {
  const blocks: Block[] = parseBlocks(slideBody(md));
  return blocks
    .map((b) => {
      switch (b.t) {
        case "p":
          return `<p>${inline(b.c, links)}</p>`;
        case "h":
          return `<h4>${inline(b.c, links)}</h4>`;
        case "quote":
          return `<blockquote>${inline(b.c, links)}</blockquote>`;
        case "pre":
          return "";
        case "ul":
        case "ol":
          return `<${b.t}>${b.items.map((it) => `<li>${inline(it, links)}</li>`).join("")}</${b.t}>`;
        case "table":
          return `<table><thead><tr>${b.head.map((c) => `<th>${inline(c, links)}</th>`).join("")}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, links)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`;
      }
    })
    .join("");
}

const DECK_CSS = `
.deck { --font-body: "DejaVu Sans", Helvetica, Arial, sans-serif; --color-text: #1f2933; --color-heading: #111827;
  --color-muted: #5b6472; --color-accent: #2f5bd3; --color-background: #ffffff; --color-rule: #d9dde3; --color-surface: #f3f4f6;
  color: var(--color-text); font-family: var(--font-body); }
.deck .slide { box-sizing: border-box; position: relative; width: 960px; height: 540px; overflow: hidden; background: var(--color-background);
  font-size: 21px; line-height: 1.4; padding: 44px 60px 56px; display: flex; flex-direction: column; }
.deck .slide-inner { flex: 1; min-height: 0; overflow: hidden; }
.deck .slide-title { color: var(--color-heading); font-size: 34px; line-height: 1.15; margin: 0 0 22px; font-weight: 700; }
.deck h1.slide-title { font-size: 46px; }
.deck .slide-kicker { margin: 120px 0 10px; font: 600 15px/1 var(--font-body); text-transform: uppercase; letter-spacing: .12em; color: var(--color-accent); }
.deck .slide-subtitle { color: var(--color-muted); font-size: 19px; margin: 0; }
.deck .slide-source { color: var(--color-muted); font-size: 16px; margin: 8px 0 0; }
.deck .slide-body p, .deck .slide-body ul, .deck .slide-body ol { margin: 0 0 12px; }
.deck .slide-body table { border-collapse: collapse; width: 100%; font-size: 17px; }
.deck .slide-body th, .deck .slide-body td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--color-rule); }
.deck .slide-body th { color: var(--color-muted); font-size: 14px; text-transform: uppercase; }
.deck .slide-body a { color: var(--color-accent); text-decoration: none; }
.deck .expand { margin-left: 6px; font: 600 12px/1 var(--font-body); color: var(--color-accent); background: transparent;
  border: 1px solid var(--color-rule); border-radius: 4px; padding: 3px 6px; cursor: pointer; }
.deck .slide-footer { position: absolute; left: 60px; right: 60px; bottom: 18px; display: flex; justify-content: space-between;
  font-size: 12px; color: var(--color-muted); border-top: 1px solid var(--color-rule); padding-top: 8px; }
.deck .slide-sources { font-size: 16px; }
.deck .expand-section h3, .deck .expand-section h4 { color: var(--color-heading); margin: 0 0 10px; }
.theme-clean-document .slide-title { border-top: 4px solid var(--color-accent); padding-top: 14px; }
.theme-clean-document h1.slide-title { border-top: 0; padding-top: 0; }
`;

type DeckInput = {
  document_id: string;
  slug: string;
  title: string;
  number: number;
  latest: number;
  status: string;
  created_at: string;
  /** Provenance (O4b): the PRD version a roadmap version was built from. */
  source?: Schemas["VersionSource"] | null;
  sections: Section[];
  citations: { cite_key: string; title?: string | null; ref: string; source: string }[];
};

export function deckOut(d: DeckInput): Schemas["DeckOut"] {
  const sections = d.sections;
  const brief = sections.filter((s) => s.layer === "brief");
  const briefKeys = new Set(brief.map((s) => s.section_key));
  const detail = new Set(sections.filter((s) => s.layer !== "brief").map((s) => s.section_key));
  const sourceLabel = d.source ? `From ${d.source.title} v${d.source.version}` : null;
  const banner = [
    d.title,
    `Version ${d.number}`,
    d.status.replace("_", " "),
    `imported ${d.created_at.slice(0, 16).replace("T", " ")} UTC`,
    ...(sourceLabel ? [sourceLabel] : []),
  ].join(" · ");
  const slideLinks = (key: string, inner: string) =>
    briefKeys.has(key)
      ? `<a href="#${esc(key)}">${inner}</a>`
      : detail.has(key)
        ? `<span class="detail-ref" data-section-ref="${esc(key)}">${inner}</span><button type="button" class="expand" data-expand="${esc(key)}" aria-label="Expand ${esc(inner.replace(/<[^>]+>/g, ""))}">Expand</button>`
        : inner;
  const plainLinks = (_key: string, inner: string) => inner;
  type Raw = Omit<Schemas["SlideOut"], "html"> & { inner: string };
  const raw: Raw[] = [
    {
      index: 1,
      kind: "title",
      heading: d.title,
      expand: [],
      inner: `<p class="slide-kicker">Brief</p><h1 class="slide-title">${esc(d.title)}</h1><p class="slide-subtitle">Version ${d.number} · ${esc(d.status.replace("_", " "))}</p>${sourceLabel ? `<p class="slide-source">${esc(sourceLabel)}</p>` : ""}`,
    },
  ];
  for (const s of brief) {
    raw.push({
      index: raw.length + 1,
      kind: "section",
      heading: s.heading,
      section_key: s.section_key,
      notes: presenterNotes(s.body_md),
      expand: linked(s.body_md)
        .filter((k) => detail.has(k))
        .map((k) => ({
          section_key: k,
          heading: sections.find((x) => x.section_key === k)!.heading,
          html: subtree(sections, k)
            .map((x) => `<section class="expand-section" data-section-key="${esc(x.section_key)}"><h3>${esc(x.heading)}</h3>${toHtml(x.body_md, plainLinks)}</section>`)
            .join(""),
        })),
      inner: `<h2 class="slide-title">${esc(s.heading)}</h2><div class="slide-body">${toHtml(s.body_md, slideLinks)}</div>`,
    });
  }
  if (d.citations.length) {
    raw.push({
      index: raw.length + 1,
      kind: "sources",
      heading: "Sources and data points",
      expand: [],
      inner: `<h2 class="slide-title">Sources and data points</h2><ol class="slide-sources">${d.citations
        .map((c) => `<li>${esc(c.title ?? c.ref)} <span class="src-kind">${esc(c.source)}</span></li>`)
        .join("")}</ol>`,
    });
  }
  const total = raw.length;
  return {
    document_id: d.document_id,
    slug: d.slug,
    title: d.title,
    number: d.number,
    latest_number: d.latest,
    status: d.status,
    as_of: d.created_at,
    banner,
    source: d.source ?? null,
    theme: "clean-document",
    theme_name: "Clean document",
    theme_class: "theme-clean-document",
    css: DECK_CSS,
    slides: raw.map(({ inner, ...s }) => ({
      ...s,
      expand: s.expand ?? [],
      notes: s.notes ?? null,
      section_key: s.section_key ?? null,
      html: `<section class="slide slide--${s.kind}" data-slide="${s.index}"${s.section_key ? ` data-section-key="${esc(s.section_key)}"` : ""} aria-label="Slide ${s.index} of ${total}: ${esc(s.heading)}"><div class="slide-inner">${inner}</div><footer class="slide-footer"><span class="slide-banner">${esc(banner)}</span><span class="slide-number">${s.index} / ${total}</span></footer></section>`,
    })),
  };
}

export const LAYER_FORMATS: Record<string, string[]> = {
  full: ["html", "pdf", "md"],
  brief: ["html", "pdf"],
  deck: ["html", "pdf", "pptx"],
};

export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
