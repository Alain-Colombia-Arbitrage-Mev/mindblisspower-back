import { test, expect } from 'bun:test';
import ts from 'typescript';

test('manual tree and ledger routes require the active-admin middleware', async () => {
  const source = ts.createSourceFile(
    'server.ts',
    await Bun.file(new URL('../server.ts', import.meta.url)).text(),
    ts.ScriptTarget.Latest,
    true,
  );
  const expected = new Set(['/api/affiliate/place', '/api/affiliate/auto-place', '/api/transaction/post']);
  const found = new Set<string>();
  function visit(node: ts.Node) {
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
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...found].sort()).toEqual([...expected].sort());
});
