/**
 * Settings > Sources opens Google's Drive picker (lib/google-picker.ts). The page is
 * usually reached by in-app navigation, which keeps the CSP of the document first loaded,
 * so this policy is sent on every page. Everything defaults to this origin only
 * (default-src 'self'); on top of it the policy allows Google's two scripts from their own
 * hosts, Google's picker frame (docs.google.com), and Google sign-in's frame, requests and
 * stylesheet (accounts.google.com/gsi/), and images from the hosts Notion serves page
 * icons from (the Notion page picker shows only icons from those hosts:
 * settings/sources/NotionPicker.tsx, ICON_HOSTS), and no other outside host.
 * 'unsafe-inline' scripts cover the theme and mode scripts in index.html; development
 * adds 'unsafe-eval' for React and ws: for hot reload. Inline styles and data: images and
 * fonts are allowed: the picker's dialog and theme previews (sandboxed srcdoc frames,
 * which inherit this policy; theme CSS may use no URL but data:) use them.
 *
 * #1581: one list for both servers: vite.config.mts sends it from `vite dev` and `vite preview`,
 * and nginx/security-headers.conf carries the production policy (lib/csp.test.ts keeps it equal).
 */
const NOTION_ICONS = [
  'https://notion.so',
  'https://*.notion.so',
  'https://notion.site',
  'https://*.notion.site',
  'https://notion-static.com',
  'https://*.notion-static.com',
  'https://prod-files-secure.s3.us-west-2.amazonaws.com',
].join(' ');

export function appCsp(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''} https://apis.google.com https://accounts.google.com/gsi/`,
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    `img-src 'self' data: ${NOTION_ICONS}`,
    "font-src 'self' data:",
    "frame-src 'self' https://docs.google.com https://accounts.google.com/gsi/",
    `connect-src 'self'${dev ? ' ws:' : ''} https://accounts.google.com/gsi/`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
