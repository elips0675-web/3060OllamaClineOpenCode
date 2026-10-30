// Механизм «Что доделать.txt» ↔ «Что сделано.txt» (взят из проекта SwiftMatch).
//
// Идея: бэклог — только ОТКРЫТЫЕ вопросы с ID и датой проверки. Закрытый пункт
// уходит в журнал «Что сделано.txt» развёрнутой записью, а в бэклоге остаётся
// одна компактная строка ✅ со ссылкой. Тело под закрытой строкой — «надгробие»,
// это FAIL. Дата «ЗАКРЫТО ДД.ММ.ГГГГ» обязана встречаться в журнале.
//
// Формы записей:
//   открытая:  ### BLK-01 — Заголовок
//               Факт: … `file:line`
//               Статус: ⏳ (проверено 30.10.2026)
//   закрытая:  ## ✅ BLK-01 — Заголовок (см. «Что сделано.txt»: ref) — ЗАКРЫТО 30.10.2026
//               (тела быть не должно)
//
// Использование:
//   node scripts/backlog.mjs check
//   node scripts/backlog.mjs close --id AI-02 --ref "раздел …" [--date 30.10.2026]
//   node scripts/backlog.mjs open --id DOC-02 --title "…" [--body "…"] [--date 30.10.2026]
//
// Коды выхода: 0 — готово, 1 — нарушение канона/записи, 2 — ошибка аргументов.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KIT_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_BACKLOG = path.join(KIT_ROOT, 'Что доделать.txt')
export const DEFAULT_DONE = path.join(KIT_ROOT, 'Что сделано.txt')

const ID_SRC = '[A-Z][A-Z0-9]{1,7}-\\d{2}'
export const ITEM_ID_RE = new RegExp(`\\b(${ID_SRC})\\b`, 'u')
export const OPEN_HEADING_RE = new RegExp(`^###\\s+(${ID_SRC})\\s*[—:-]\\s*(.+)$`, 'u')
export const CLOSED_HEADING_RE = new RegExp(
  `^##\\s+✅\\s+(${ID_SRC})\\b(.*?)—\\s*ЗАКРЫТО\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\s*$`,
  'u',
)
export const VERIFIED_RE = /\(проверено\s+\d{2}\.\d{2}\.\d{4}\)/u
const STATUS_RE = /^Статус:\s*(.+)$/mu
const HEADING_RE = /^#{1,6}\s+/u
const HR_RE = /^---+\s*$/u
const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/u

