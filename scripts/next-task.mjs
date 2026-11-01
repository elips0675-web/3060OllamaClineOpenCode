import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BACKLOG = path.join(ROOT, 'Что доделать.txt')

const SKIP_SECTION = [/Принятые решения/u, /Не брать/u, /Правила работы/u]
const BLOCKED_SECTION = /Ждёт действий пользователя/u
const QUEUE_SECTION = /Очередь этапов/u
const BLOCKED_ID = [/^(ENV|AND|LEGAL|CI)-\d{2}$/u]
const OWNER_BLOCK = /решение владельца|зависит от владельца|ждёт владельца|ждет владельца|живыми ключами|живой прогон с ключами|после ENV-0\d/iu
const CLOSED_ITEM = /закрыт\s+Stage|закрыт\s+\d{2}\.\d{2}\.\d{4}|\(закрыт|✅\s*\d{2}\.\d{2}\.\d{4}/iu
const ACCEPTED_DECISION = /риск принят|решено оставить|решение зафиксировано|осознанное ограничение/iu
const WATCH_ITEM = /\(watch\b|не делать сейчас/iu
// Явные маркеры из шапки бэклога: «(blocked: причина)» и «(decision)».
// Фразы в теле — запасной путь, они ловят слова в цитатах (AGT-20).
const BLOCKED_MARKER = /\(blocked\b/iu
const DECISION_MARKER = /\(decision\b/iu

// Текст вне кавычек: упоминание «решение владельца» в примере не должно
// делать пункт заблокированным.
function unquoted(text) {
  return String(text)
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/«[^»\n]*»/gu, ' ')
    .replace(/"[^"\n]*"/gu, ' ')
}

const ITEM_ID = /\b([A-Z][A-Z0-9]{1,7}-\d{2})\b/u
const PATH_TOKEN = /`([\p{L}\p{N}_][\p{L}\p{N}_./-]*\.(?:tsx?|jsx?|mjs|cjs|sql|md|json|ya?ml|css|ps1|bat|conf|txt|prisma|toml|ini))(?::(\d+(?:[-,]\d+)*))?`/gu
// Имена без расширения (`models/Modelfile-14b-q4`, `.clinerules`) принимаются
// только если такой файл реально есть в проекте — иначе это не цитата (AGT-21).
const BARE_TOKEN = /`(\.?[\p{L}\p{N}_][\p{L}\p{N}_./-]*)(?::(\d+(?:[-,]\d+)*))?`/gu
const VERIFIED_DATE = /(\d{2}\.\d{2}\.\d{4})/u
const CODE_PATH = /^(src|server|e2e)\//u

export function classifySection(heading) {
  if (SKIP_SECTION.some((re) => re.test(heading))) return { skip: true, priority: 99 }
  if (BLOCKED_SECTION.test(heading)) return { skip: false, blocked: true, priority: 9 }
  if (QUEUE_SECTION.test(heading)) return { skip: false, queue: true, priority: 4 }
  const priorityMatch = heading.match(/\bP([0-3])\b/u)
  if (priorityMatch) return { skip: false, priority: Number(priorityMatch[1]) }
  if (/Дополнительно/u.test(heading)) return { skip: false, priority: 5 }
  return { skip: false, priority: 6 }
}

export function splitSections(text) {
  const lines = String(text).split(/\r?\n/u)
  const out = []
  let current = { heading: '', line: 1, lines: [] }
  lines.forEach((line, index) => {
    if (/^##\s+/u.test(line)) {
      out.push(current)
      current = { heading: line.replace(/^##\s+/u, '').trim(), line: index + 1, lines: [] }
      return
    }
    current.lines.push(line)
  })
  out.push(current)
  return out.filter((section) => section.heading)
}

export function extractFiles(text, inventory = null) {
  const seen = new Map()
  for (const match of String(text).matchAll(PATH_TOKEN)) {
    const file = match[1]
    const lines = match[2] ? match[2] : ''
    const prev = seen.get(file)
    if (!prev || (!prev.lines && lines)) seen.set(file, { path: file, lines })
  }
  if (inventory) {
    for (const match of String(text).matchAll(BARE_TOKEN)) {
      const file = match[1]
      // Точка в начале — это dotfile (`.clinerules`), а не расширение.
      const dot = file.lastIndexOf('.')
      const hasExtension = dot > 0 && /^[A-Za-z0-9]+$/u.test(file.slice(dot + 1))
      if (hasExtension) continue
      const hits = inventory.filter((candidate) => candidate === file || candidate.endsWith(`/${file}`))
      if (hits.length !== 1) continue
      const lines = match[2] ? match[2] : ''
      const prev = seen.get(hits[0])
      if (!prev || (!prev.lines && lines)) seen.set(hits[0], { path: hits[0], lines })
    }
  }
  return [...seen.values()]
}

function effectivePriority(meta, subMeta, sub) {
  if (!sub || !/\bP[0-3]\b/u.test(sub)) return meta.priority
  return Math.min(subMeta.priority, meta.priority)
}

function cleanTitle(line) {
  return String(line)
    .replace(/^[-*]\s+/u, '')
    .replace(/^\d+\.\s+/u, '')
    .replace(/\*\*/gu, '')
    .trim()
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '.git', 'test-results', 'playwright-report', 'coverage', '.auth', '.vite'])

export function walkInventory(root) {
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), nextPrefix)
        continue
      }
      if (entry.isFile()) out.push(nextPrefix)
    }
  }
  walk(root, '')
  return out
}

