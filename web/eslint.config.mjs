import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
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
      {
        name: '@tanstack/react-router',
        importNames: [
          'Link',
          'useNavigate',
          'useParams',
          'useRouter',
          'useRouterState',
          'useLocation',
          'useSearch',
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

// #1581: what eslint-config-next's core-web-vitals and typescript sets gave, from their own
// plugins (docs/vite-migration/dependencies.md, Lint after eslint-config-next).
const eslintConfig = defineConfig([
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
  // `npx eslint --prune-suppressions` after a fix. Typed rules (projectService) wait for a later
  // phase: over this tree they ran `npm run lint` out of memory even at a 4 GB heap.
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

export default eslintConfig;
