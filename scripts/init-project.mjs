// Установщик шаблонов комплекта в другой проект.
//
// Что копирует:
//   .clinerules/00-project.md      — паспорт проекта (если файла ещё нет);
//   .clinerules/40-agent-cycle.md  — агентный цикл;
//   .clinerules/50-few-shot.md     — примеры правильного ответа;
//   .clinerules/workflows/*.md     — 7 процедур, включая deep-planning;
//   cline_docs/*.md                — Memory Bank (существующие не трогает);
//   docs/AGENTS-cline-setup.md     — настройки Cline;
//   docs/AGENTS-verify-checklist.md — проверка до/после правки.
//
// Использование:
//   node scripts/init-project.mjs --root "D:\проект" --dry-run
//   node scripts/init-project.mjs --root "D:\проект"
//   node scripts/init-project.mjs --root "D:\проект" --force
//   node scripts/init-project.mjs --root "D:\проект" --convert-rules
//
// Флаги:
//   --dry-run        показать план, ничего не писать;
//   --force          перезаписать правила, workflows и docs, если отличаются;
//   --force-memory   перезаписать cline_docs (по умолчанию память сохраняется);
//   --convert-rules  если .clinerules — файл: сохранить его как
//                    .clinerules/00-project-rules.md и сделать каталог;
//   --no-workflows   не копировать workflows;
//   --no-memory      не создавать cline_docs;
//   --no-docs        не копировать docs.
//
// Коды выхода: 0 — готово, 1 — конфликт/ошибка записи, 2 — ошибка аргументов.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const KIT_ROOT = path.resolve(SCRIPT_DIR, '..')

const TEMPLATES = path.join(KIT_ROOT, 'templates')
const RULES_DIR = path.join(TEMPLATES, 'rules')
const WORKFLOWS_DIR = path.join(TEMPLATES, 'workflows')
const MEMORY_DIR = path.join(TEMPLATES, 'cline_docs')
const DOCS_DIR = path.join(KIT_ROOT, 'docs')

export const USAGE = `Установка шаблонов 3060OllamaClineOpenCode в проект.

  node scripts/init-project.mjs --root <проект> [--dry-run] [--force]

Флаги:
  --dry-run        показать план, ничего не писать
  --force          перезаписать правила, workflows и docs при отличии
  --force-memory   перезаписать cline_docs (по умолчанию память сохраняется)
  --convert-rules  .clinerules-файл превратить в каталог с 00-project-rules.md
  --no-workflows   не копировать .clinerules/workflows
  --no-memory      не создавать cline_docs
  --no-docs        не копировать docs
  -h, --help       эта справка

По умолчанию корень — текущий каталог. Установка в сам комплект запрещена.`

export class UserError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UserError'
    this.code = 2
  }
}

const DEFAULT_OPTIONS = {
  root: process.cwd(),
  dryRun: false,
  force: false,
  forceMemory: false,
  convertRules: false,
  noWorkflows: false,
  noMemory: false,
  noDocs: false,
  help: false,
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULT_OPTIONS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new UserError('--root требует путь к проекту')
      options.root = value
      i += 1
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--force-memory') {
      options.forceMemory = true
    } else if (arg === '--convert-rules') {
      options.convertRules = true
    } else if (arg === '--no-workflows') {
      options.noWorkflows = true
    } else if (arg === '--no-memory') {
      options.noMemory = true
    } else if (arg === '--no-docs') {
      options.noDocs = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new UserError(`неизвестный аргумент: ${arg}`)
    }
  }
  options.root = path.resolve(options.root)
  return options
}

const normalize = (text) => String(text).replace(/\r\n/g, '\n').replace(/\s+$/u, '')

export function listMarkdown(dir) {
  if (!existsSync(dir)) throw new UserError(`нет каталога шаблонов: ${dir}`)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'ru'))
}

function addMkdir(plan, target) {
  if (plan.actions.some((action) => action.type === 'mkdir' && action.target === target)) return
  plan.actions.push({ type: 'mkdir', target })
}

