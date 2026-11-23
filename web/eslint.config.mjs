import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

// #401: display dates and times are in the Company time zone, through lib/dates.ts;
// only machine values sent to the API stay ISO/UTC.
const DATE_RULES = [
  {
    selector: "Property[key.name='timeZone'][value.value=/^(UTC|Etc\\/UTC|GMT)$/i]",
    message: 'Show dates in the Company time zone: use lib/dates.ts, not timeZone "UTC".',
  },
  // #447: nor in the browser's zone. A number's toLocaleString("en-US") stays allowed.
  {
    selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]',
    message:
      'Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not toLocaleDateString/toLocaleTimeString.',
  },
  {
    selector:
      "CallExpression[callee.property.name='toLocaleString']:matches([arguments.length=0], [callee.object.type='NewExpression'], :has(Property[key.name=/^(year|month|day|weekday|hour|minute|second|dateStyle|timeStyle|timeZone|timeZoneName)$/]))",
    message:
      'Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not toLocaleString.',
  },
  {
    selector:
      ":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
    message:
      'Show dates in the Company time zone: use lib/dates.ts or lib/format.ts, not new Intl.DateTimeFormat.',
  },
  // #1588: nor today from an ISO string: its day is UTC's, the wrong day near midnight.
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
    message:
      "Today is the Company's day: use todayIn(zone) from lib/dates.ts; for arithmetic on days, utcDay or addDays.",
  },
];

// #1591: roles in the web go through can() or an item's own can_* field, never the signed-in
// person's role name (another member's role, as on Settings › Members, stays readable).
const ROLE_MESSAGE =
  "Gate on can() or the item's own can_* field, not on the signed-in person's role name.";
const ROLE_RULES = [
  {
    selector:
      "BinaryExpression[operator=/^[!=]==?$/]:matches([left.property.name='role'][left.object.name=/^(me|caps|current|session|user|principal)$/], [left.expression.property.name='role'][left.expression.object.name=/^(me|caps|current|session|user|principal)$/], [left.property.name='role'][left.object.expression.name=/^(me|caps|current|session|user|principal)$/], [right.property.name='role'][right.object.name=/^(me|caps|current|session|user|principal)$/], [right.expression.property.name='role'][right.expression.object.name=/^(me|caps|current|session|user|principal)$/], [right.property.name='role'][right.object.expression.name=/^(me|caps|current|session|user|principal)$/])",
    message: ROLE_MESSAGE,
  },
  {
    selector:
      "BinaryExpression[operator=/^[!=]==?$/]:matches([left.type='Identifier'][left.name='role'][right.value=/^(owner|approver|commenter|viewer)$/], [right.type='Identifier'][right.name='role'][left.value=/^(owner|approver|commenter|viewer)$/])",
    message: ROLE_MESSAGE,
  },
];

// #1579: links and navigation come from lib/nav.ts only, so a move off Next changed one file.
// A lane that brings in a next/* import runs `node scripts/nav-codemod.mjs` to re-point it.
// #1581: the router's own hooks and Link stay behind lib/nav.ts too (route files import
// createFileRoute and Outlet from it directly).
const NAV_RULE = [
  'error',
  {
    paths: [
      ...['next/link', 'next/navigation'].map((name) => ({
        name,
        message:
          'Import links and navigation from @/lib/nav (node scripts/nav-codemod.mjs re-points them).',
      })),
      // #1585 phase 3: an allow-list, not a deny-list, so a router export added later (Navigate,
      // useMatch, useBlocker, createLink...) cannot slip past lib/nav.ts. Allowed: what wires a
      // route (route files, main.tsx) and the redirect a route's beforeLoad throws.
      {
        name: '@tanstack/react-router',
        allowImportNames: [
          'createFileRoute',
          'createRootRoute',
          'createRouter',
          'Outlet',
          'redirect',
          'RouterProvider',
        ],
        message: 'Import links and navigation from @/lib/nav.',
      },
    ],
  },
];

// #1589: text sizes are the type scale's steps (app/globals.css, @theme), never an arbitrary
// text-[Npx]. A rule of its own, so no file's no-restricted-syntax override turns it off.
const TEXT_SIZE = /(?:^|[\s"'`:!])text-\[\d+(?:\.\d+)?px\]/;
const TEXT_SIZE_RULE = {
  meta: {
    type: 'problem',
    messages: {
      arbitrary:
        'Use a type scale step (text-xs, text-sm, text-base, text-lg, text-xl, text-2xl, text-3xl, text-4xl), not an arbitrary text-[Npx].',
    },
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && TEXT_SIZE.test(text))
        context.report({ node, messageId: 'arbitrary' });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.raw),
    };
  },
};

