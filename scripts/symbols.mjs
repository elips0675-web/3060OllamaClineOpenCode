// Индекс символов: «где что лежит» без чтения файлов целиком.
//
//   node scripts/symbols.mjs [--root <путь>] [--out <файл>] [--json] [--limit N]
//
// Срез — `src/` и `server/src/` (если их нет — весь проект): экспорты, функции,
// роуты по файлам. Вывод 3–5 КБ, чтобы влезал в бюджет шага локальной модели.
// Только чтение: скрипт ничего не меняет и не пишет в проект.
//
// Коды выхода: 0 — готово, 2 — ошибка аргументов или нет каталога.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTestFile, walkFiles } from './project-brief.mjs'

export const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
export const SCAN_DIRS = ['src', 'server/src']
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_OUTPUT_BYTES = 5 * 1024
const PER_FILE = 8

const EXPORT_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/
const EXPORT_FROM_RE = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/
const CJS_LIST_RE = /^\s*module\.exports\s*=\s*\{([^}]*)\}/
const CJS_NAME_RE = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/
const FUNC_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const ARROW_RE =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
const ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]*)['"`]/i

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

function addName(set, name) {
  if (name && !set.has(name)) set.add(name)
}

function parseNames(list) {
  return list
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
}

// Разбор одного файла: экспорты, функции, роуты. Возвращает null, если ничего нет.
export function scanSource(text) {
  const exports = new Set()
  const functions = new Set()
  const routes = []

  for (const line of text.split(/\r?\n/)) {
    if (isComment(line)) continue

    const exported = EXPORT_RE.exec(line)
    if (exported) addName(exports, exported[1])

    const list = EXPORT_LIST_RE.exec(line)
    if (list) for (const name of parseNames(list[1])) addName(exports, name)

    const from = EXPORT_FROM_RE.exec(line)
    if (from) addName(exports, `from ${from[1]}`)

    const cjsList = CJS_LIST_RE.exec(line)
    if (cjsList) for (const name of parseNames(cjsList[1])) addName(exports, name)

    const cjsName = CJS_NAME_RE.exec(line)
    if (cjsName) addName(exports, cjsName[1])

    const fn = FUNC_RE.exec(line)
    if (fn) addName(functions, fn[1])

    const arrow = ARROW_RE.exec(line)
    if (arrow) addName(functions, arrow[1])

    const route = ROUTE_RE.exec(line)
    if (route && /(router|app|server|api|fastify)$/.test(route[1].toLowerCase())) {
      routes.push(`${route[2].toUpperCase()} ${route[3]}`)
    }
  }

  if (exports.size === 0 && functions.size === 0 && routes.length === 0) return null
  return {
    exports: [...exports],
    functions: [...functions],
    routes: [...new Set(routes)],
  }
}

const prioritize = (files) =>
  [...files].sort(
    (a, b) => Number(isTestFile(a)) - Number(isTestFile(b)) || a.localeCompare(b),
  )

export function codeFiles(root) {
  const all = prioritize(
    walkFiles(root)
      .filter((entry) => CODE_EXT.has(path.extname(entry.path).toLowerCase()))
      .map((entry) => entry.path),
  )
  const scanned = all.filter((file) =>
    SCAN_DIRS.some((dir) => file === dir || file.startsWith(`${dir}/`)),
  )
  if (scanned.length > 0) return { files: scanned, dirs: SCAN_DIRS.slice(), fallback: false }
  return { files: all, dirs: [], fallback: true }
}

export function collectSymbols(root, { limit = 60 } = {}) {
  const { files, dirs, fallback } = codeFiles(root)
  const shown = []
  let skipped = 0

  for (const file of files) {
    if (shown.length >= limit) {
      skipped += 1
      continue
    }
    const abs = path.join(root, file)
    let size = 0
    try {
      size = statSync(abs).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    let text = ''
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const symbols = scanSource(text)
    if (symbols) shown.push({ path: file, ...symbols })
  }

  const totals = { files: files.length, exports: 0, functions: 0, routes: 0 }
  for (const item of shown) {
    totals.exports += item.exports.length
    totals.functions += item.functions.length
    totals.routes += item.routes.length
  }

  return { root, dirs, fallback, limit, skipped, totals, files: shown }
}

const clip = (items) =>
  items.length <= PER_FILE
    ? items.join(', ')
    : `${items.slice(0, PER_FILE).join(', ')} +${items.length - PER_FILE}`

export function renderSymbols(data) {
  const lines = []
  const source = data.fallback ? 'весь проект (src/ и server/src/ не найдены)' : data.dirs.join(', ')
  lines.push(`Индекс символов: ${data.root}`)
  lines.push(
    `Срез: ${source} | файлов: ${data.totals.files} (показано ${data.files.length}) | ` +
      `экспортов ${data.totals.exports}, функций ${data.totals.functions}, роутов ${data.totals.routes}`,
  )
  lines.push('')

  let printed = 0
  for (const item of data.files) {
    if (Buffer.byteLength(lines.join('\n'), 'utf8') >= MAX_OUTPUT_BYTES) break
    const block = [item.path]
    if (item.exports.length) block.push(`  export: ${clip(item.exports)}`)
    if (item.functions.length) block.push(`  fn: ${clip(item.functions)}`)
    if (item.routes.length) block.push(`  route: ${clip(item.routes)}`)
    lines.push(...block)
    printed += 1
  }

  const omitted = data.files.length - printed + data.skipped
  if (omitted > 0) {
    lines.push('')
    lines.push(
      `-- обрезано: ${omitted} файлов не показаны ` +
        `(бюджет ${MAX_OUTPUT_BYTES} Б, --limit ${data.limit})`,
    )
  }
  lines.push('')
  lines.push('Индекс — не доказательство: перед утверждением открой файл и цитируй file:line.')
  return `${lines.join('\n')}\n`
}

export function parseArgs(argv, cwd = process.cwd()) {
  let root = cwd
  let out = ''
  let json = false
  let limit = 60

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('--root требует путь')
      root = value
      i += 1
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (!value) throw new Error('--root требует путь')
      root = value
    } else if (arg === '--out') {
      const value = argv[i + 1]
      if (!value) throw new Error('--out требует путь')
      out = value
      i += 1
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--limit') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit требует целое > 0')
      limit = value
      i += 1
    } else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length))
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit требует целое > 0')
      limit = value
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, root, out, json, limit }
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`)
    }
  }

  return { help: false, root: path.resolve(root), out, json, limit }
}

function usage() {
  return `Индекс символов проекта: экспорты, функции, роуты по файлам.

  node scripts/symbols.mjs [--root <путь>] [--out <файл>] [--json] [--limit N]

  --root   корень проекта (по умолчанию текущий каталог)
  --out    записать индекс в файл (UTF-8) вместо печати
  --json   печатать JSON (для скриптов)
  --limit  сколько файлов показывать (по умолчанию 60)
  --help   эта справка

Примеры:
  node scripts/symbols.mjs --root "D:\\\\swiftmatch1bdnoutprodpart"
  node scripts/symbols.mjs --out tmp\\\\symbols.txt
`
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }

  if (args.help) {
    console.log(usage())
    return 0
  }

  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    console.error(`✗ Нет такого каталога: ${args.root}`)
    return 2
  }

  const data = collectSymbols(args.root, { limit: args.limit })
  const payload = args.json
    ? `${JSON.stringify(data, null, 2)}\n`
    : renderSymbols(data)

  if (args.out) {
    const target = path.resolve(args.out)
    writeFileSync(target, payload, 'utf8')
    console.log(`Индекс записан: ${target}`)
  } else {
    process.stdout.write(payload)
  }
  return 0
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