export const today = (now = new Date()) =>
  `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')

/** Тело секции: строки до следующего заголовка любого уровня. */
function sectionBody(lines, start) {
  let end = start + 1
  while (end < lines.length && !HEADING_RE.test(lines[end])) end += 1
  return { end, body: lines.slice(start + 1, end) }
}

/**
 * Структурный аудит бэклога:
 *   - ID уникален и в открытых, и в закрытых;
 *   - у открытого пункта есть «Статус: ⏳ (проверено ДД.ММ.ГГГГ)»;
 *   - закрытая строка заканчивается «— ЗАКРЫТО ДД.ММ.ГГГГ» и не имеет тела;
 *   - заголовки не дублируются по базе (до «(»).
 * Возвращает { problems, openIds, closedDates }.
 */
export function auditBacklog(text) {
  const lines = text.split(/\r?\n/u)
  const problems = []
  const seen = new Map()
  const openIds = []
  const closedDates = []
  const headingBase = new Map()

  const remember = (id, line) => {
    if (seen.has(id)) {
      problems.push(`строка ${line + 1}: ID «${id}» уже встречался в строке ${seen.get(id)}`)
      return false
    }
    seen.set(id, line + 1)
    return true
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const heading = /^#{1,6}\s+(.*)$/u.exec(line)
    if (heading) {
      const base = heading[1]
        .replace(new RegExp(`^${ID_SRC}\\s*[—:-]\\s*`, 'u'), '')
        .replace(/\s*\(.*$/u, '')
        .trim()
      if (base) {
        if (headingBase.has(base)) {
          problems.push(
            `заголовок «${base}» дублируется: строки ${headingBase.get(base)} и ${i + 1}`,
          )
        } else {
          headingBase.set(base, i + 1)
        }
      }
    }

    const open = OPEN_HEADING_RE.exec(line)
    if (open) {
      const [, id, title] = open
      remember(id, i)
      openIds.push(id)
      if (!title.trim()) problems.push(`строка ${i + 1} (${id}): пустой заголовок`)
      const { body } = sectionBody(lines, i)
      const status = body.map((row) => STATUS_RE.exec(row)).find(Boolean)
      if (!status) {
        problems.push(`строка ${i + 1} (${id}): нет строки «Статус: …»`)
      } else if (!status[1].startsWith('⏳')) {
        problems.push(`строка ${i + 1} (${id}): статус открытого пункта должен начинаться с ⏳`)
      } else if (!VERIFIED_RE.test(status[1])) {
        problems.push(`строка ${i + 1} (${id}): нет даты «(проверено ДД.ММ.ГГГГ)»`)
      }
      continue
    }

    const closed = CLOSED_HEADING_RE.exec(line)
    if (closed) {
      const [, id, , date] = closed
      remember(id, i)
      closedDates.push(date)
      const { body } = sectionBody(lines, i)
      for (let j = 0; j < body.length; j += 1) {
        const textRow = body[j].trim()
        if (textRow === '' || HR_RE.test(textRow)) continue
        problems.push(
          `строка ${i + j + 2} (${id}): тело под закрытой записью — «надгробие»; детали переносить в «Что сделано.txt»`,
        )
      }
    }
  }

  return { problems, openIds, closedDates }
}

/** Каждая дата «ЗАКРЫТО ДД.ММ.ГГГГ» обязана встречаться в журнале. */
export function auditChronicle(closedDates, doneText) {
  const problems = []
  for (const date of new Set(closedDates)) {
    if (!doneText.includes(date)) {
      problems.push(
        `дата «ЗАКРЫТО ${date}» отсутствует в «Что сделано.txt» — закрытие без развёрнутой записи`,
      )
    }
  }
  return problems
}

function assertId(id) {
  if (!new RegExp(`^${ID_SRC}$`, 'u').test(String(id || ''))) {
    throw new Error(`ID «${id || ''}» не формата PREFIX-NN (например BLK-01)`)
  }
}

function assertDate(date) {
  if (!DATE_RE.test(String(date || ''))) {
    throw new Error(`дата «${date || ''}» не формата ДД.ММ.ГГГГ`)
  }
}

/**
 * Закрыть открытый пункт: убрать секцию, вставить компактную строку ✅ после
 * первого `---`. Отказывается, если даты нет в журнале (сначала запись в
 * «Что сделано.txt»), если пункт не найден или результат ломает канон.
 */
export function closeItem(text, { id, date = today(), ref = '' }, { doneText } = {}) {
  assertId(id)
  assertDate(date)
  if (doneText !== undefined && !doneText.includes(date)) {
    throw new Error(`даты ${date} нет в «Что сделано.txt»: сначала развёрнутая запись, потом закрытие`)
  }

  const eol = eolOf(text)
  const lines = text.split(/\r?\n/u)
  let start = -1
  let title = ''
  for (let i = 0; i < lines.length; i += 1) {
    const match = OPEN_HEADING_RE.exec(lines[i])
    if (match && match[1] === id) {
      start = i
      title = match[2].trim()
      break
    }
  }
  if (start === -1) throw new Error(`открытый пункт «${id}» не найден`)

  const { end } = sectionBody(lines, start)
  const refPart = ref ? ` (см. «Что сделано.txt»: ${ref})` : ' (см. «Что сделано.txt»)'
  const compact = `## ✅ ${id} — ${title}${refPart} — ЗАКРЫТО ${date}`

  const rest = [...lines.slice(0, start), ...lines.slice(end)]
  let hr = rest.findIndex((row) => HR_RE.test(row))
  if (hr === -1) rest.unshift(compact, '')
  else rest.splice(hr + 1, 0, '', compact)

  const next = rest.join(eol)
  const { problems } = auditBacklog(next)
  if (problems.length > 0) {
    throw new Error(`результат ломает канон: ${problems.join('; ')}`)
  }
  return next
}