// #1585 phase 3: design-system bans. A raw element the design system (components/ds) already
// draws is a rule of its own per element, so its suppressions read per ban and no file's
// no-restricted-syntax override turns it off. components/ds itself is exempt: it draws them.
// No ban for <select> or a checkbox <input>: components/ds has no part for them yet.
const RAW_ELEMENTS = {
  // Button and LinkButton carry the variants, the disabled look and the one focus ring.
  'no-raw-button': {
    name: 'button',
    message:
      'Use Button (or LinkButton) from @/components/ds, not a raw <button>: it carries the variants, the disabled look and the focus ring.',
  },
  // Dialog and Sheet carry the focus trap, Escape and the backdrop.
  'no-raw-dialog': {
    name: 'dialog',
    message:
      'Use Dialog or Sheet from @/components/ds, not a raw <dialog>: they carry the focus trap, Escape and the backdrop.',
  },
};
const rawElementRule = ({ name, message }) => ({
  meta: { type: 'problem', messages: { raw: message } },
  create(context) {
    return {
      [`JSXOpeningElement[name.type='JSXIdentifier'][name.name='${name}']`]: (node) =>
        context.report({ node, messageId: 'raw' }),
    };
  },
});
// A link inside the app is Link from @/lib/nav (client-side, no full page load), never a raw
// <a href="/..."> (a literal or a template that starts with "/"; "//host" is another site).
const INTERNAL_ANCHOR_RULE = {
  meta: {
    type: 'problem',
    messages: {
      internal:
        'Use Link from @/lib/nav for a link inside the app, not a raw <a href="/...">: it navigates without reloading the page.',
    },
  },
  create(context) {
    const internal = (text) => typeof text === 'string' && /^\/(?!\/)/.test(text);
    return {
      "JSXOpeningElement[name.type='JSXIdentifier'][name.name='a'] > JSXAttribute[name.name='href']":
        (node) => {
          let value = node.value;
          if (value?.type === 'JSXExpressionContainer') value = value.expression;
          const text =
            value?.type === 'Literal'
              ? value.value
              : value?.type === 'TemplateLiteral'
                ? value.quasis[0].value.cooked
                : null;
          if (internal(text)) context.report({ node, messageId: 'internal' });
        },
    };
  },
};
const DESIGN_SYSTEM = {
  rules: {
    ...Object.fromEntries(
      Object.entries(RAW_ELEMENTS).map(([rule, spec]) => [rule, rawElementRule(spec)]),
    ),
    'no-internal-anchor': INTERNAL_ANCHOR_RULE,
  },
};

