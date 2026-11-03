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