export function resolveBarePaths(files, inventory) {
  return files.map((file) => {
    if (file.path.includes('/')) return file
    const matches = inventory.filter((candidate) => candidate === file.path || candidate.endsWith(`/${file.path}`))
    if (matches.length === 1) return { path: matches[0], lines: file.lines, resolved: true }
    return file
  })
}

export function statusOf(item) {
  const text = `${item.title}\n${item.body}`
  const plain = unquoted(text)
  if (item.blocked || BLOCKED_MARKER.test(plain) || OWNER_BLOCK.test(plain)) return 'blocked'
  if (CLOSED_ITEM.test(text)) return 'closed'
  if (DECISION_MARKER.test(plain) || ACCEPTED_DECISION.test(plain)) return 'decision'
  if (WATCH_ITEM.test(text)) return 'watch'
  if (item.evidence === 'none') return 'no-evidence'
  return 'ready'
}

function itemFrom(id, title, body, meta) {
  const raw = `${title}\n${body}`
  const files = extractFiles(raw, meta.inventory || null)
  const withLines = files.filter((file) => Boolean(file.lines))
  const evidence = withLines.length ? 'file:line' : files.length ? 'file' : 'none'
  const dateMatch = raw.match(VERIFIED_DATE)
  const item = {
    id,
    title: cleanTitle(title),
    body: String(body).trim(),
    section: meta.section,
    priority: meta.priority,
    order: meta.order,
    line: meta.line,
    queue: Boolean(meta.queue),
    blocked: Boolean(meta.blocked) || BLOCKED_ID.some((re) => re.test(id)),
    files,
    evidence,
    verified: dateMatch ? dateMatch[1] : '',
  }
  item.status = statusOf(item)
  return item
}

function dedupe(items) {
  const byId = new Map()
  const score = { 'file:line': 3, file: 2, none: 1 }
  for (const item of items) {
    const prev = byId.get(item.id)
    if (!prev) {
      byId.set(item.id, item)
      continue
    }
    const better = score[item.evidence] > score[prev.evidence] || (score[item.evidence] === score[prev.evidence] && item.line < prev.line)
    if (better) byId.set(item.id, item)
  }
  return [...byId.values()]
}