function copyDecision({ source, target, force, immutable = false, memory = false, forceMemory = false }) {
  if (!existsSync(target)) {
    return { type: 'copy', source, target, reason: 'новый файл' }
  }
  if (!statSync(target).isFile()) {
    return { type: 'conflict', source, target, reason: 'цель существует, но это не файл' }
  }
  if (normalize(readFileSync(source, 'utf8')) === normalize(readFileSync(target, 'utf8'))) {
    return { type: 'skip', source, target, reason: 'уже совпадает' }
  }
  if (immutable) {
    return { type: 'skip', source, target, reason: 'существующий паспорт проекта сохранён' }
  }
  if (memory) {
    if (!forceMemory) {
      return { type: 'skip', source, target, reason: 'Memory Bank сохранён; нужен --force-memory' }
    }
    return { type: 'copy', source, target, reason: 'перезапись по --force-memory' }
  }
  if (!force) {
    return { type: 'skip', source, target, reason: 'отличается; нужен --force' }
  }
  return { type: 'copy', source, target, reason: 'перезапись по --force' }
}

function planFile(plan, options, source, target, extra = {}) {
  plan.actions.push(copyDecision({ source, target, ...options, ...extra }))
}

export function buildPlan(options) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const root = path.resolve(opts.root)

  if (root === KIT_ROOT) {
    throw new UserError('корень совпадает с комплектом: укажите --root другого проекта')
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UserError(`нет каталога проекта: ${root}`)
  }

  const plan = { root, actions: [], warnings: [] }
  const rulesPath = path.join(root, '.clinerules')

  if (existsSync(rulesPath)) {
    if (statSync(rulesPath).isDirectory()) {
      // уже каталог — работаем с ним
    } else if (opts.convertRules) {
      plan.actions.push({ type: 'convert-rules', source: rulesPath, target: rulesPath })
    } else {
      plan.actions.push({
        type: 'conflict',
        target: rulesPath,
        reason: 'это файл; workflows требуют каталог. Запустите с --convert-rules (файл сохранится как 00-project-rules.md)',
      })
      return plan
    }
  } else {
    addMkdir(plan, rulesPath)
  }

  const ruleFiles = [
    { source: path.join(RULES_DIR, '00-project.md'), name: '00-project.md', immutable: true },
    { source: path.join(TEMPLATES, 'agent-protocol.md'), name: '40-agent-cycle.md' },
    { source: path.join(TEMPLATES, 'few-shot.md'), name: '50-few-shot.md' },
  ]
  for (const rule of ruleFiles) {
    planFile(plan, opts, rule.source, path.join(rulesPath, rule.name), { immutable: rule.immutable })
  }

  if (!opts.noWorkflows) {
    const workflowsPath = path.join(rulesPath, 'workflows')
    addMkdir(plan, workflowsPath)
    for (const name of listMarkdown(WORKFLOWS_DIR)) {
      planFile(plan, opts, path.join(WORKFLOWS_DIR, name), path.join(workflowsPath, name))
    }
  }

  if (!opts.noMemory) {
    const memoryPath = path.join(root, 'cline_docs')
    addMkdir(plan, memoryPath)
    for (const name of listMarkdown(MEMORY_DIR)) {
      planFile(plan, opts, path.join(MEMORY_DIR, name), path.join(memoryPath, name), { memory: true })
    }
  }

  if (!opts.noDocs) {
    const docsPath = path.join(root, 'docs')
    addMkdir(plan, docsPath)
    planFile(plan, opts, path.join(DOCS_DIR, 'AGENTS-cline-setup.md'), path.join(docsPath, 'AGENTS-cline-setup.md'))
    planFile(plan, opts, path.join(TEMPLATES, 'verify-checklist.md'), path.join(docsPath, 'AGENTS-verify-checklist.md'))
  }

  return plan
}

