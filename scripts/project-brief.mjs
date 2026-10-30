// Сборщик фактов о проекте для локального анализа.
//
// Зачем: модель видит только то, что попало в контекст. README врёт или
// отстаёт, а «прочитай весь репозиторий» в 12k контекста не влезает.
// Скрипт печатает компактный бриф (~5 КБ): пакет, скрипты, точки входа,
// роуты, миграции, тесты, конфиги, крупные файлы и счётчики TODO/any.
// Дальше модель ОБЯЗАНА прочитать 3-6 файлов из брифа целиком и цитировать
// file:line — сам бриф доказательством не является.
//
// Использование:
//   node scripts/project-brief.mjs
//   node scripts/project-brief.mjs --root "D:\путь\к\проекту"
//   node scripts/project-brief.mjs --root . --out tmp\brief.txt
//   node scripts/project-brief.mjs --json
//   node scripts/project-brief.mjs --limit 10
//
// Коды выхода: 0 — готово, 2 — ошибка аргументов/каталога.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Служебные каталоги: в бриф не попадают ни они, ни их содержимое.
const NOISE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.output',
  'tmp',
  'temp',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
])

const CODE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.php',
  '.rb',
  '.cs',
  '.vue',
  '.svelte',
])

const CONFIG_RE =
  /^(tsconfig.*\.json|jsconfig.*\.json|eslint.*|\.eslintrc.*|prettier.*|\.prettierrc.*|vite\.config\..*|webpack\..*|rollup\..*|babel\.config\..*|jest\..*|vitest\..*|playwright\..*|docker-compose.*|Dockerfile.*|\.env\.(example|sample|template)|\.editorconfig|\.nvmrc|turbo\.json|nx\.json|lerna\.json|Makefile|AGENTS\.md|\.clinerules|opencode\.jsonc?)$/i

const MARKERS = [
  ['TODO', /\bTODO\b/g],
  ['FIXME', /\bFIXME\b/g],
  ['any', /\bany\b/g],
  ['@ts-ignore', /@ts-ignore\b/g],
  ['@ts-expect-error', /@ts-expect-error\b/g],
  ['eslint-disable', /eslint-disable/g],
]

const MAX_SCAN_BYTES = 512 * 1024
const MAX_SCAN_FILES = 4000

const toPosix = (value) => value.split(path.sep).join('/')

export function isNoiseDir(name) {
  return NOISE_DIRS.has(String(name).toLowerCase())
}

// Обход дерева без служебных каталогов. Возвращает относительные пути
// в posix-форме и размеры; порядок детерминированный (сортировка в конце).
export function walkFiles(root, { maxFiles = 25000 } = {}) {
  const out = []
  const stack = [{ dir: root, rel: '' }]

  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, rel } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (out.length >= maxFiles) break
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue

      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (isNoiseDir(entry.name)) continue
        stack.push({ dir: full, rel: childRel })
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = statSync(full).size
        } catch {
          // файл исчез между readdir и stat — пропускаем размер
        }
        out.push({ path: childRel, size })
      }
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
  } catch {
    return ''
  }
}

export function gitInfo(root) {
  const branch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const last = runGit(root, ['log', '-1', '--format=%h %s'])
  const dirty = runGit(root, ['status', '--porcelain'])
    .split('\n')
    .filter(Boolean).length
  return { branch, last, dirty }
}