// #1581: what eslint-config-next's core-web-vitals and typescript sets gave, from their own
// plugins (docs/vite-migration/dependencies.md, Lint after eslint-config-next).
const ALL_RULES = defineConfig([
  js.configs.recommended,
  ...tseslintConfigs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  reactHooks.configs.flat['recommended-latest'],
  {
    plugins: { 'jsx-a11y': jsxA11y },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { react: { version: 'detect' } },
    rules: {
      // As eslint-config-next set them.
      'react/no-unknown-property': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/jsx-no-target-blank': 'off',
      'jsx-a11y/alt-text': ['warn', { elements: ['img'], img: ['Image'] }],
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      // eslint-config-next did not turn on @eslint/js's recommended set; these four of it fail
      // on code that passed there (control characters and escapes in regexes, NBSP in copy).
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'off',
      'no-useless-escape': 'off',
      'no-constant-binary-expression': 'off',
    },
  },
  // #1585 phase 1, core and imports, every rule at error. Findings from before it sit in
  // eslint-suppressions.json (`npx eslint --suppress-all`) and only go down from there:
  // `npm run lint -- --prune-suppressions` after a fix. Typed rules are phase 4's, below.
  {
    plugins: { 'import-x': importX, 'unused-imports': unusedImports },
    settings: {
      'import-x/extensions': ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'],
      'import-x/external-module-folders': ['node_modules', 'node_modules/@types'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.mts'] },
      // Packages' own exports are TypeScript's to check; reading every .d.ts under node_modules
      // into import-x's export maps ran `npm run lint` out of memory.
      'import-x/ignore': ['node_modules'],
      // The `@/` alias, from tsconfig.json's paths.
      'import-x/resolver-next': [
        createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'],
          conditionNames: ['types', 'import', 'module', 'browser', 'default'],
          mainFields: ['types', 'module', 'main'],
          tsconfig: { configFile: `${import.meta.dirname}/tsconfig.json` },
        }),
      ],
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'no-useless-rename': 'error',
      'no-param-reassign': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'import-x/no-unresolved': ['error', { ignore: ['^virtual:', '\\?(raw|url|inline)$'] }],
      // TypeScript checks named imports already (tsc --noEmit).
      'import-x/named': 'off',
      'import-x/namespace': 'error',
      'import-x/default': 'error',
      'import-x/export': 'error',
      'import-x/no-named-as-default': 'error',
      'import-x/no-named-as-default-member': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-absolute-path': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          pathGroups: [{ pattern: '@/**', group: 'internal' }],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': 'error',
    },
  },
  // #1585 phase 2, file size, ai-studio's values, at error with the same suppressions baseline.
  // A file over its limit is split, never given a higher one.
  {
    rules: { 'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }] },
  },
  {
    // Route files (lib/route-files.ts) only wire a route to its page.
    files: ['app/**/page.tsx', 'app/**/layout.tsx', 'app/__root.tsx', 'app/**/$.tsx'],
    rules: { 'max-lines': ['error', { max: 15, skipBlankLines: true, skipComments: true }] },
  },
  {
    // Tests and data: the mock API's document seeds and the goal-ladder scenario table.
    files: [
      '**/*.test.{ts,tsx}',
      '**/fixtures.ts',
      '**/__generated__/**',
      'lib/api/mock/goal-ladder.ts',
    ],
    rules: { 'max-lines': 'off' },
  },
  // #1585 phase 3b, cognitive complexity, ai-studio's threshold, at error with the same
  // suppressions baseline. Only this sonarjs rule; a function over it is split, never given more.
  {
    plugins: { sonarjs },
    rules: { 'sonarjs/cognitive-complexity': ['error', 15] },
  },
  {
    // Tests (unit and Playwright), fixtures and generated code.
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.ts',
      'e2e/**',
      '**/fixtures.ts',
      '**/__generated__/**',
    ],
    rules: { 'sonarjs/cognitive-complexity': 'off' },
  },
  {
    plugins: { typography: { rules: { 'no-arbitrary-text-size': TEXT_SIZE_RULE } } },
    rules: { 'typography/no-arbitrary-text-size': 'error' },
  },
  {
    rules: {
      // Ask in the page (confirmInPage, components/ds): a browser dialog blocks the tab,
      // and browser automation with it (UI test finding E5, 2026-10-20).
      'no-alert': 'error',
      'no-restricted-globals': ['error', 'confirm', 'alert', 'prompt'],
      'no-restricted-syntax': ['error', ...DATE_RULES],
      'no-restricted-imports': NAV_RULE,
    },
  },
  {
    plugins: { 'design-system': DESIGN_SYSTEM },
    rules: {
      'design-system/no-raw-button': 'error',
      'design-system/no-raw-dialog': 'error',
      'design-system/no-internal-anchor': 'error',
    },
  },
  {
    files: ['components/ds/**'],
    rules: {
      'design-system/no-raw-button': 'off',
      'design-system/no-raw-dialog': 'off',
      'design-system/no-internal-anchor': 'off',
    },
  },
  {
    files: ['lib/nav.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['app/**', 'components/**'],
    rules: { 'no-restricted-syntax': ['error', ...DATE_RULES, ...ROLE_RULES] },
  },
  {
    // The shared formatter, the mock API (it stands in for the server) and the tests (they
    // work out the strings a screen should show).
    files: ['lib/dates.ts', 'lib/api/mock/**', 'e2e/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  globalIgnores([
    'dist/**',
    'dist-*/**',
    'out/**',
    'build/**',
    'routeTree.gen.ts',
    'test-results/**',
    'playwright-report/**',
  ]),
]);

// #1585 phase 4, the typed typescript-eslint rules ai-studio uses, at error with the same
// suppressions baseline. They need a TypeScript program; with the rules above in the same process
// `npm run lint` ran out of a 4 GB heap, and alone over the whole tree they needed more than 3 GB.
// So scripts/lint.mjs lints in three processes over the same files: LINT_PASS=untyped (every rule
// but these), then these alone in two halves, typed-app (all but e2e/) and typed-e2e (e2e/ only).
// Without LINT_PASS (an editor, `npx eslint <file>`) every rule runs.
export const TYPED_RULES = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
};
const TYPED = {
  files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
  languageOptions: {
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  rules: TYPED_RULES,
};
const OTHER_RULES_OFF = Object.fromEntries(
  ALL_RULES.flatMap((config) => Object.keys(config.rules ?? {}))
    .filter((rule) => !(rule in TYPED_RULES))
    .map((rule) => [rule, 'off']),
);
// Disable comments for the rules turned off here are the untyped pass's to report.
const typedPass = (ignores) => [
  ...ALL_RULES,
  TYPED,
  { linterOptions: { reportUnusedDisableDirectives: 'off' }, rules: OTHER_RULES_OFF },
  globalIgnores(ignores),
];

const PASSES = {
  untyped: ALL_RULES,
  'typed-app': typedPass(['e2e/']),
  'typed-e2e': typedPass(['**/*', '!e2e/', '!e2e/**']),
};
const eslintConfig = PASSES[process.env.LINT_PASS] ?? [...ALL_RULES, TYPED];

export default eslintConfig;
