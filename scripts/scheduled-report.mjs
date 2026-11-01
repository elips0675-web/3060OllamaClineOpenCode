// Отчёт по проекту для запуска по расписанию: только чтение.
//
//   node scripts/scheduled-report.mjs [--root <путь>] [--out <файл>] [--json] [--limit N]
//
// Что делает: собирает бриф (`project-brief`) и индекс символов (`symbols`),
// добавляет git-состояние и пишет один markdown-отчёт в `tmp/`. Проект, БД и git
// не меняются: отчёт — единственный файл, который создаёт скрипт.
//
// Запуск по расписанию (Windows, пример):
//   schtasks /Create /SC DAILY /TN "3060-report" /TR "node E:\3060OllamaClineOpenCode-main\scripts\scheduled-report.mjs --root D:\project" /ST 09:00
//
// Коды выхода: 0 — отчёт записан, 2 — ошибка аргументов или нет каталога.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectBrief, gitInfo, renderBrief } from './project-brief.mjs'
import { collectSymbols, renderSymbols } from './symbols.mjs'

export const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/u

export function stamp(now = new Date()) {
  const date = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

export function defaultOut(cwd, now = new Date()) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return path.join(cwd, 'tmp', `report-${date}.md`)
}

export function buildReport(root, { limit = 20, now = new Date() } = {}) {
  const at = stamp(now)
  const brief = collectBrief(root, { limit })
  const symbols = collectSymbols(root, { limit: Math.max(limit, 20) })
  const git = brief.git || gitInfo(root)

  const lines = []
  lines.push(`# Отчёт по проекту — ${at}`)
  lines.push('')
  lines.push(`- Проект: ${root}`)
  lines.push(
    `- Ветка: ${git.branch || '—'} | последний коммит: ${git.last || '—'} | ` +
      `изменено файлов: ${Number.isInteger(git.dirty) ? git.dirty : '—'}`,
  )
  lines.push('- Режим: только чтение — проект, БД и git не меняются.')
  lines.push('')
  lines.push('## Бриф')
  lines.push('')
  lines.push(renderBrief(brief, { limit }).trimEnd())
  lines.push('')
  lines.push('## Индекс символов')
  lines.push('')
  lines.push(renderSymbols(symbols).trimEnd())
  lines.push('')
  lines.push('## Чего отчёт не делает')
  lines.push('')
  lines.push('- не правит файлы проекта, не ходит в БД, не делает commit/push;')
  lines.push('- не заменяет прогон гейтов: отчёт — снимок, а не доказательство.')
  lines.push('')

  return { at, root, git, brief, symbols, markdown: `${lines.join('\n')}\n` }
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
  return `Отчёт по проекту для запуска по расписанию: только чтение.

  node scripts/scheduled-report.mjs [--root <путь>] [--out <файл>] [--json] [--limit N]

  --root   корень проекта (по умолчанию текущий каталог)
  --out    куда писать отчёт (по умолчанию tmp/report-ГГГГ-ММ-ДД.md)
  --json   печатать JSON вместо markdown
  --limit  сколько элементов в списках брифа (по умолчанию 20)
  --help   эта справка

Примеры:
  node scripts/scheduled-report.mjs --root "D:\\\\swiftmatch1bdnoutprodpart"
  node scripts/scheduled-report.mjs --root . --out tmp\\\\report.md

Расписание (Windows):
  schtasks /Create /SC DAILY /TN "3060-report" /TR "node <путь>\\\\scripts\\\\scheduled-report.mjs --root <проект>" /ST 09:00
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

  const report = buildReport(args.root, { limit: args.limit })
  const target = path.resolve(args.out || defaultOut(process.cwd()))
  mkdirSync(path.dirname(target), { recursive: true })

  if (args.json) {
    writeFileSync(target, `${JSON.stringify({ ...report, markdown: undefined }, null, 2)}\n`, 'utf8')
  } else {
    writeFileSync(target, report.markdown, 'utf8')
  }
  console.log(`Отчёт записан: ${target}`)
  return 0
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
