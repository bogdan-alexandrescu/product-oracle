import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { ROUTE_FILE_IGNORE } from '@/lib/route-files';

/*
 * #1581: a route file exports its Route and nothing else.
 * protects=code splitting: the router plugin moves a page into its own chunk only when the
 * route file exports nothing but `Route` (ai-studio shipped one 7.1 MB chunk without this);
 * fails_when=a route file under app/ has any other export (a default, a helper, a type);
 * no_claim=the files the router ignores (`_`-prefixed and the components beside the pages).
 */

const APP = __dirname;
const ignored = new RegExp(ROUTE_FILE_IGNORE);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !ignored.test(d.name))
    .flatMap((d) => {
      const full = join(dir, d.name);
      return d.isDirectory() ? routeFiles(full) : [full];
    });
}

function exportsOf(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const names: string[] = [];
  for (const node of src.statements) {
    if (ts.isExportAssignment(node)) names.push('default');
    else if (ts.isExportDeclaration(node)) names.push(node.getText(src));
    else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(node))
        node.declarationList.declarations.forEach((d) => names.push(d.name.getText(src)));
      else names.push((node as ts.DeclarationStatement).name?.getText(src) ?? 'default');
    }
  }
  return names;
}

test('every route file under app/ exports only Route', () => {
  const files = routeFiles(APP);
  expect(files.length).toBeGreaterThan(90);
  const wrong = files
    .map((f) => [relative(APP, f), exportsOf(f)] as const)
    .filter(([, names]) => names.join() !== 'Route')
    .map(([f, names]) => `${f}: ${names.join(', ') || 'nothing'}`);
  expect(wrong, 'route files with another export').toEqual([]);
});

test('the ignore pattern keeps components out of the routes', () => {
  for (const name of [
    '_inbox.tsx',
    '_components',
    'not-found.tsx',
    'loading.tsx',
    'Foo.tsx',
    'x.test.ts',
  ])
    expect(ignored.test(name), name).toBe(true);
  for (const name of ['page.tsx', 'layout.tsx', '__root.tsx', '$.tsx', '$id', 'plan'])
    expect(ignored.test(name), name).toBe(false);
});
