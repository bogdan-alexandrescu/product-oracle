// #1557: `make agent-setup` (no flag) and the SessionStart hook (`--check`).
//
//   node web/scripts/agent-setup.ts          install the pinned tools into .agent-tools/ and set
//                                            the local git config; exits 1 if a step fails
//   node web/scripts/agent-setup.ts --check  print one line when anything is missing; always
//                                            exits 0 and never installs
//
// What is pinned and why lives in web/lib/agentSetup.ts.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AGENT_TOOLS_DIR,
  BINARIES,
  CODERABBIT_VERSION,
  GIT_CONFIG,
  NPM_TOOLS,
  TYPESCRIPT_LINK,
  WEB_TYPESCRIPT,
  checkMessage,
  missingItems,
  wantedVersions,
  withAttributesBlock,
} from '../lib/agentSetup.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TOOLS = join(ROOT, AGENT_TOOLS_DIR);
const CODERABBIT_INSTALLER = 'https://cli.coderabbit.ai/install.sh';

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return existsSync(path); // a dangling link counts as missing
  } catch {
    return false;
  }
}

function attributesPath(): string {
  return resolve(
    ROOT,
    git(['rev-parse', '--git-path', 'info/attributes']) ?? '.git/info/attributes',
  );
}

function readState() {
  let versions: Record<string, string> | null = null;
  try {
    versions = JSON.parse(readFileSync(join(TOOLS, 'versions.json'), 'utf8'));
  } catch {
    versions = null;
  }
  const present = new Set(
    [...Object.keys(BINARIES), TYPESCRIPT_LINK].filter((p) => exists(join(TOOLS, p))),
  );
  const gitConfig: Record<string, string | undefined> = {};
  for (const [key] of GIT_CONFIG) gitConfig[key] = git(['config', '--local', '--get', key]);
  const attrs = attributesPath();
  const attributes = existsSync(attrs) ? readFileSync(attrs, 'utf8') : '';
  return { present, versions, gitConfig, attributes };
}

function check(): void {
  const message = checkMessage(missingItems(readState()));
  if (message) console.log(message);
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync(cmd, args, { cwd: TOOLS, stdio: 'inherit', env: { ...process.env, ...env } });
}

function setup(): number {
  let failed = 0;
  const step = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    }
  };

  step('git config', () => {
    for (const [key, value] of GIT_CONFIG)
      execFileSync('git', ['config', '--local', key, value], { cwd: ROOT });
    const attrs = attributesPath();
    mkdirSync(dirname(attrs), { recursive: true });
    writeFileSync(attrs, withAttributesBlock(existsSync(attrs) ? readFileSync(attrs, 'utf8') : ''));
  });

  mkdirSync(TOOLS, { recursive: true });
  const versions: Record<string, string> = {};

  step(
    `npm tools (${Object.entries(NPM_TOOLS)
      .map(([n, v]) => `${n}@${v}`)
      .join(', ')})`,
    () => {
      writeFileSync(
        join(TOOLS, 'package.json'),
        JSON.stringify({ private: true, dependencies: NPM_TOOLS }, null, 2) + '\n',
      );
      run('npm', ['install', '--no-audit', '--no-fund', '--save-exact']);
      Object.assign(versions, NPM_TOOLS);
    },
  );

  step('typescript link', () => {
    const web = join(ROOT, WEB_TYPESCRIPT);
    if (!existsSync(web))
      throw new Error(`${WEB_TYPESCRIPT} is missing: run \`npm ci\` in web/ first`);
    const link = join(TOOLS, TYPESCRIPT_LINK);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(web, link, 'dir');
  });

  step(`coderabbit ${CODERABBIT_VERSION}`, () => {
    const bin = join(TOOLS, 'bin');
    mkdirSync(bin, { recursive: true });
    // The installer verifies a signed SHA256SUMS before unpacking. With bin on PATH it leaves
    // shell profiles alone; CR_CLI_SKIP_LOGIN skips its login prompt and CI its skills prompt.
    const script = execFileSync('curl', ['-fsSL', CODERABBIT_INSTALLER], { encoding: 'utf8' });
    execFileSync('sh', ['-s'], {
      cwd: TOOLS,
      input: script,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CODERABBIT_VERSION,
        CODERABBIT_INSTALL_DIR: bin,
        CR_CLI_SKIP_LOGIN: '1',
        CI: '1',
      },
    });
    const got = execFileSync(join(bin, 'coderabbit'), ['--version'], { encoding: 'utf8' }).trim();
    if (got !== CODERABBIT_VERSION)
      throw new Error(`installed ${got}, wanted ${CODERABBIT_VERSION}`);
    versions.coderabbit = CODERABBIT_VERSION;
  });

  writeFileSync(join(TOOLS, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
  const missing = missingItems(readState());
  if (missing.length) console.error(checkMessage(missing));
  else console.log(`Agent tools ready in ${AGENT_TOOLS_DIR}/: ${JSON.stringify(wantedVersions())}`);
  return failed || missing.length ? 1 : 0;
}

if (process.argv.includes('--check')) {
  check();
} else {
  process.exitCode = setup();
}
