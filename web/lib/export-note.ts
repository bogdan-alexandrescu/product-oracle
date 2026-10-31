/**
 * e2e-pdf-export: what a download tells the person exporting. A one-page export that runs past
 * its page says so here (the API's X-Oracle-Overflow-Pages), never inside the document.
 */
export const OVERFLOW_HEADER = "X-Oracle-Overflow-Pages";

/** "PDF downloaded", and how many pages it runs to when it should fit one (`fix`: what to do). */
export function downloadedNote(label: string, res: Response | undefined, fix: string): string {
  const pages = Number(res?.headers.get(OVERFLOW_HEADER) ?? 0);
  return pages > 1 ? `${label} downloaded. It runs to ${pages} pages: ${fix}.` : `${label} downloaded`;
}
