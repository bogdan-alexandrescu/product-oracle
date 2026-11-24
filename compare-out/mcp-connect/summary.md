# Connect an AI tool: built vs picked (proposal a of MC1, MC2, MC3)

Built from main 4d6b9d0956 (mock app, `npm run build:mock`, served by `vite preview --mode mock`). 22 frames, 22 built shots: 5 match, 17 differ (all minor). Shots: `shots/<frame>__picked|built__<theme>.png`.

## Frames

- mc1-a-rest (light): match
- mc1-a-simple-menu (light): differs (minor). The account menu and its 'Connect an AI tool' item match. Behind it, Simple Home's goal cards read 'Weight 37%' and 'Now 9.4% · target 12%' with 'On track', where the frame reads '37% of the score', 'From 11.2% · now 9.4% · target 12%' and 'Planned' (not part of this feature).
- mc1-a-open (light): differs (minor). Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc1-a-open (dark): differs (minor). Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc1-a-open-390 (light): differs (minor). On the phone, 'Changes apply at once' sits on the same line as 'Your tools can' and the address fits on one line; in the picked frame the chip is on its own line under the label and the address wraps (the frame was drawn with a desktop scrollbar, so it may be 15px narrower). Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc1-a-company-1512 (light): match
- mc2-a-app (light): match
- mc2-a-copied (light): differs (minor). 'Copied' and the waiting check strip match. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc2-a-copied-390 (light): differs (minor). On the phone, 'Changes apply at once' sits on the same line as 'Your tools can' and the address fits on one line; in the picked frame the chip is on its own line under the label and the address wraps (the frame was drawn with a desktop scrollbar, so it may be 15px narrower). Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc2-a-done (light): differs (minor). The connected strip, the row and the MCP clients count match. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc2-a-done (dark): differs (minor). The connected strip, the row and the MCP clients count match. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc2-a-late (light): differs (minor). The 'Sign-in timed out' strip with '/mcp' and Copy matches. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc2-a-viewer-1512 (light): differs (minor). The Read only tip drops the frame's opening words 'Your role is Viewer:'; the built tip starts 'A connected tool reads goals, the roadmap and documents...'.
- mc2-a-commenter-1512 (light): differs (minor). 'Changes become proposals' and the newest client in the strip match. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text. The mock could only list 4 clients, all named Example Agent (the seeded Cursor client has expired), so the frame's long names were not shown.
- mc3-a-rest (light): differs (minor). One client, Your computer, Read & write, Just now, with Revoke: matches. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc3-a-five-1512 (light): differs (minor). The table's columns, Read & write chips and Revoke match. The mock could only make 3 clients, all named Example Agent (the seeded Claude Desktop has expired), so the frame's long shared-machine name wrapping in full could not be checked. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc3-a-five (dark): differs (minor). Same as at 1512: only 3 Example Agent clients could be made, so the long-name wrap was not checked. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc3-a-five-390 (light): differs (minor). Each row's second line reads 'Used Just now' with a capital J; the frame's rows read 'Used 3 h ago', 'Used 4 min ago' in lower case. The long-name wrap was not checked (only 3 Example Agent clients). Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc3-a-revoke (light): differs (minor). The confirm's title, client name, two lines and buttons match, but Cancel shows no focus ring after the mouse click that opened it; the frame shows Cancel focused with a ring.
- mc3-a-revoked (light): differs (minor). The empty list, the waiting strip and the 0 MCP clients count match. Step 2 sets '/mcp' and 'oracle' in code (monospace) type in 'In Claude Code, run /mcp and choose oracle'; the picked frame has the whole sentence in plain text.
- mc3-a-consent (light): match
- mc3-a-company-1512 (light): match

## The differences that repeat

- 15 frames: step 2 of the Claude Code tab sets '/mcp' and 'oracle' in code type; the frames have plain text.
- Viewer tip drops 'Your role is Viewer:'. Phone rows say 'Used Just now' with a capital J. The revoke confirm's Cancel has no focus ring after a mouse click.

## States not fully reached, and why

- The live browser crashed early in the run, and the gate said it could not start it again for this attempt. So the built shots come from the repo's own pinned Chromium (`swarm-test-browsers`), through a throwaway capture spec that was never committed. That spec drives the UI as a person would: sign in, open the account menu, click Connect an AI tool, Copy, switch tabs, Approve in a second tab, Revoke, then confirm. With it, the 1512 frames were taken at their PNG's own size, 1512x982.
- Five clients with a long name (mc3-a-five-*, mc2-a-commenter-1512): the mock's consent screen always approves 'Example Agent'. Also, the seeded clients (Claude Desktop, Cursor) expired before today's date (Nov 24, 2026). So the owner showed 3 clients and the commenter 4, all with the same short name, and the long-name wrap was not checked.
- mc2-a-late: the five-minute timeout was reached with Playwright's fake clock, not by waiting in real time.
- People: the frames sign in as Avery Stone (owner). The empty and first-connection states (mc1, mc2 except the viewer and commenter frames, and mc3-a-rest, revoke and revoked) were taken as the mock approver, Priya Raman, who has no clients. The mock owner has seeded clients, so the empty list could not be shown as the owner. The access chip reads the same for both: 'Changes apply at once'.