export function applyPlan(plan, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const results = []

  for (const action of plan.actions) {
    if (action.type === 'skip' || action.type === 'conflict') {
      results.push({ ...action, applied: false })
      continue
    }
    if (opts.dryRun) {
      results.push({ ...action, applied: false, dryRun: true })
      continue
    }

    try {
      if (action.type === 'mkdir') {
        mkdirSync(action.target, { recursive: true })
        results.push({ ...action, applied: true })
      } else if (action.type === 'copy') {
        mkdirSync(path.dirname(action.target), { recursive: true })
        copyFileSync(action.source, action.target)
        results.push({ ...action, applied: true })
      } else if (action.type === 'convert-rules') {
        const backup = `${action.source}.kit-backup`
        const safeBackup = existsSync(backup) ? `${backup}.${Date.now()}` : backup
        renameSync(action.source, safeBackup)
        try {
          mkdirSync(action.target, { recursive: true })
          writeFileSync(path.join(action.target, '00-project-rules.md'), readFileSync(safeBackup))
        } catch (error) {
          // Не терять старые правила, если создать каталог или файл не удалось.
          try {
            if (!existsSync(action.source)) renameSync(safeBackup, action.source)
          } catch {
            // Если вернуть файл нельзя, бэкап остаётся рядом: путь виден в ошибке.
          }
          throw error
        }
        if (existsSync(safeBackup)) rmSync(safeBackup)
        results.push({ ...action, applied: true, movedTo: path.join(action.target, '00-project-rules.md') })
      } else {
        results.push({ ...action, applied: false, reason: `неизвестное действие: ${action.type}` })
      }
    } catch (error) {
      results.push({ ...action, applied: false, error: error.message })
    }
  }

  return results
}

export function installProject(options = {}) {
  const plan = buildPlan(options)
  const results = applyPlan(plan, options)
  const failed = results.filter((result) => result.type === 'conflict' || result.error)
  return { ...plan, results, ok: failed.length === 0 }
}

const relative = (root, target) => path.relative(root, target).replace(/\\/g, '/') || '.'

export function formatResult(result, root, dryRun = false) {
  const prefix = dryRun ? '[dry-run] ' : ''
  const target = result.target ? relative(root, result.target) : '—'
  if (result.type === 'mkdir') return `${prefix}[DIR ] ${target}`
  if (result.type === 'copy') return `${prefix}[COPY] ${target} — ${result.reason || ''}`.trimEnd()
  if (result.type === 'skip') return `${prefix}[SKIP] ${target} — ${result.reason || ''}`.trimEnd()
  if (result.type === 'conflict') return `${prefix}[CONFLICT] ${target} — ${result.reason || ''}`.trimEnd()
  if (result.type === 'convert-rules') {
    return `${prefix}[CONVERT] .clinerules -> .clinerules/00-project-rules.md`
  }
  return `${prefix}[?] ${target} — ${result.reason || result.error || result.type}`
}

export function runCli(argv = process.argv.slice(2), io = console) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      io.log(USAGE)
      return 0
    }

    const result = installProject(options)
    for (const row of result.results) io.log(formatResult(row, result.root, options.dryRun))

    const conflicts = result.results.filter((row) => row.type === 'conflict')
    const errors = result.results.filter((row) => row.error)
    const changed = result.results.filter(
      (row) => row.applied || (options.dryRun && (row.type === 'copy' || row.type === 'mkdir' || row.type === 'convert-rules')),
    )

    if (conflicts.length > 0) {
      io.error('\n✗ есть конфликты: установка неполная. Исправьте и повторите.')
      return 1
    }
    if (errors.length > 0) {
      io.error('\n✗ часть файлов не записана. Проверьте права и повторите.')
      return 1
    }

    const verb = options.dryRun ? 'будет создано/обновлено' : 'создано/обновлено'
    io.log(`\n✓ ${verb}: ${changed.length}; пропущено: ${result.results.length - changed.length}`)
    if (options.dryRun) io.log('  Это был --dry-run: файлы не изменены.')
    return 0
  } catch (error) {
    io.error(`✗ ${error.message}`)
    return error instanceof UserError ? 2 : 1
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2))
}

export const SCRIPT_FILE = fileURLToPath(import.meta.url)
