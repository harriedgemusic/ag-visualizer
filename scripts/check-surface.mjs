import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SRC_DIR = path.join(ROOT, 'src')
const CORE_DIR = path.join(SRC_DIR, 'core')

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const ALL_FORBIDDEN_MODULES = new Set([
  'child_process',
  'node:child_process',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'net',
  'node:net',
  'dgram',
  'node:dgram',
  'tls',
  'node:tls',
  'dns',
  'node:dns',
  'worker_threads',
  'node:worker_threads',
  'module',
  'node:module',
  'vm',
  'node:vm',
  'inspector',
  'node:inspector',
])

const CORE_FORBIDDEN_MODULES = new Set([
  ...ALL_FORBIDDEN_MODULES,
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'os',
  'node:os',
  'crypto',
  'node:crypto',
  'sqlite',
  'node:sqlite',
  'string_decoder',
  'node:string_decoder',
  'vscode',
])

const FORBIDDEN_FS_METHODS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'unlink',
  'unlinkSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rmdir',
  'rmdirSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'copy',
  'rm',
  'rmSync',
  'truncate',
  'truncateSync',
  'ftruncate',
  'chmod',
  'chmodSync',
  'lchmod',
  'fchmod',
  'chown',
  'chownSync',
  'lchown',
  'fchown',
  'utimes',
  'utimesSync',
  'lutimes',
  'lutimesSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'createDirectory',
])

const FORBIDDEN_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'Function',
  'eval',
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
])

const GLOBAL_HOLDERS = new Set(['globalThis', 'window', 'self', 'global'])
const SENSITIVE_HOLDERS = new Set(['fs', 'promises', 'process', 'globalThis', 'window', 'self', 'global'])

const failures = []

function unwrapExpr(node) {
  let cur = node
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur))
  ) {
    cur = cur.expression
  }
  return cur
}

function stringLiteralValue(node) {
  const cur = unwrapExpr(node)
  if (!cur) return undefined
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) {
    return cur.text
  }
  return undefined
}

function checkModuleSpecifier(file, rel, isCore, specNode, kind) {
  const val = stringLiteralValue(specNode)
  if (val === undefined) {
    failures.push(`${rel}: dynamic/non-literal ${kind} specifier is not allowed`)
    return
  }
  if (isCore) {
    if (CORE_FORBIDDEN_MODULES.has(val) || val.startsWith('node:')) {
      failures.push(`${rel}: forbidden core ${kind} "${val}"`)
      return
    }
    if (val.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), val)
      if (!resolved.startsWith(CORE_DIR + path.sep) && resolved !== CORE_DIR) {
        failures.push(`${rel}: core ${kind} "${val}" escapes src/core`)
      }
    } else {
      failures.push(`${rel}: core external ${kind} "${val}" is not allowed`)
    }
    return
  }
  if (ALL_FORBIDDEN_MODULES.has(val)) {
    failures.push(`${rel}: forbidden ${kind} "${val}"`)
  }
}

function hasStrictReadOnlyTrueOption(argNode) {
  const unwrapped = unwrapExpr(argNode)
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return false
  let readOnlyVal
  for (const prop of unwrapped.properties) {
    if (ts.isSpreadAssignment(prop)) return false
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) ? prop.name.text : stringLiteralValue(prop.name)
    if (key === 'readOnly') {
      readOnlyVal = unwrapExpr(prop.initializer)?.kind === ts.SyntaxKind.TrueKeyword
    }
  }
  return readOnlyVal === true
}

