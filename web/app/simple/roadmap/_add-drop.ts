/** The add chip's drop places (data-add-where="kind:value"), moved out of _add.tsx. */
export function whereAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const t = el.closest<HTMLElement>('[data-add-where]');
    if (t) return t;
  }
  return null;
}

export function mark(el: HTMLElement | null, on: boolean) {
  if (!el) return;
  if (on) el.setAttribute('data-drop-target', 'true');
  else el.removeAttribute('data-drop-target');
  if (el instanceof SVGElement) el.style.fill = on ? 'var(--accent-soft)' : '';
  else el.style.outline = on ? '2px solid var(--accent)' : '';
}

/** roadmap-add: the track row under a drop (data-add-track="<track id>"), when the view draws tracks as rows. */
export function trackAt(x: number, y: number, tracks: { id: string }[]): string | undefined {
  for (const el of document.elementsFromPoint(x, y)) {
    const t = el.closest<HTMLElement>('[data-add-track]')?.getAttribute('data-add-track');
    if (t && tracks.some((k) => k.id === t)) return t;
  }
  return undefined;
}
