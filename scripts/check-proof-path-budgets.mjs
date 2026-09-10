import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "@typescript/typescript6";

export const DEFAULT_PROOF_PATH_FILES = [
  "packages/runtime/tests/graph-types-loop-crash.spec.ts",
  "packages/runtime/tests/safe-change-recovery.spec.ts",
  "packages/source/test/f3-browser-proof.test.mjs",
  "packages/source/test/review-cli.test.mjs",
  "packages/surfacer/test/server.test.mjs",
];

/**
 * @typedef {{ file: string, line: number, column: number, kind: string, message: string }} ProofPathViolation
 */

/**
 * Find waits and timers that are not protected by a budget-chain phase.
 *
 * Named helpers are followed through local calls. A helper is safe only when
 * every known call reaches it from a chain phase; an unknown entry is treated
 * as unguarded.
 *
 * @param {string} source
 * @param {string} [fileName]
 * @returns {ProofPathViolation[]}
 */
export function findProofPathViolations(source, fileName = "fixture.mjs") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(fileName),
  );
  const root = { node: sourceFile, name: "<module>" };
  const units = [root];
  const unitByFunction = new Map();
  const functionsByName = new Map();
  const budgetChainIdentifiers = new Set();
  const spanDerivedTimeouts = new Set();
  const externalIdentifiers = new Set();
  const externalPromiseObjects = new Set();
  const externalUnits = new Set();

  collectDefinitions(sourceFile, root);
  collectSpanDerived(sourceFile);
  for (let pass = 0; pass <= units.length; pass += 1) {
    collectExternalBindings(sourceFile);
    for (const unit of units) {
      if (!externalUnits.has(unit) && unitHasExternalProgress(unit)) externalUnits.add(unit);
    }
  }

  /** @type {{ from: object, to: object, mode: "inherit" | "guarded" }[]} */
  const edges = [];
  /** @type {Map<object, { kind: string, node: object, unit: object }[]>} */
  const findingsByUnit = new Map();

  for (const unit of units) {
    const findings = [];
    findingsByUnit.set(unit, findings);
    visitDirect(unit.node === sourceFile ? sourceFile : unit.node.body, unit, findings);
  }

  const incoming = new Map(units.map((unit) => [unit, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  /** @type {Map<object, Set<boolean>>} */
  const reachable = new Map(units.map((unit) => [unit, new Set()]));
  const queue = [[root, false]];
  for (const unit of units) {
    if (unit !== root && incoming.get(unit) === 0) queue.push([unit, false]);
  }
  while (queue.length > 0) {
    const [unit, guarded] = queue.shift();
    const modes = reachable.get(unit);
    if (modes.has(guarded)) continue;
    modes.add(guarded);
    for (const edge of edges) {
      if (edge.from !== unit) continue;
      queue.push([edge.to, edge.mode === "guarded" ? true : guarded]);
    }
  }

  const violations = [];
  for (const unit of units) {
    const modes = reachable.get(unit);
    const canRunUnguarded = modes.size === 0 || modes.has(false);
    if (!canRunUnguarded) continue;
    for (const finding of findingsByUnit.get(unit)) {
      violations.push(toViolation(sourceFile, fileName, finding.node, finding.kind, `${finding.message} in ${unit.name}`));
    }
  }
  violations.sort((a, b) => a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
  return violations;

  function collectDefinitions(node, enclosingUnit) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isBudgetChainCall(node.initializer)) {
      budgetChainIdentifiers.add(node.name.text);
    }
    if (isFunctionLike(node)) {
      const unit = { node, name: functionName(node) };
      units.push(unit);
      unitByFunction.set(node, unit);
      if (unit.name !== "<anonymous>") functionsByName.set(unit.name, unit);
      ts.forEachChild(node, (child) => collectDefinitions(child, unit));
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isFunctionLike(node.initializer)) {
      // The function is collected by the branch above. This branch exists to
      // make the local name available before calls are scanned when the AST
      // presents the declaration before its later references.
      if (ts.isIdentifier(node.name)) functionsByName.set(node.name.text, unitByFunction.get(node.initializer));
    }
    ts.forEachChild(node, (child) => collectDefinitions(child, enclosingUnit));
  }

  function visitDirect(node, unit, findings) {
    if (!node) return;
    if (node !== unit.node && isFunctionLike(node)) {
      const child = unitByFunction.get(node);
      if (child) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === node)) {
          edges.push({ from: unit, to: child, mode: isRunCall(parent, budgetChainIdentifiers) ? "guarded" : "inherit" });
        } else if (ts.isNewExpression(parent) && parent.arguments?.some((argument) => argument === node)) {
          edges.push({ from: unit, to: child, mode: "inherit" });
        }
      }
      return;
    }

    if (ts.isVariableDeclaration(node) && node.initializer && isFunctionLike(node.initializer)) {
      // The initializer is a separate function unit. Do not inspect its body
      // as if it ran while the declaration executes.
      visitDirect(node.name, unit, findings);
      return;
    }

    if (ts.isAwaitExpression(node)) {
      if (!isRunExpression(node.expression, budgetChainIdentifiers) && isExternalExpression(node.expression)) {
        findings.push({ kind: "await", node, message: "external wait is outside a budget-chain phase" });
      }
    } else if (ts.isForOfStatement(node) && node.awaitModifier) {
      findings.push({ kind: "for-await", node, message: "for-await is outside a budget-chain phase" });
    } else if (ts.isCallExpression(node)) {
      const timer = timerKind(node);
      if (timer) {
        const killTimer = timer === "setTimeout" && timerCallbackKills(node);
        if (!killTimer || timerValueIsLiteral(node) || !isSpanDerivedTimer(node)) {
          const kind = killTimer ? "kill-timer" : "timer";
          findings.push({ kind, node, message: `${timer} is outside a budget-chain phase` });
        }
      }
      if (hasInvalidSyncProcessTimeout(node, spanDerivedTimeouts)) {
        findings.push({ kind: "spawn-timeout", node, message: "spawn timeout is not derived from chain.span" });
      }
      const calledName = callName(node);
      const calledUnit = calledName ? functionsByName.get(calledName) : undefined;
      if (calledUnit) edges.push({ from: unit, to: calledUnit, mode: "inherit" });
    }

    ts.forEachChild(node, (child) => visitDirect(child, unit, findings));
  }

  function collectExternalBindings(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isPromiseWithResolvers(node.initializer)) externalPromiseObjects.add(node.name.text);
      if (isExternalPromiseConstructor(node.initializer)
        || isExternalExpression(node.initializer)
        || /Promise$/u.test(node.name.text)) externalIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectExternalBindings);
  }

  function unitHasExternalProgress(unit) {
    let external = false;
    const visit = (node) => {
      if (external || !node) return;
      if (node !== unit.node && isFunctionLike(node)) return;
      if (ts.isForOfStatement(node) && node.awaitModifier) {
        external = true;
        return;
      }
      if (ts.isAwaitExpression(node) && isExternalExpression(node.expression)) {
        external = true;
        return;
      }
      if (ts.isCallExpression(node) && isExternalCall(node)) {
        external = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.node === sourceFile ? sourceFile : unit.node.body);
    return external;
  }

  function isExternalExpression(node) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isAwaitExpression(node)) return isExternalExpression(node.expression);
    if (ts.isIdentifier(node)) return externalIdentifiers.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "promise" && ts.isIdentifier(unwrap(node.expression))) return externalPromiseObjects.has(unwrap(node.expression).text);
      return node.name.text === "body";
    }
    if (ts.isNewExpression(node)) return isExternalPromiseConstructor(node);
    if (ts.isCallExpression(node)) return isExternalCall(node);
    return false;
  }

  function isExternalCall(node) {
    const expression = unwrap(node.expression);
    const name = callName(node);
    if (name === "fetch" || ["waitForDecision", "send", "evaluate", "tab", "enter", "type"].includes(name)) return true;
    if (isResponseBodyCall(node)) return true;
    if (name && externalUnits.has(functionsByName.get(name))) return true;
    if (ts.isPropertyAccessExpression(expression) && ["then", "catch", "finally"].includes(expression.name.text)) {
      return isExternalExpression(expression.expression);
    }
    if (ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === "Promise"
      && ["all", "allSettled", "race", "any"].includes(expression.name.text)) {
      return node.arguments.some((argument) => containsExternalProgress(argument));
    }
    return isExternalPromiseConstructor(node);
  }

  function containsExternalProgress(node) {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (isFunctionLike(child) && child !== node) {
        if (unitHasExternalProgress(unitByFunction.get(child))) found = true;
        return;
      }
      if (ts.isCallExpression(child) && isExternalCall(child)) {
        found = true;
        return;
      }
      if (ts.isAwaitExpression(child) && isExternalExpression(child.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  function isExternalPromiseConstructor(node) {
    if (!ts.isNewExpression(node)) return false;
    const expression = unwrap(node.expression);
    if (!ts.isIdentifier(expression) || expression.text !== "Promise") return false;
    const executor = node.arguments?.[0];
    if (!executor || !isFunctionLike(executor)) return false;
    return containsPromiseProgress(executor.body);
  }

  function isPromiseWithResolvers(node) {
    if (!ts.isCallExpression(node)) return false;
    const expression = unwrap(node.expression);
    return ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === "Promise"
      && expression.name.text === "withResolvers";
  }

  function containsPromiseProgress(node) {
    let found = false;
    const visit = (child) => {
      if (found || !child) return;
      if (child !== node && isFunctionLike(child)) return;
      if (ts.isCallExpression(child)) {
        const name = callName(child);
        if (["fetch", "setTimeout", "setInterval", "setImmediate", "once", "on", "addEventListener", "listen", "close", "send", "set"].includes(name)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  function collectSpanDerived(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && isSpanCall(node.initializer, budgetChainIdentifiers)) {
      spanDerivedTimeouts.add(node.name.text);
    }
    ts.forEachChild(node, collectSpanDerived);
  }

  function isSpanDerivedTimer(node) {
    const value = node.arguments[1];
    return ts.isIdentifier(value) && spanDerivedTimeouts.has(value.text);
  }

  function toViolation(file, name, node, kind, message) {
    const start = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { file: name, line: start.line + 1, column: start.character + 1, kind, message };
  }

  function isResponseBodyCall(node) {
    const expression = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(expression)) return false;
    if (["json", "text", "arrayBuffer"].includes(expression.name.text)) return true;
    return containsPropertyAccess(expression.expression, "body");
  }
}

/**
 * @param {string[]} [files]
 * @param {string} [root]
 * @returns {ProofPathViolation[]}
 */
export function checkProofPathFiles(files = DEFAULT_PROOF_PATH_FILES, root = process.cwd()) {
  return files.flatMap((file) => {
    const absolute = path.resolve(root, file);
    return findProofPathViolations(readFileSync(absolute, "utf8"), path.relative(root, absolute));
  });
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
}

function isRunCall(node, budgetChainIdentifiers) {
  const expression = unwrap(node.expression);
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === "run"
    && ts.isIdentifier(unwrap(expression.expression))
    && budgetChainIdentifiers.has(unwrap(expression.expression).text);
}

function isRunExpression(node, budgetChainIdentifiers) {
  return ts.isCallExpression(unwrap(node)) && isRunCall(unwrap(node), budgetChainIdentifiers);
}

function isBudgetChainCall(node) {
  if (!node) return false;
  const expression = unwrap(node);
  return ts.isCallExpression(expression) && callName(expression) === "defineBudgetChain";
}

function identifierCallName(node) {
  const expression = unwrap(node.expression);
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

function callName(node) {
  const expression = unwrap(node.expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function timerKind(node) {
  const expression = unwrap(node.expression);
  if (ts.isIdentifier(expression) && ["setTimeout", "setInterval", "setImmediate"].includes(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "AbortSignal"
    && expression.name.text === "timeout") return "AbortSignal.timeout";
  return undefined;
}

function timerCallbackKills(node) {
  const callback = node.arguments[0];
  if (!callback || !isFunctionLike(callback)) return false;
  let kills = false;
  const visit = (child) => {
    if (kills || child !== callback && isFunctionLike(child)) return;
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(unwrap(child.expression))
      && unwrap(child.expression).name.text === "kill") {
      kills = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(callback.body);
  return kills;
}

function hasInvalidSyncProcessTimeout(node, spanDerivedTimeouts) {
  const name = identifierCallName(node);
  if (!name || !["spawnSync", "execFileSync"].includes(name)) return false;
  const timeout = spawnTimeoutExpression(node);
  return !(timeout && ts.isIdentifier(timeout) && spanDerivedTimeouts.has(timeout.text));
}

function spawnTimeoutExpression(node) {
  const name = identifierCallName(node);
  if (!name || !["spawn", "spawnSync", "execFileSync"].includes(name)) return undefined;
  for (const argument of node.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || property.name.getText() !== "timeout") continue;
      return unwrap(property.initializer);
    }
  }
  return undefined;
}

function isSpanCall(node, budgetChainIdentifiers) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrap(node.expression);
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === "span"
    && ts.isIdentifier(unwrap(expression.expression))
    && budgetChainIdentifiers.has(unwrap(expression.expression).text);
}

function containsPropertyAccess(node, propertyName) {
  node = unwrap(node);
  if (!node) return false;
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === propertyName || containsPropertyAccess(node.expression, propertyName);
  }
  if (ts.isCallExpression(node)) return containsPropertyAccess(node.expression, propertyName);
  return false;
}

function timerValueIsLiteral(node) {
  return ts.isNumericLiteral(node.arguments[1]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const files = process.argv.slice(2);
  const violations = checkProofPathFiles(files.length > 0 ? files : DEFAULT_PROOF_PATH_FILES);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.kind}: ${violation.message}`);
  }
  if (violations.length > 0) process.exitCode = 1;
}
