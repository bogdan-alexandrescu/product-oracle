/**
 * chat-citations: the last line of defence for an answer's words. Every `[kind:id]` token
 * left in them ("[l:2]", "[c:c4]", "[s:12]") is taken out, with the space before it; only a
 * footnote the Ask panel draws (`[c:n]`, or `[c:l.n]` for a live read) stays. A markdown
 * link ("[words](/path)") is untouched.
 */
const RAW_TOKEN = /[ \t]*\[(?!c:(?:l\.)?\d{1,4}\])[a-z]{1,3}:[^\]\s[]{0,40}\](?!\()/gi;

export function noRawTokens(text: string): string {
  return text.replace(RAW_TOKEN, "");
}

/** Code in an answer, kept as written: a fenced block (to its closing fence or the end) or a `span`. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/;

/** A token still being written at the end of a streaming answer ("[", "[c:1", "[s:1", "[c:l."). */
const PARTIAL = /\[(?:[a-z]{1,3}(?::[^\]\s[]{0,40})?)?$/i;

/**
 * An answer's words for the Ask panel: each live read's `[l:n]` as its footnote (`[c:l.n]`) and
 * no raw token left, outside code only; while it streams (`live`), a token not yet whole is held back.
 */
export function answerWords(text: string, live = false): string {
  return (live ? text.replace(PARTIAL, "") : text)
    .split(CODE)
    .map((part, i) => (i % 2 ? part : noRawTokens(part.replace(/\[l:(\d{1,4})\]/g, "[c:l.$1]"))))
    .join("");
}