export function readPackage(root) {
  const file = path.join(root, 'package.json')
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export function detectEntryPoints(files, pkg) {
  const found = new Set()
  const add = (value) => {
    if (typeof value !== 'string') return
    const clean = toPosix(value).replace(/^\.\//, '')
    if (files.some((f) => f.path === clean)) found.add(clean)
  }

  if (pkg) {
    add(pkg.main)
    add(pkg.module)
    if (typeof pkg.bin === 'string') add(pkg.bin)
    else if (pkg.bin && typeof pkg.bin === 'object') Object.values(pkg.bin).forEach(add)
  }

  const re = /(^|\/)(?:src\/)?(server|app|main|index|cli)\.(ts|tsx|js|mjs|cjs|py|go|rs)$/i
  for (const file of files) {
    if (re.test(file.path)) found.add(file.path)
  }
  return [...found].sort().slice(0, 10)
}

export function isTestFile(file) {
  return (
    /(^|\/)(__tests__|tests?)\//.test(file) ||
    /\.(test|spec)\.[^./]+$/i.test(file)
  )
}

export function isRouteFile(file) {
  return (
    /(^|\/)routes?\//.test(file) ||
    /(^|\/)controllers?\//.test(file) ||
    /(^|\/)pages\/api\//.test(file) ||
    /(^|\/)api\//.test(file)
  )
}

export function isDbFile(file) {
  // models/Modelfile-* — это сборки Ollama, а не ORM-модели.
  if (/^Modelfile/i.test(path.posix.basename(file))) return false
  return (
    /(^|\/)migrations?\//.test(file) ||
    /\.sql$/i.test(file) ||
    /(^|\/)schema\.prisma$/i.test(file) ||
    /(^|\/)models?\//i.test(file)
  )
}

export function isConfigFile(file) {
  return CONFIG_RE.test(path.posix.basename(file))
}

function scanMarkers(root, files) {
  const counts = Object.fromEntries(MARKERS.map(([name]) => [name, 0]))
  let scanned = 0

  for (const file of files) {
    if (scanned >= MAX_SCAN_FILES) break
    if (file.size > MAX_SCAN_BYTES) continue
    const ext = path.posix.extname(file.path).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    // «any» — только в JS/TS: в Python/Go это слово встречается в тексте.
    const jsLike = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)

    let text
    try {
      text = readFileSync(path.join(root, file.path), 'utf8')
    } catch {
      continue
    }
    scanned += 1

    for (const [name, re] of MARKERS) {
      if (name === 'any' && !jsLike) continue
      const matches = text.match(re)
      if (matches) counts[name] += matches.length
    }
  }

  return { ...counts, scanned }
}

function topDirs(files, limit = 15) {
  const counts = new Map()
  for (const file of files) {
    const slash = file.path.indexOf('/')
    const dir = slash === -1 ? '(корень)' : file.path.slice(0, slash)
    counts.set(dir, (counts.get(dir) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir, count]) => ({ dir, count }))
}

export function collectBrief(root, { limit = 20 } = {}) {
  const files = walkFiles(root)
  const pkg = readPackage(root)
  const git = gitInfo(root)
  const paths = files.map((file) => file.path)

  return {
    root: path.resolve(root),
    git,
    package: pkg
      ? {
          name: pkg.name || '',
          version: pkg.version || '',
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        }
      : null,
    filesTotal: files.length,
    topDirs: topDirs(files),
    entry: detectEntryPoints(files, pkg),
    routes: paths.filter(isRouteFile).slice(0, limit),
    db: paths.filter(isDbFile).slice(0, limit),
    tests: paths.filter(isTestFile).slice(0, limit),
    testsTotal: paths.filter(isTestFile).length,
    configs: paths.filter(isConfigFile).slice(0, limit),
    largest: [...files]
      .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((file) => ({ path: file.path, bytes: file.size })),
    markers: scanMarkers(root, files),
  }
}

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} КБ`

function list(title, items, limit) {
  if (items.length === 0) return [`${title}: —`]
  const shown = items.slice(0, limit)
  const tail = items.length > shown.length ? ` … ещё ${items.length - shown.length}` : ''
  return [`${title}: ${shown.join(', ')}${tail}`]
}

export function renderBrief(brief, { limit = 20 } = {}) {
  const lines = []
  lines.push('PROJECT BRIEF — факты для анализа (не доказательство)')
  lines.push(`root: ${brief.root}`)
  lines.push(
    brief.git.branch
      ? `git: ${brief.git.branch} · ${brief.git.last || '—'} · изменено файлов: ${brief.git.dirty}`
      : 'git: не репозиторий или git недоступен',
  )

  if (brief.package) {
    const p = brief.package
    lines.push(`package: ${p.name || '—'} ${p.version || ''}`.trim())
    const scripts = Object.entries(p.scripts)
      .slice(0, limit)
      .map(([name, cmd]) => `${name}=${cmd}`)
    lines.push(`scripts: ${scripts.length ? scripts.join(' · ') : '—'}`)
    if (p.dependencies.length) {
      lines.push(`deps (${p.dependencies.length}): ${p.dependencies.slice(0, limit).join(', ')}`)
    }
    if (p.devDependencies.length) {
      lines.push(
        `devDeps (${p.devDependencies.length}): ${p.devDependencies.slice(0, limit).join(', ')}`,
      )
    }
  } else {
    lines.push('package: package.json нет')
  }

  lines.push(`files: ${brief.filesTotal} (без node_modules/dist/.git)`)
  lines.push(
    `top: ${brief.topDirs.map((d) => `${d.dir} (${d.count})`).join(', ') || '—'}`,
  )
  lines.push(...list('entry', brief.entry, limit))
  lines.push(...list('routes', brief.routes, limit))
  lines.push(...list('db', brief.db, limit))
  lines.push(...list('tests', brief.tests, limit))
  lines.push(...list('configs', brief.configs, limit))

  if (brief.largest.length) {
    lines.push('largest:')
    for (const file of brief.largest.slice(0, limit)) {
      lines.push(`  ${file.path} — ${kb(file.bytes)}`)
    }
  }

  const m = brief.markers
  lines.push(
    `markers: TODO=${m.TODO} FIXME=${m.FIXME} any=${m.any} @ts-ignore=${m['@ts-ignore']} @ts-expect-error=${m['@ts-expect-error']} eslint-disable=${m['eslint-disable']} (файлов просмотрено: ${m.scanned})`,
  )

  lines.push('---')
  lines.push('Дальше: прочитай 3-6 файлов из entry/routes/db ЦЕЛИКОМ,')
  lines.push('каждое утверждение подкрепи file:line. Бриф сам по себе — не факт.')
  return `${lines.join('\n')}\n`
}

export function parseArgs(argv, cwd = process.cwd()) {
  let root = cwd
  let out = ''
  let json = false
  let limit = 20

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
  return `Сборщик фактов о проекте.

  node scripts/project-brief.mjs [--root <путь>] [--out <файл>] [--json] [--limit N]

  --root   корень проекта (по умолчанию текущий каталог)
  --out    записать бриф в файл (UTF-8) вместо печати
  --json   печатать JSON (для скриптов), а не текст
  --limit  сколько элементов показывать в каждом списке (по умолчанию 20)
  --help   эта справка

Примеры:
  node scripts/project-brief.mjs --root "D:\\swiftmatch1bdnoutprodpart1"
  node scripts/project-brief.mjs --out tmp\\brief.txt
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

  const brief = collectBrief(args.root, { limit: args.limit })
  const payload = args.json ? `${JSON.stringify(brief, null, 2)}\n` : renderBrief(brief, { limit: args.limit })

  if (args.out) {
    const target = path.resolve(args.out)
    writeFileSync(target, payload, 'utf8')
    console.log(`Бриф записан: ${target}`)
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

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