function inspectFile(file) {
  const rel = path.relative(ROOT, file)
  const isCore = file.startsWith(CORE_DIR + path.sep)
  const raw = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true)

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      checkModuleSpecifier(file, rel, isCore, node.moduleSpecifier, 'import')
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      checkModuleSpecifier(file, rel, isCore, node.moduleSpecifier, 'export')
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkModuleSpecifier(file, rel, isCore, node.moduleReference.expression, 'import=')
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrapExpr(node.initializer)
      if (init && ts.isPropertyAccessExpression(init) && init.name.text === 'DatabaseSync') {
        failures.push(`${rel}: aliasing DatabaseSync is disallowed (use new sqlite.DatabaseSync(..., { readOnly: true }) directly)`)
      }
    }

    if (ts.isCallExpression(node)) {
      const expr = unwrapExpr(node.expression)
      if (expr.kind === ts.SyntaxKind.ImportKeyword) {
        checkModuleSpecifier(file, rel, isCore, node.arguments[0], 'dynamic import')
      } else if (ts.isIdentifier(expr)) {
        if (expr.text === 'require') {
          checkModuleSpecifier(file, rel, isCore, node.arguments[0], 'require')
        } else if (FORBIDDEN_GLOBALS.has(expr.text)) {
          failures.push(`${rel}: forbidden call ${expr.text}()`)
        } else if (FORBIDDEN_FS_METHODS.has(expr.text)) {
          failures.push(`${rel}: forbidden filesystem write call ${expr.text}()`)
        }
      } else if (ts.isPropertyAccessExpression(expr)) {
        const method = expr.name.text
        const receiver = unwrapExpr(expr.expression)
        const recName = ts.isIdentifier(receiver) ? receiver.text : ''
        if (method === 'getBuiltinModule' || (recName === 'process' && (method === 'binding' || method === 'dlopen'))) {
          failures.push(`${rel}: forbidden process.${method}() call`)
        } else if (FORBIDDEN_FS_METHODS.has(method)) {
          const isStringDecoderWrite = method === 'write' && /(?:^|\.)decoder$/.test(expr.expression.getText(sf))
          if (!isStringDecoderWrite) {
            failures.push(`${rel}: forbidden write/delete method .${method}()`)
          }
        } else if ((method === 'open' || method === 'openSync') && node.arguments.length >= 2) {
          const flags = stringLiteralValue(node.arguments[1])
          if (flags !== 'r') {
            failures.push(`${rel}: fs.${method}() must use explicit read-only flag 'r' (got ${flags ?? 'non-literal'})`)
          }
        } else if (method === 'delete' && expr.expression.getText(sf).includes('workspace.fs')) {
          failures.push(`${rel}: forbidden vscode.workspace.fs.delete()`)
        } else if (FORBIDDEN_GLOBALS.has(method) && GLOBAL_HOLDERS.has(recName)) {
          failures.push(`${rel}: forbidden global call ${recName}.${method}()`)
        }
      } else if (ts.isElementAccessExpression(expr)) {
        const receiver = unwrapExpr(expr.expression)
        const recName = ts.isIdentifier(receiver) ? receiver.text : ''
        const key = stringLiteralValue(expr.argumentExpression)
        if (!key && SENSITIVE_HOLDERS.has(recName)) {
          failures.push(`${rel}: non-literal computed call on ${recName} is disallowed`)
        } else if (
          key &&
          (FORBIDDEN_GLOBALS.has(key) || FORBIDDEN_FS_METHODS.has(key) || key === 'getBuiltinModule' || key === 'binding' || key === 'dlopen')
        ) {
          failures.push(`${rel}: forbidden bracket call ["${key}"]()`)
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const expr = unwrapExpr(node.expression)
      const name = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.name.text
          : ''
      if (FORBIDDEN_GLOBALS.has(name)) {
        failures.push(`${rel}: forbidden constructor new ${name}()`)
      }
      if (name === 'DatabaseSync') {
        const optsArg = node.arguments?.[1]
        if (!hasStrictReadOnlyTrueOption(optsArg)) {
          failures.push(`${rel}: new DatabaseSync() must pass literal { readOnly: true } as second argument`)
        }
      }
    }

    if (isCore && ts.isIdentifier(node)) {
      if (node.text === 'vscode' || FORBIDDEN_GLOBALS.has(node.text) || GLOBAL_HOLDERS.has(node.text)) {
        const parent = node.parent
        const isAllowedProp =
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node && !GLOBAL_HOLDERS.has(unwrapExpr(parent.expression).getText(sf)))
        if (!isAllowedProp) {
          failures.push(`${rel}: core module references forbidden identifier "${node.text}"`)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
}

const files = walk(SRC_DIR)
for (const file of files) {
  inspectFile(file)
}

if (failures.length > 0) {
  console.error('AST Surface check FAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}

console.log(`AST Surface check OK (${files.length} source files verified read-only & network-free).`)