export function parseBacklog(text, inventory = null) {
  const items = []
  for (const section of splitSections(text)) {
    const meta = classifySection(section.heading)
    if (meta.skip) continue
    let sub = ''
    let subMeta = meta
    let order = 0
    for (let index = 0; index < section.lines.length; index += 1) {
      const line = section.lines[index]
      const lineNo = section.line + index + 1
      const headingMatch = line.match(/^#{3,4}\s+(.+)$/u)
      if (headingMatch) {
        sub = headingMatch[1].trim()
        subMeta = classifySection(sub)
        const idMatch = sub.match(ITEM_ID)
        if (!idMatch) continue
        const bodyLines = []
        for (let next = index + 1; next < section.lines.length; next += 1) {
          if (/^#{2,4}\s+/u.test(section.lines[next])) break
          bodyLines.push(section.lines[next])
        }
        order += 1
        items.push(itemFrom(idMatch[1], sub, bodyLines.join('\n'), {
          section: section.heading,
          priority: effectivePriority(meta, subMeta, sub),
          order,
          line: lineNo,
          queue: Boolean(meta.queue),
          inventory,
          blocked: Boolean(meta.blocked) || Boolean(subMeta.blocked),
        }))
        continue
      }

      const bulletMatch = line.match(/^[-*]\s+\*\*([A-Z][A-Z0-9]{1,7}-\d{2})\b/u)
      const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/u)
      if (bulletMatch) {        const bodyLines = [line]
        for (let next = index + 1; next < section.lines.length; next += 1) {
          const candidate = section.lines[next]
          if (/^\s+\S/u.test(candidate)) {
            bodyLines.push(candidate)
            continue
          }
          break
        }
        order += 1
        items.push(itemFrom(bulletMatch[1], line, bodyLines.join('\n'), {
          section: sub || section.heading,
          priority: effectivePriority(meta, subMeta, sub),
          order,
          line: lineNo,
          queue: Boolean(meta.queue),
          inventory,
          blocked: Boolean(meta.blocked) || Boolean(subMeta.blocked),
        }))
        continue
      }

      const tableMatch = line.match(/^\|\s*([A-Z][A-Z0-9]{1,7}-\d{2})\s*\|(.*)$/u)
      if (tableMatch) {
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
        const title = cleanTitle(cells[1] || '')
        const body = cells.slice(1).join(' | ')
        order += 1
        items.push(itemFrom(tableMatch[1], title, body, {
          section: sub || section.heading,
          priority: effectivePriority(meta, subMeta, sub),
          order,
          line: lineNo,
          queue: Boolean(meta.queue),
          inventory,
          blocked: Boolean(meta.blocked) || Boolean(subMeta.blocked),
        }))
        continue
      }

      if (numberedMatch && meta.queue) {
        const text = numberedMatch[2]
        const idMatch = text.match(ITEM_ID)
        if (!idMatch) continue
        const bodyLines = [text]
        for (let next = index + 1; next < section.lines.length; next += 1) {
          const candidate = section.lines[next]
          if (/^\s+\S/u.test(candidate)) {
            bodyLines.push(candidate)
            continue
          }
          break
        }
        items.push(itemFrom(idMatch[1], text, bodyLines.join('\n'), {
          section: section.heading,
          priority: meta.priority,
          order: Number(numberedMatch[1]),
          line: lineNo,
          queue: true,
          inventory,
          blocked: Boolean(meta.blocked),
        }))
      }
    }
  }
  return dedupe(items)
}

export function projectCommands(root = ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return {
      root,
      scripts: pkg.scripts || {},
      deps: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) },
    }
  } catch {
    return { root, scripts: {}, deps: {} }
  }
}

export function gatesFor(item, project = null) {
  const files = item.files.map((file) => file.path)
  const hasFront = files.some((file) => /^(src|e2e)\//u.test(file))
  const hasServer = files.some((file) => /^server\//u.test(file))
  const hasSql = files.some((file) => /^(database\/|.*\.sql$)/u.test(file))
  const hasDocs = files.some((file) => /^(docs\/|README\.md|AGENTS\.md|project-context\.md)/u.test(file))
  const hasScript = (name) => !project || Boolean(project.scripts[name])
  const hasDep = (name) => !project || Boolean(project.deps[name])
  const hasPack = !project || fs.existsSync(path.join(project.root || ROOT, 'test/build-pack.mjs'))
  const gates = []
  const push = (gate) => {
    if (!gates.includes(gate)) gates.push(gate)
  }
  if (hasFront) {
    if (hasDep('eslint')) push('npx.cmd eslint <изменённые файлы>')
    if (hasScript('typecheck')) push('npm.cmd run typecheck')
    if (hasScript('test')) push('npm.cmd test -- <тест затронутого файла>')
  }
  if (hasServer && hasScript('check:n-plus-one')) push('npm.cmd run check:n-plus-one')
  if (hasSql && hasScript('check:enum-constraints')) push('npm.cmd run check:enum-constraints')
  if (hasDocs && hasScript('check:docs')) push('npm.cmd run check:docs')
  if (!hasFront && hasScript('test')) push('npm.cmd test')
  if (hasPack) push('node test/build-pack.mjs --check')
  if (hasScript('check:backlog')) push('npm.cmd run check:backlog')
  if (hasScript('retent:check')) push('npm.cmd run retent:check')
  return gates.slice(0, 6)
}

const EVIDENCE_SCORE = { 'file:line': 2, file: 1, none: 0 }

export function pickTask(items, options = {}) {
  const pool = items
    .filter((item) => item.status !== 'closed' && item.status !== 'decision')
    .filter((item) => (options.includeBlocked ? true : item.status !== 'blocked' && item.status !== 'watch'))
    .filter((item) => (options.queueOnly ? item.queue : true))
    .filter((item) => (options.allowNoEvidence ? true : item.status !== 'no-evidence'))
    .filter((item) => (options.local ? item.status === 'ready' && routeFor(item).target === 'local' : true))
    .filter((item) => (options.id ? item.id.toUpperCase() === String(options.id).toUpperCase() : true))
  const sorted = [...pool].sort((a, b) => {
    const knownA = a.status === 'ready' ? 0 : 1
    const knownB = b.status === 'ready' ? 0 : 1
    if (knownA !== knownB) return knownA - knownB
    if (a.priority !== b.priority) return a.priority - b.priority
    const evidenceDiff = EVIDENCE_SCORE[b.evidence] - EVIDENCE_SCORE[a.evidence]
    if (evidenceDiff !== 0) return evidenceDiff
    if (a.order !== b.order) return a.order - b.order
    if (a.files.length !== b.files.length) return a.files.length - b.files.length
    if (a.body.length !== b.body.length) return a.body.length - b.body.length
    return a.id.localeCompare(b.id)
  })
  return sorted.length ? sorted[0] : null
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/u).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    if (!line.length) {
      line = word
      continue
    }
    if ((line.length + 1 + word.length) > width) {
      lines.push(line)
      line = word
      continue
    }
    line = `${line} ${word}`
  }
  if (line.length) lines.push(line)
  return lines.map((value) => `${indent}${value}`).join('\n')
}

