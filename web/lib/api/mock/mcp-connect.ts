// MOCK-HOOK: the whole file is mock-up data for mk-mcp-connect (invented people and clients only).
import type { Schemas } from '@/lib/api/client'; // MOCK-HOOK

/** MOCK-HOOK: the MCP address as the API would serve it from ORACLE_PUBLIC_URL (a new field: an API request, not built). */
export const MOCK_MCP_URL = 'https://oracle.example.com/mcp'; // MOCK-HOOK

type Client = Schemas['McpClientOut']; // MOCK-HOOK
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString(); // MOCK-HOOK
const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString(); // MOCK-HOOK
const row = (id: string, name: string, write: boolean, at: string, used: string): Client => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, // MOCK-HOOK
  client_id: `pocl_${id}`, // MOCK-HOOK
  client_name: name, // MOCK-HOOK
  scopes: write ? ['oracle:read', 'oracle:write'] : ['oracle:read'], // MOCK-HOOK
  authorized_at: at, // MOCK-HOOK
  last_used_at: used, // MOCK-HOOK
  expires_at: ahead(30), // MOCK-HOOK
  revoked_at: null, // MOCK-HOOK
});

/** MOCK-HOOK: where each mock client runs (the API would read it from the client's registration). */
export const MOCK_WHERE: Record<string, string> = {
  pocl_01: 'Your computer', // MOCK-HOOK
  pocl_02: 'Claude on the web', // MOCK-HOOK
  pocl_03: 'Claude desktop app', // MOCK-HOOK
  pocl_04: 'Your computer', // MOCK-HOOK
  pocl_05: 'Another app', // MOCK-HOOK
};

/** MOCK-HOOK: `?clients=none|fresh|five` picks the person's connected clients; null keeps the seed. */
const revoked = new Set<string>(); // MOCK-HOOK: revokes made on this page load
export const mockRevoke = (id: string) => revoked.add(id); // MOCK-HOOK
export function mockClients(search: string): Client[] | null {
  const list = pick(search); // MOCK-HOOK
  return list && list.map((c) => (revoked.has(c.id) ? { ...c, revoked_at: new Date().toISOString() } : c)); // MOCK-HOOK
}
function pick(search: string): Client[] | null {
  const k = new URLSearchParams(search).get('clients'); // MOCK-HOOK
  if (k === 'none') return []; // MOCK-HOOK
  if (k === 'fresh') return [row('01', "Claude Code on Avery's laptop", true, ago(1), ago(0))]; // MOCK-HOOK
  if (k === 'five')
    return [
      row('02', 'Claude', true, '2026-10-02T09:00:00Z', ago(60 * 26)), // MOCK-HOOK
      row('03', 'Claude Desktop', true, '2026-10-14T09:00:00Z', ago(60 * 3)), // MOCK-HOOK
      row('04', 'Claude Code on the build machine in the second-floor lab (shared)', false, '2026-10-20T09:00:00Z', ago(60 * 24 * 9)), // MOCK-HOOK
      row('05', 'Notes Helper', false, '2026-11-02T09:00:00Z', ago(60 * 24 * 2)), // MOCK-HOOK
      row('01', "Claude Code on Avery's laptop", true, ago(30), ago(4)), // MOCK-HOOK
    ];
  return null; // MOCK-HOOK
}

/** MOCK-HOOK: the owner's company view (from /v1/api-tokens, kind mcp_client, by person). */
export type CompanyRow = { name: string; email: string; role: string; clients: number; used: string | null }; // MOCK-HOOK
export const MOCK_COMPANY: CompanyRow[] = [
  { name: 'Avery Stone', email: 'admin@example.com', role: 'Owner', clients: 2, used: ago(4) }, // MOCK-HOOK
  { name: 'Priya Raman', email: 'approver@example.com', role: 'Approver', clients: 1, used: ago(60 * 2) }, // MOCK-HOOK
  { name: 'Dana Decider', email: 'dana.decider@example.com', role: 'Approver', clients: 3, used: ago(60 * 20) }, // MOCK-HOOK
  { name: 'Cory Hale', email: 'cory.hale@example.com', role: 'Commenter', clients: 1, used: ago(60 * 24 * 3) }, // MOCK-HOOK
  { name: 'Marisol Okonkwo-Whitfield', email: 'marisol.okonkwo-whitfield@example.com', role: 'Commenter', clients: 1, used: ago(60 * 24 * 12) }, // MOCK-HOOK
  { name: 'Vic Moss', email: 'vic.moss@example.com', role: 'Viewer', clients: 0, used: null }, // MOCK-HOOK
  { name: 'Jo Tester', email: 'jo.tester@example.com', role: 'Viewer', clients: 0, used: null }, // MOCK-HOOK
  { name: 'Lee Park', email: 'lee.park@example.com', role: 'Commenter', clients: 0, used: null }, // MOCK-HOOK
];
