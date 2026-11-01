// Механизм «Что доделать.txt» ↔ «Что сделано.txt» (взят из проекта SwiftMatch).
//
// Идея: бэклог — только ОТКРЫТЫЕ вопросы с ID и датой проверки. Закрытый пункт
// УДАЛЯЕТСЯ из бэклога; единственная запись о закрытии — развёрнутый раздел в
// «Что сделано.txt». Строк «## ✅ … — ЗАКРЫТО» здесь быть не должно: это
// устаревший формат, и гейт считает его нарушением.
//
// Формы записей:
//   открытая:  ### BLK-01 — Заголовок
//               Факт: … `file:line`
//               Статус: ⏳ (проверено 30.10.2026)
//   закрытая:  отсутствует в бэклоге (удалена); запись — в журнале.
//
// Использование:
//   node scripts/backlog.mjs check
//   node scripts/backlog.mjs close --id AI-02 [--date 30.10.2026] [--ref "…"]
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
/** Устаревший формат: закрытая строка осталась в бэклоге. */
export const LEGACY_CLOSED_RE = /^##\s+✅/u
export const VERIFIED_RE = /\(проверено\s+\d{2}\.\d{2}\.\d{4}\)/u
const STATUS_RE = /^Статус:\s*(.+)$/mu
const HEADING_RE = /^#{1,6}\s+/u
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
 *   - открытый ID уникален;
 *   - у открытого пункта есть «Статус: ⏳ (проверено ДД.ММ.ГГГГ)»;
 *   - закрытых строк «## ✅ … — ЗАКРЫТО» нет: закрытие живёт только в журнале;
 *   - заголовки не дублируются по базе (до «(»).
 * Возвращает { problems, openIds, legacyClosed }.
 */
export function auditBacklog(text) {
  const lines = text.split(/\r?\n/u)
  const problems = []
  const seen = new Map()
  const openIds = []
  const legacyClosed = []
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

    if (LEGACY_CLOSED_RE.test(line)) {
      legacyClosed.push(i + 1)
      problems.push(
        `строка ${i + 1}: закрытая строка в бэклоге — устаревший формат; ` +
          'закрытый пункт удаляется, запись остаётся только в «Что сделано.txt»',
      )
      continue
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
    }
  }

  return { problems, openIds, legacyClosed }
}

/**
 * Закрытие фиксируется только в журнале: там обязаны быть и ID пункта, и дата.
 * Возвращает список проблем (пустой — запись есть).
 */
export function auditJournalEntry(id, date, doneText) {
  const problems = []
  const text = String(doneText || '')
  if (!text.includes(date)) {
    problems.push(`даты ${date} нет в «Что сделано.txt» — сначала развёрнутая запись`)
  }
  if (!new RegExp(`\\b${id}\\b`, 'u').test(text)) {
    problems.push(`ID «${id}» не найден в «Что сделано.txt» — запись о закрытии без самого пункта`)
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
 * Закрыть открытый пункт: удалить его секцию целиком. Ничего не дописывает:
 * единственная запись о закрытии — в «Что сделано.txt» (проверяются ID и дата).
 * Отказывается, если записи нет, пункт не найден или результат ломает канон.
 */
export function closeItem(text, { id, date = today(), ref = '' }, { doneText } = {}) {
  assertId(id)
  assertDate(date)
  if (doneText === undefined) {
    throw new Error('нужен журнал «Что сделано.txt»: закрытие фиксируется только там')
  }
  const journal = auditJournalEntry(id, date, doneText)
  if (journal.length > 0) throw new Error(journal.join('; '))

  const eol = eolOf(text)
  const lines = text.split(/\r?\n/u)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const match = OPEN_HEADING_RE.exec(lines[i])
    if (match && match[1] === id) {
      start = i
      break
    }
  }
  if (start === -1) throw new Error(`открытый пункт «${id}» не найден`)

  const { end } = sectionBody(lines, start)
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
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
  const busy = text.split(/\r?\n/u).some((row) => {
    if (!/^#{2,3}\s+/u.test(row)) return false
    const match = ITEM_ID_RE.exec(row)
    return Boolean(match) && match[1] === id
  })
  if (busy || problems.some((problem) => problem.includes(`«${id}»`))) {
    throw new Error(`ID «${id}» уже занят`)
  }

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
Закрытый пункт из бэклога удаляется; запись о закрытии — только в журнале,
где обязаны быть и ID, и дата. Строк «## ✅ … — ЗАКРЫТО» в бэклоге быть не должно.
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
      const problems = audit.problems
      console.log(
        `Бэклог: открытых ${audit.openIds.length}, ` +
          `устаревших закрытых строк ${audit.legacyClosed.length}, ` +
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
      console.log(
        `✓ закрыт пункт ${args.values.id}: удалён из бэклога` +
          `${dryRun ? ' (dry-run, файл не изменён)' : ', запись осталась в журнале'}`,
      )
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
