import { test, expect } from 'bun:test';
import ts from 'typescript';

test('manual tree and ledger routes require the active-admin middleware', async () => {
  const paths = ['../http/affiliate-routes.ts', '../http/transaction-routes.ts'];
  const sources = await Promise.all(paths.map(async path => ts.createSourceFile(
    path, await Bun.file(new URL(path, import.meta.url)).text(), ts.ScriptTarget.Latest, true,
  )));
  const expected = new Set(['/api/affiliate/place', '/api/affiliate/auto-place', '/api/transaction/post']);
  const found = new Set<string>();
  function visit(node: ts.Node, source: ts.SourceFile) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'app'
      && node.expression.name.text === 'post') {
      const path = node.arguments[0];
      if (path && ts.isStringLiteral(path) && expected.has(path.text)) {
        const guard = node.arguments[1];
        expect(guard && ts.isIdentifier(guard) && guard.text === 'requireAdmin').toBe(true);
        expect(node.arguments.length).toBe(3);
        found.add(path.text);
      }
    }
    ts.forEachChild(node, child => visit(child, source));
  }
  for (const source of sources) visit(source, source);
  const composition = await Bun.file(new URL('../server.ts', import.meta.url)).text();
  expect(composition).toContain('registerAffiliateRoutes(app)');
  expect(composition).toContain('registerTransactionRoutes(app)');
  expect([...found].sort()).toEqual([...expected].sort());
});