function sortFilesForSlice(files) {
  return [...files].sort((a, b) => {
    const ca = CODE_PATH.test(a.path) ? 0 : 1
    const cb = CODE_PATH.test(b.path) ? 0 : 1
    return ca - cb
  })
}

const STATUS_TEXT = {
  ready: 'готова',
  blocked: 'заблокирована владельцем',
  watch: 'отложена (watch: не делать сейчас)',
  closed: 'уже закрыта',
  decision: 'принятое решение, не задача',
  'no-evidence': 'нет цитаты кода (правило проекта)',
}

function buildPrompt(item, slice, project = null) {
  const root = (project && project.root) || ROOT
  const lines = [
    `Работаем с проектом ${path.basename(root)} в ${root}.`,
    `Задача ${item.id} из файла "Что доделать.txt" (строка ${item.line}).`,
    '',
    'Текст задачи:',
    item.title.replace(/\s+/gu, ' ').trim(),
    '',
  ]
  if (slice) {
    lines.push(`Работай ТОЛЬКО с этим файлом: ${slice}`)
    lines.push('Другие файлы не открывай и не меняй без моего разрешения.')
    lines.push('')
  }
  lines.push('Требования:')
  lines.push('- никакого any, as any и @ts-ignore;')
  lines.push('- минимальная правка, стиль окружающего кода;')
  lines.push('- комментарии в код не добавлять;')
  lines.push('- сначала покажи план из 3-5 пунктов, правки вноси после моего "делай".')
  lines.push('')
  lines.push('Проверки после правки (все должны быть exit 0):')
  gatesFor(item, project).forEach((gate) => lines.push(`- ${gate}`))
  lines.push('')
  lines.push('В отчёте: список изменённых файлов, вывод проверок, что осталось непонятным.')
  return lines.join('\n')
}

