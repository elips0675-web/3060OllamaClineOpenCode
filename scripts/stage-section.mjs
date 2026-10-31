/**
 * «Заготовка записи в журнал» — рутина блока.
 *
 * Печатает в stdout каркас записи для «Что сделано.txt» в формате комплекта:
 * разделитель, заголовок «ДД.ММ.ГГГГ. ID (этап N): …», пять полей
 * (Задача / Что сделано / Ломка / Тесты / Проверки), поле «Гейты» и факт-блок
 * `git diff --stat HEAD`. Ничего не редактирует и в файл не пишет: проза блока
 * пишется руками, заготовка убирает только механику (дата, diff, структура).
 *
 * Перенесено из SwiftMatch (`scripts/stage-section.mjs`): там формат
 * `## Заголовок (дата)` с markdown-полями, здесь — журнальный, потому что
 * «Что сделано.txt» комплекта ведётся разделителями `====` и маркерами
 * `- Поле:`. Чек-лист шапки бэклога заменён на реальные команды комплекта:
 * `test-counter-audit` и `check-doc-mirrors` в нём отсутствуют.
 *
 * Usage: node scripts/stage-section.mjs "<ID (этап N): Заголовок>" [ДД.ММ.ГГГГ]
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PLACEHOLDER = 'РЕДАКТИРУЙ:'

export const FIELDS = ['Задача', 'Что сделано', 'Ломка', 'Тесты', 'Проверки']

export function hasRepo(root = ROOT) {
  try {
    const stat = fs.statSync(path.join(root, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

export function todayRu(now = new Date()) {
  const p = (v) => String(v).padStart(2, '0')
  return `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`
}

export function diffSummary(stat) {
  const text = String(stat || '').trim()
  if (!text) return 'изменения уже закоммичены — `git diff --stat HEAD` пуст'
  const tail = text.split(/\r?\n/).pop().trim()
  const m = text.match(/^\s*(\d+)\s+files? changed/im)
  return m ? `изменено файлов: ${m[1]} (${tail})` : tail
}

export function buildSection({ title, date, diffStat, untracked = [], repo = true }) {
  const summary = diffSummary(diffStat)
  const newFiles = untracked.length
    ? `; новых (untracked): ${untracked.length} — ${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? '…' : ''}`
    : ''
  const bar = '='.repeat(80)
  const lines = []
  lines.push(bar)
  lines.push(`${date}. ${title}`)
  lines.push(bar)
  lines.push('')
  for (const field of FIELDS) lines.push(`- ${field}: ${PLACEHOLDER}`)
  lines.push(`- Гейты: ${PLACEHOLDER} вывод каждой проверки и её код возврата.`)
  lines.push('')
  if (!repo) {
    lines.push('git недоступен: в каталоге нет `.git` (рабочая копия) — факт-блок заполнить в клоне.')
    return lines.join('\n')
  }
  lines.push(`Изменения на ${date}: ${summary}${newFiles}.`)
  lines.push('')
  lines.push('```')
  lines.push(`git diff --stat HEAD на ${date}:`)
  lines.push(String(diffStat || '').trim() || 'рабочее дерево чистое (всё уже закоммичено)')
  lines.push('```')
  return lines.join('\n')
}

export function buildHeaderChecklist({ date, id = 'ID' }) {
  const lines = []
  lines.push(`## Чек-лист закрытия блока (${date})`)
  lines.push('')
  lines.push(`1. Запись в «Что сделано.txt» — сверху, дата ${date}: ${id} уже в заголовке.`)
  lines.push(
    `2. Закрыть пункт: \`node scripts/backlog.mjs close --id ${id} --ref "раздел «${id}»"\` — только после даты в журнале, только скриптом.`
  )
  lines.push('3. Канон бэклога: `node scripts/backlog.mjs check` — exit 0.')
  lines.push('4. Снимки пакета: `node test/build-pack.mjs`, затем `node test/build-pack.mjs --check`.')
  lines.push('5. Клон: скопировать изменённые файлы и снимки `test/` в `D:\\ИИ агент\\3060 16 gb`, сверить sha256.')
  lines.push('6. Коммит поимённо + push, затем в клоне `npm.cmd run retent:check` — exit 0.')
  return lines.join('\n')
}

export function collectGit(root = ROOT) {
  if (!hasRepo(root)) return { diffStat: '', untracked: [], repo: false }
  let diffStat = ''
  let untracked = []
  try {
    diffStat = execFileSync('git', ['diff', '--stat', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    diffStat = ''
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    untracked = String(status || '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3))
  } catch {
    untracked = []
  }
  return { diffStat, untracked, repo: true }
}

export function parseDate(raw) {
  const text = String(raw || '')
  const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u)
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const check = new Date(Number(m[3]), month - 1, day)
  if (check.getDate() !== day || check.getMonth() !== month - 1) return null
  return text
}

export function parseArgs(argv) {
  const title = argv[2]
  if (!title) {
    return { error: 'Usage: node scripts/stage-section.mjs "<ID (этап N): Заголовок>" [ДД.ММ.ГГГГ]' }
  }
  const date = parseDate(argv[3]) || todayRu()
  const idMatch = title.match(/^([A-Z][A-Z0-9]{1,7}-\d{2})\b/u)
  return { title, date, id: idMatch ? idMatch[1] : 'ID' }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.error) {
    console.error(args.error)
    process.exit(2)
  }
  const { diffStat, untracked, repo } = collectGit()
  console.log(buildSection({ title: args.title, date: args.date, diffStat, untracked, repo }))
  console.log('')
  console.log(buildHeaderChecklist({ date: args.date, id: args.id }))
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main()
