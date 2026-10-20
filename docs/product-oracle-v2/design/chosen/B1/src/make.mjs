// Writes the nine screens to ../html/.
import fs from 'node:fs';
import path from 'node:path';
import { out, home, requests } from './build.mjs';
import { baseline, interview, prdReview, priorities, roadmap, runs, publish } from './screens.mjs';
const pages = { home, requests, baseline, 'idea-interview': interview, 'prd-review': prdReview, priorities, roadmap, runs, publish };
for (const [name, fn] of Object.entries(pages)) fs.writeFileSync(path.join(out, name + '.html'), fn());
console.log('built', Object.keys(pages).length, 'screens');
