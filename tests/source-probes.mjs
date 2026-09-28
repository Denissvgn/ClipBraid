// Extract the actual production functions, preserving logic while supplying
// their closure inputs explicitly. Fail on missing/ambiguous AST boundaries.
import ts from "typescript";
import { readFileSync } from "node:fs";
export function expression(file, name) {
  const text = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches = [];
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === name &&
      node.initializer
    )
      matches.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (matches.length !== 1)
    throw new Error(
      `${file}: expected exactly one ${name}, got ${matches.length}`,
    );
  let node = matches[0];
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === "useCallback"
  )
    node = node.arguments[0];
  return (
    ts.transpile(`const probe = ${node.getText(tree)};`, {
      target: ts.ScriptTarget.ES2022,
    }) + "\nreturn probe;"
  );
}
export function evaluate(file, name, scope = {}) {
  return new Function(...Object.keys(scope), expression(file, name))(
    ...Object.values(scope),
  );
}

// Load a dependency-free production module; type-only imports are erased.
export function loadModule(file) {
  const source = ts.transpile(readFileSync(file, "utf8"), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
  const exports = {};
  new Function("exports", source)(exports);
  return exports;
}
