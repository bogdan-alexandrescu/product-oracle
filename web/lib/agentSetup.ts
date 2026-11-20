// #1557: what `make agent-setup` installs and configures, and what the SessionStart hook
// checks. Pure functions only; web/scripts/agent-setup.ts does the work. Every version is
// pinned exactly (owner's go, Nov 20: docs/research/new-tools-nov19.md).

export const AGENT_TOOLS_DIR = '.agent-tools';

/** npm packages installed into .agent-tools/node_modules, never into web/package.json. */
export const NPM_TOOLS: Record<string, string> = {
  pyright: '1.1.414',
  'typescript-language-server': '6.0.3',
};

/** Installed by the official installer into .agent-tools/bin; never in CI. */
export const CODERABBIT_VERSION = '0.9.2';

/** The binaries the code-intel plugin and the review script start, under .agent-tools. */
export const BINARIES: Record<string, string> = {
  'node_modules/.bin/pyright-langserver': 'pyright',
  'node_modules/.bin/typescript-language-server': 'typescript-language-server',
  'bin/coderabbit': 'coderabbit',
};

/**
 * typescript-language-server has no TypeScript of its own: it resolves `typescript` from its
 * own folder, so setup links .agent-tools/node_modules/typescript to the web's copy.
 */
export const TYPESCRIPT_LINK = 'node_modules/typescript';
export const WEB_TYPESCRIPT = 'web/node_modules/typescript';

/** Generated files kept out of local `git diff` (they still show in a PR). */
export const GENERATED_FILES = [
  'web/lib/api/openapi.json',
  'web/lib/api/schema.d.ts',
  'api/oracle/roadmap/unicode/confusables.txt',
];

export const DIFF_DRIVER = 'agent-generated';
export const ATTRIBUTES_BEGIN = '# agent-setup: begin';
export const ATTRIBUTES_END = '# agent-setup: end';

/** Local git config setup applies: key, wanted value. */
export const GIT_CONFIG: Array<[string, string]> = [
  // `git diff` shows "Binary files differ" for the generated files.
  [`diff.${DIFF_DRIVER}.binary`, 'true'],
  // No diffstat after `git pull`.
  ['merge.stat', 'false'],
];

/** The manifest written to .agent-tools/versions.json after a full install. */
export function wantedVersions(): Record<string, string> {
  return { ...NPM_TOOLS, coderabbit: CODERABBIT_VERSION };
}

export function attributesBlock(): string {
  const lines = GENERATED_FILES.map((f) => `${f} diff=${DIFF_DRIVER}`);
  return [ATTRIBUTES_BEGIN, ...lines, ATTRIBUTES_END].join('\n') + '\n';
}

/** Puts the block into a .git/info/attributes text, replacing an older one. */
export function withAttributesBlock(current: string): string {
  const start = current.indexOf(ATTRIBUTES_BEGIN);
  const end = current.indexOf(ATTRIBUTES_END);
  let rest = current;
  if (start !== -1 && end > start) {
    rest = current.slice(0, start) + current.slice(end + ATTRIBUTES_END.length).replace(/^\n/, '');
  }
  if (rest && !rest.endsWith('\n')) rest += '\n';
  return rest + attributesBlock();
}

export type SetupState = {
  /** Paths under .agent-tools that exist. */
  present: Set<string>;
  /** Parsed .agent-tools/versions.json, or null when absent or unreadable. */
  versions: Record<string, string> | null;
  /** Current value of each GIT_CONFIG key, or undefined when unset. */
  gitConfig: Record<string, string | undefined>;
  /** Text of .git/info/attributes ("" when absent). */
  attributes: string;
};

/** Each thing make agent-setup would fix, by a short name; empty when all is set up. */
export function missingItems(state: SetupState): string[] {
  const missing: string[] = [];
  const versions = state.versions ?? {};
  for (const [name, version] of Object.entries(wantedVersions())) {
    if (versions[name] !== version) missing.push(`${name} ${version}`);
  }
  for (const [bin, tool] of Object.entries(BINARIES)) {
    if (!state.present.has(bin) && versions[tool] === wantedVersions()[tool]) missing.push(tool);
  }
  if (!state.present.has(TYPESCRIPT_LINK)) missing.push('typescript link');
  for (const [key, value] of GIT_CONFIG) {
    if (state.gitConfig[key] !== value) missing.push(`git config ${key}`);
  }
  if (!state.attributes.includes(attributesBlock())) missing.push('generated-file diff attributes');
  return missing;
}

/** The one line the SessionStart hook prints, or null when nothing is missing. */
export function checkMessage(missing: string[]): string | null {
  if (missing.length === 0) return null;
  return `Agent tools need setup (${missing.join(', ')}): run \`make agent-setup\` from the repository root.`;
}