const RISK_DOMAINS = [
  {
    code: 'money',
    label: 'платежи и деньги',
    pattern: /stripe|плат[её]ж|подписк|premium|оплат|возврат средств|refund|выплат|комисси|invoice|billing/iu,
  },
  {
    code: 'access',
    label: 'доступ и секреты',
    pattern: /jwt|oauth|\bauth\b|csrf|adminauth|секрет|\bтокен|уязвим|\bidor\b|rate.?limit|парол|sanitiz|xss|sql-?инъекц/iu,
  },
  {
    code: 'schema',
    label: 'схема БД и миграции',
    pattern: /миграц|mysql_schema|alter table|create table|\benum\b|\bcheck\s*\(|schema|схем[аыуе]|индекс/iu,
  },
  {
    code: 'infra',
    label: 'деплой и инфраструктура',
    pattern: /docker|compose\.ya?ml|deploy\.ya?ml|nginx|деплой|kubernetes/iu,
  },
]

export function riskyDomain(item) {
  const haystack = [item.title, item.body, item.section || '', ...item.files.map((file) => file.path)].join('\n')
  return RISK_DOMAINS.find((domain) => domain.pattern.test(haystack)) || null
}

export function routeFor(item) {
  const count = item.files.length
  if (item.evidence !== 'file:line') {
    return {
      target: 'cloud',
      reason: 'no-citation',
      text: 'облако: нет цитаты file:line, по правилу проекта такой пункт не берут',
    }
  }
  const risk = riskyDomain(item)
  if (risk) {
    return {
      target: 'cloud',
      reason: risk.code,
      text: `облако (/next-cloud): ${risk.label} — 14B тут ошибается молча; скрипт смотрит ключевые слова, сложность он не оценивает`,
    }
  }
  if (count <= 1) {
    return { target: 'local', reason: 'single-file', text: '3060: один файл, один подход' }
  }
  if (count > 6) {
    return {
      target: 'cloud',
      reason: 'too-many-files',
      text: `облако: ${count} файлов — локальный бюджет 1–6; сузить до одного файла`,
    }
  }
  return {
    target: 'local',
    reason: 'stepwise',
    text: `3060 по одному файлу, подходов: ${count} (если нужен обзор всех сразу — /next-cloud)`,
  }
}

export function buildCard(item, project = null) {
  const ordered = sortFilesForSlice(item.files)
  const slice = ordered.length ? ordered[0].path : ''
  const out = []
  out.push('='.repeat(80))
  out.push(`ЗАДАЧА: ${item.id}`)
  out.push(`Раздел: ${item.section}`)
  out.push(`Источник: Что доделать.txt:${item.line}`)
  out.push(`Статус: ${STATUS_TEXT[item.status] || item.status}`)
  out.push(`Проверено: ${item.verified || 'дата не указана'}`)
  out.push(`Цитата кода: ${item.evidence === 'file:line' ? 'да (file:line)' : item.evidence === 'file' ? 'только путь, без строки' : 'нет'}`)
  out.push(`Файлов в пункте: ${item.files.length}`)
  out.push(`Маршрут: ${routeFor(item).text}`)
  out.push('='.repeat(80))
  out.push('')
  out.push('СУТЬ')
  out.push(wrap(item.title, 78, '  '))
  out.push('')
  if (item.body && item.body !== item.title) {
    out.push('ПУНКТ ЦЕЛИКОМ')
    out.push(wrap(cleanTitle(item.body), 78, '  '))
    out.push('')
  }
  if (ordered.length) {
    out.push('ФАЙЛЫ')
    ordered.forEach((file) => out.push(`  - ${file.path}${file.lines ? `:${file.lines}` : ''}`))
    out.push('')
  }
  if (slice) {
    out.push('СРЕЗ ДЛЯ ОДНОГО ПОДХОДА')
    out.push(`  ${slice}`)
    if (ordered.length > 1) out.push('  (остальные файлы — следующими подходами: контекст 12288 не держит больше)')
    out.push('')
  }
  out.push('ГЕЙТЫ (все exit 0)')
  gatesFor(item, project).forEach((gate, index) => out.push(`  ${index + 1}. ${gate}`))
  out.push('')
  out.push('ПРОМПТ ДЛЯ АГЕНТА (скопировать целиком)')
  buildPrompt(item, slice, project).split('\n').forEach((line) => out.push(`  ${line}`))
  out.push('')
  out.push('='.repeat(80))
  return out.join('\n')
}

export function listRows(items) {
  return items.map((item) => ({
    id: item.id,
    priority: item.priority,
    line: item.line,
    status: item.status,
    evidence: item.evidence,
    files: item.files.length,
    queue: item.queue,
    title: item.title.replace(/\s+/gu, ' ').slice(0, 70),
  }))
}

function printHelp() {
  process.stdout.write([
    'Автовыбор задачи из «Что доделать.txt».',
    '',
    'Использование:',
    '  node scripts/next-task.mjs                      карточка следующей задачи',
    '  node scripts/next-task.mjs --local              только то, что скрипт отправляет на 3060',
    '  node scripts/next-task.mjs --route              только решение «локально / облако»',
    '  node scripts/next-task.mjs --list                таблица всех пунктов со статусами',
    '  node scripts/next-task.mjs --json                карточка в JSON',
    '  node scripts/next-task.mjs --id QA-01            конкретный пункт',
    '  node scripts/next-task.mjs --queue-only          только раздел «Очередь этапов»',
    '  node scripts/next-task.mjs --include-blocked     вместе с blocked и watch-пунктами',
    '  node scripts/next-task.mjs --allow-no-evidence   и пункты без цитаты кода',
    '  node scripts/next-task.mjs --out tmp/next-task.txt  сохранить карточку в файл',
    '  node scripts/next-task.mjs --backlog <путь>      другой файл бэклога',
    '',
    'Статусы: ready (брать), blocked (владелец/ключи/маркер), watch (не делать сейчас),',
    '         closed (закрыт), decision (принятое решение/маркер), no-evidence (нет file:line).',
    'По умолчанию скрыты blocked, watch, decision и no-evidence.',
    'Exit: 0 — задача найдена, 1 — брать нечего, 2 — ошибка аргументов.',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const options = { list: false, json: false, queueOnly: false, includeBlocked: false, allowNoEvidence: false, local: false, route: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      return argv[index]
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--list') options.list = true
    else if (arg === '--json') options.json = true
    else if (arg === '--queue-only') options.queueOnly = true
    else if (arg === '--include-blocked') options.includeBlocked = true
    else if (arg === '--allow-no-evidence') options.allowNoEvidence = true
    else if (arg === '--local') options.local = true
    else if (arg === '--route') options.route = true
    else if (arg === '--id') options.id = next()
    else if (arg === '--out') options.out = next()
    else if (arg === '--backlog') options.backlog = next()
    else {
      process.stderr.write(`Неизвестный аргумент: ${arg}\n`)
      return { error: true }
    }
  }
  return options
}

export function readBacklogFile(read, filePath) {
  try {
    return { ok: true, text: read(filePath) }
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    return { ok: false, error, locked: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.error) {
    printHelp()
    process.exit(2)
  }
  if (options.help) {
    printHelp()
    process.exit(0)
  }
  const backlogPath = options.backlog ? path.resolve(ROOT, options.backlog) : DEFAULT_BACKLOG
  if (!fs.existsSync(backlogPath)) {
    process.stderr.write(`Бэклог не найден: ${backlogPath}\n`)
    process.exit(2)
  }
  const backlogRead = readBacklogFile((file) => fs.readFileSync(file, 'utf8'), backlogPath)
  if (!backlogRead.ok) {
    if (backlogRead.locked) {
      process.stderr.write(`Файл бэклога заблокирован другой программой: ${backlogPath}\n`)
      process.stderr.write('Закройте его (Excel, Word, редактор, синхронизация) и повторите.\n')
      process.exit(2)
    }
    throw backlogRead.error
  }
  const inventory = walkInventory(ROOT)
  const parsed = parseBacklog(backlogRead.text, inventory)
  const items = parsed.map((item) => ({ ...item, files: resolveBarePaths(item.files, inventory) }))
  if (!items.length) {
    process.stderr.write('В бэклоге не найдено ни одного пункта с ID.\n')
    process.exit(1)
  }

  if (options.list) {
    const rows = listRows(items)
    process.stdout.write(['ID', 'P', 'стр', 'статус', 'цитата', 'файлов', 'очередь', 'название'].join('\t') + '\n')
    rows.forEach((row) => {
      process.stdout.write([
        row.id,
        row.priority,
        row.line,
        row.status,
        row.evidence,
        row.files,
        row.queue ? 'да' : '-',
        row.title,
      ].join('\t') + '\n')
    })
    process.exit(0)
  }

  const task = pickTask(items, options)
  if (!task) {
    const named = options.id ? items.find((item) => item.id.toUpperCase() === String(options.id).toUpperCase()) : null
    if (named) {
      process.stderr.write(`Пункт ${named.id} брать нельзя: ${STATUS_TEXT[named.status] || named.status} (Что доделать.txt:${named.line}).\n`)
    } else {
      process.stderr.write('Брать нечего: все подходящие пункты закрыты, заблокированы владельцем или без цитаты кода.\n')
    }
    process.stderr.write('Посмотреть всё: --list; включить блокеры: --include-blocked; без цитаты: --allow-no-evidence\n')
    process.exit(1)
  }

  if (options.route) {
    const route = routeFor(task)
    process.stdout.write(`${route.target}\t${route.text}\n`)
    process.exit(0)
  }

  const project = projectCommands()
  const payload = options.json ? JSON.stringify({ task, route: routeFor(task), gates: gatesFor(task, project), card: buildCard(task, project) }, null, 2) : buildCard(task, project)
  if (options.out) {
    const outPath = path.resolve(ROOT, options.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${payload}\n`, 'utf8')
    process.stderr.write(`Карточка сохранена: ${outPath}\n`)
  }
  process.stdout.write(`${payload}\n`)
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
