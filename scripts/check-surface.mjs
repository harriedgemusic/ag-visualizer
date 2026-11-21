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
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'rm',
  'rmSync',
  'truncate',
  'truncateSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'createDirectory',
])

const FORBIDDEN_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
])

const failures = []

function stringLiteralValue(node) {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  return undefined
}

function checkModuleSpecifier(rel, isCore, specNode, kind) {
  const val = stringLiteralValue(specNode)
  if (val === undefined) {
    failures.push(`${rel}: dynamic/non-literal ${kind} specifier is not allowed`)
    return
  }
  if (isCore && (CORE_FORBIDDEN_MODULES.has(val) || val.startsWith('node:'))) {
    failures.push(`${rel}: forbidden core ${kind} "${val}"`)
  } else if (ALL_FORBIDDEN_MODULES.has(val)) {
    failures.push(`${rel}: forbidden ${kind} "${val}"`)
  }
}

function hasReadOnlyTrueOption(argNode) {
  if (!argNode || !ts.isObjectLiteralExpression(argNode)) return false
  return argNode.properties.some(prop => {
    if (!ts.isPropertyAssignment(prop)) return false
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : stringLiteralValue(prop.name)
    return key === 'readOnly' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword
  })
}

function inspectFile(file) {
  const rel = path.relative(ROOT, file)
  const isCore = file.startsWith(CORE_DIR + path.sep)
  const raw = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true)

  function visit(node) {
    // 1. Static imports / exports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      checkModuleSpecifier(rel, isCore, node.moduleSpecifier, 'import')
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      checkModuleSpecifier(rel, isCore, node.moduleSpecifier, 'export')
    }

    // 2. Call expressions: dynamic import(), require(), process.getBuiltinModule(), fetch(), fs writes, open('w')
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (expr.kind === ts.SyntaxKind.ImportKeyword) {
        checkModuleSpecifier(rel, isCore, node.arguments[0], 'dynamic import')
      } else if (ts.isIdentifier(expr)) {
        if (expr.text === 'require') {
          checkModuleSpecifier(rel, isCore, node.arguments[0], 'require')
        } else if (FORBIDDEN_GLOBALS.has(expr.text)) {
          failures.push(`${rel}: forbidden call ${expr.text}()`)
        } else if (FORBIDDEN_FS_METHODS.has(expr.text)) {
          failures.push(`${rel}: forbidden filesystem write call ${expr.text}()`)
        }
      } else if (ts.isPropertyAccessExpression(expr)) {
        const method = expr.name.text
        if (method === 'getBuiltinModule') {
          failures.push(`${rel}: forbidden process.getBuiltinModule() call`)
        } else if (FORBIDDEN_FS_METHODS.has(method)) {
          failures.push(`${rel}: forbidden write/delete method .${method}()`)
        } else if (method === 'open' && node.arguments.length >= 2) {
          const flags = stringLiteralValue(node.arguments[1])
          if (flags !== 'r') {
            failures.push(`${rel}: fs.open() must use explicit read-only flag 'r' (got ${flags ?? 'non-literal'})`)
          }
        } else if (method === 'delete' && expr.expression.getText(sf).includes('workspace.fs')) {
          failures.push(`${rel}: forbidden vscode.workspace.fs.delete()`)
        } else if (FORBIDDEN_GLOBALS.has(method) && (expr.expression.getText(sf) === 'globalThis' || expr.expression.getText(sf) === 'window')) {
          failures.push(`${rel}: forbidden global call ${expr.getText(sf)}()`)
        }
      } else if (ts.isElementAccessExpression(expr)) {
        const key = stringLiteralValue(expr.argumentExpression)
        if (key && (FORBIDDEN_GLOBALS.has(key) || FORBIDDEN_FS_METHODS.has(key) || key === 'getBuiltinModule')) {
          failures.push(`${rel}: forbidden bracket call ["${key}"]()`)
        }
      }
    }

    // 3. New expressions: WebSocket, XMLHttpRequest, DatabaseSync readOnly verification
    if (ts.isNewExpression(node)) {
      const expr = node.expression
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
        if (!hasReadOnlyTrueOption(optsArg)) {
          failures.push(`${rel}: new DatabaseSync() must pass { readOnly: true } as second argument`)
        }
      }
    }

    // 4. Core identifier guard: disallow referencing vscode or global network constructors
    if (isCore && ts.isIdentifier(node)) {
      if (node.text === 'vscode' || FORBIDDEN_GLOBALS.has(node.text)) {
        const parent = node.parent
        const isPropName =
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node)
        if (!isPropName) {
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