/** Добавить открытый пункт в конец бэклога. */
export function openItem(text, { id, title, body = '', date = today() }, { doneText } = {}) {
  assertId(id)
  assertDate(date)
  if (!String(title || '').trim()) throw new Error('--title обязателен')

  const { problems } = auditBacklog(text)
  const busy =
    problems.some((problem) => problem.includes(`«${id}»`)) ||
    text.split(/\r?\n/u).some((row) => {
      const open = OPEN_HEADING_RE.exec(row)
      const closed = CLOSED_HEADING_RE.exec(row)
      return (open && open[1] === id) || (closed && closed[1] === id)
    })
  if (busy) throw new Error(`ID «${id}» уже занят`)

  const eol = eolOf(text)
  const trimmed = String(body || '').trim()
  const content = /^Статус:/mu.test(trimmed)
    ? trimmed
    : `${trimmed ? `${trimmed}\n\n` : ''}Статус: ⏳ (проверено ${date})`

  const lines = text.split(/\r?\n/u)
  const rules = lines.findIndex((row) => /^##\s+Правила работы/u.test(row))
  let at = rules === -1 ? lines.length : rules
  while (at > 0 && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, '', `### ${id} — ${String(title).trim()}`, '', ...content.split('\n'), '')

  const next = lines.join(eol)
  const audit = auditBacklog(next)
  if (audit.problems.length > 0) {
    throw new Error(`результат ломает канон: ${audit.problems.join('; ')}`)
  }
  if (doneText !== undefined) {
    const chronicle = auditChronicle(audit.closedDates, doneText)
    if (chronicle.length > 0) throw new Error(chronicle.join('; '))
  }
  return next
}

export function parseArgs(argv) {
  const mode = argv[0]
  const out = { mode, flags: new Set(), values: {} }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`неизвестный аргумент: ${arg}`)
    const key = arg.slice(2)
    if (key === 'dry-run') {
      out.flags.add(key)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} требует значение`)
    out.values[key] = value
    i += 1
  }
  return out
}

function usage() {
  return `Механизм «Что доделать.txt» ↔ «Что сделано.txt».

  node scripts/backlog.mjs check [--file <бэклог>] [--done <журнал>]
  node scripts/backlog.mjs close --id <PREFIX-NN> [--ref <ссылка>] [--date ДД.ММ.ГГГГ] [--dry-run]
  node scripts/backlog.mjs open  --id <PREFIX-NN> --title "<заголовок>" [--body "<текст>"] [--date ДД.ММ.ГГГГ] [--dry-run]

Открытый пункт: ### ID — заголовок + «Статус: ⏳ (проверено ДД.ММ.ГГГГ)».
Закрытый: одна строка «## ✅ ID — … — ЗАКРЫТО ДД.ММ.ГГГГ», без тела.
`
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }

  if (!args.mode || args.mode === '--help' || args.mode === '-h') {
    console.log(usage())
    return args.mode ? 0 : 2
  }
  if (!['check', 'close', 'open'].includes(args.mode)) {
    console.error(`✗ неизвестная команда: ${args.mode}`)
    console.error(usage())
    return 2
  }

  const file = path.resolve(args.values.file || DEFAULT_BACKLOG)
  const doneFile = path.resolve(args.values.done || DEFAULT_DONE)
  if (!existsSync(file)) {
    console.error(`✗ нет файла бэклога: ${file}`)
    return 2
  }
  const text = readFileSync(file, 'utf8')
  const doneText = existsSync(doneFile) ? readFileSync(doneFile, 'utf8') : ''
  const dryRun = args.flags.has('dry-run')

  try {
    if (args.mode === 'check') {
      const audit = auditBacklog(text)
      const problems = [...audit.problems, ...auditChronicle(audit.closedDates, doneText)]
      console.log(
        `Бэклог: открытых ${audit.openIds.length}, закрытых ${audit.closedDates.length}, ` +
          `строк ${text.split(/\r?\n/u).length}`,
      )
      if (problems.length > 0) {
        for (const problem of problems) console.error(`✗ ${problem}`)
        console.error(`\nИтог: FAIL (${problems.length}).`)
        return 1
      }
      console.log('Итог: канон бэклога соблюдён ✓')
      return 0
    }

    if (args.mode === 'close') {
      const next = closeItem(
        text,
        { id: args.values.id, date: args.values.date || today(), ref: args.values.ref || '' },
        { doneText },
      )
      if (!dryRun) writeFileSync(file, next, 'utf8')
      console.log(`✓ закрыт пункт ${args.values.id}${dryRun ? ' (dry-run, файл не изменён)' : ''}`)
      return 0
    }

    const next = openItem(
      text,
      {
        id: args.values.id,
        title: args.values.title,
        body: args.values.body || '',
        date: args.values.date || today(),
      },
      { doneText },
    )
    if (!dryRun) writeFileSync(file, next, 'utf8')
    console.log(`✓ открыт пункт ${args.values.id}${dryRun ? ' (dry-run, файл не изменён)' : ''}`)
    return 0
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 1
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}

export const SCRIPT_FILE = fileURLToPath(import.meta.url)
