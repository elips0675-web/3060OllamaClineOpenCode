/**
 * Гейт незакоммиченного окна («не терять работу»).
 *
 * Класс потерь, который git сам не ловит: работа ведётся долгими блоками, коммит
 * ставится в конец, а между блоками дерево подолгу держит сломанное состояние и
 * десятки незакоммиченных файлов. Обрыв сессии (лимит, краш, `git checkout --` по
 * совету из интернета) уносит всё, что после последнего push.
 *
 * Правило: блок дробится и коммитится часто, после коммита — push. Порог ниже —
 * не «красота ради красоты», а сигнал, что блок пора резать: каждая часть — своя
 * запись в «Что сделано.txt», свой коммит, свой push.
 *
 * Перенесено из SwiftMatch (`scripts/retention-gate.mjs`, пороги 6/300 и 10/450
 * появились там после Stage 146 и Stage 148). Лимиты те же.
 *
 * Гейт офлайн (только git): `npm.cmd run retent:check` — сколько угодно раз в
 * процессе, `npm.cmd run retent:check:preflight` — на старте блока.
 *
 * Флаги:
 *   (без флагов)  — строгий режим для рутинных вызовов в конце/середине блока
 *   --preflight   — мягкий режим для старта блока (порог +4 файла/+150 строк)
 *   --json        — машинный вывод вместо таблицы
 *
 * Exit: 0 — окно в норме; 1 — окно слишком большое (список файлов в отчёте);
 * 2 — гейт не применим: в корне нет `.git` (это рабочая копия, а не клон).
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const LIMITS = {
  files: 6,
  lines: 300,
}

export const PREFLIGHT_LIMITS = {
  files: 10,
  lines: 450,
}

export const IGNORED_UNTRACKED = [
  'Анализ test qwen.txt',
  'Анализ тест дипсик.txt',
  'Анализ тест общее.txt',
  'ПАМЯТКА ПО ЗАДАЧАМ ЧТО ДАВАТЬ QWEN 14B ЧТО ПЕРЕДАВАТЬ В ОБЛАКО ОБЩЕЕ.txt',
  'ПАМЯТКА ПО ЗАДАЧАМ ЧТО ДАВАТЬ QWEN 14B ЧТО ПЕРЕДАВАТЬ В ОБЛАКО.txt',
  'ПОДСКАЗКА ОТ CLINE ПЕРЕХОДИТЬ В OPENCODE + DEEPSEEK FLASH 4 FREE.txt',
  'Сократить пакет тест для анализа.txt',
  'Что взять у аналогов.txt',
  'Что прописать в .clinerules условные правила.md',
  'Что прописать в .clinerules условные правила.txt',
]

/**
 * Декодирует путь, который git отдаёт в кавычках: не-ASCII он пишет
 * восьмеричными байтами (`"\320\226\320\275..."`), а не буквами. Без этого
 * `IGNORED_UNTRACKED` не совпадает с реальным именем файла: черновики владельца
 * считаются в окне лишними файлами, а имена в отчёте печатаются нечитаемыми.
 */
export function decodeGitPath(raw) {
  const text = String(raw == null ? '' : raw)
  if (!text.includes('\\')) return text
  const bytes = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === '"' || next === '\\') {
        bytes.push(next.charCodeAt(0))
        i += 1
        continue
      }
      const octal = text.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8))
        i += 3
        continue
      }
    }
    bytes.push(ch.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

export function parsePorcelain(text) {
  const entries = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const status = line.slice(0, 2)
    let file = line.slice(3)
    if (file.includes(' -> ')) file = file.split(' -> ').pop()
    const quoted = file.startsWith('"') && file.endsWith('"')
    file = quoted ? file.slice(1, -1) : file
    entries.push({ status, file: decodeGitPath(file), untracked: status === '??' })
  }
  return entries
}

export function parseNumstat(text) {
  let added = 0
  let removed = 0
  const perFile = new Map()
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const [a, r, ...rest] = line.split('\t')
    const file = decodeGitPath(rest.join('\t'))
    const add = a === '-' ? 0 : Number(a) || 0
    const del = r === '-' ? 0 : Number(r) || 0
    added += add
    removed += del
    perFile.set(file, { added: add, removed: del })
  }
  return { added, removed, perFile }
}

export function countLines(file) {
  try {
    const stat = file.trim()
    if (!stat) return 0
    const buf = fs.readFileSync(path.join(ROOT, stat), 'utf8')
    if (buf === '') return 0
    return buf.split('\n').length
  } catch {
    return 0
  }
}

export function classify(entries, numstat, lineCounter = countLines) {
  const tracked = []
  const untracked = []
  for (const entry of entries) {
    if (entry.untracked) {
      const lines = lineCounter(entry.file)
      untracked.push({ ...entry, lines, ignored: IGNORED_UNTRACKED.includes(entry.file) })
    } else {
      const stat = numstat.perFile.get(entry.file) || { added: 0, removed: 0 }
      tracked.push({ ...entry, ...stat, lines: stat.added + stat.removed })
    }
  }
  return { tracked, untracked }
}

export function summarize(tracked, untracked) {
  const countedUntracked = untracked.filter((u) => !u.ignored)
  const files = tracked.length + countedUntracked.length
  const lines =
    tracked.reduce((sum, t) => sum + t.lines, 0) +
    countedUntracked.reduce((sum, u) => sum + u.lines, 0)
  return {
    files,
    lines,
    trackedFiles: tracked.length,
    untrackedFiles: countedUntracked.length,
    ignoredFiles: untracked.length - countedUntracked.length,
  }
}

export function verdictOf(summary, limits = LIMITS) {
  const red = []
  if (summary.files > limits.files) red.push(`файлов ${summary.files} > ${limits.files}`)
  if (summary.lines > limits.lines) red.push(`строк ${summary.lines} > ${limits.lines}`)
  return { exit: red.length ? 1 : 0, red, limits }
}

export function renderReport(summary, verdict, tracked, untracked) {
  const lines = []
  lines.push('=== RETENTION (незакоммиченное окно) ===')
  lines.push(
    `Изменено: ${summary.trackedFiles} файлов, untracked: ${summary.untrackedFiles} ` +
      `(игнорируется черновиков: ${summary.ignoredFiles}) — всего ${summary.files} файлов / ${summary.lines} строк.`
  )
  lines.push(`Порог: ${verdict.limits.files} файлов / ${verdict.limits.lines} строк.`)
  const top = [...tracked, ...untracked.filter((u) => !u.ignored)]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10)
  if (top.length) {
    lines.push('Крупнейшие:')
    for (const item of top) lines.push(`  ${item.file} (+${item.lines})`)
  }
  if (verdict.exit === 0) {
    lines.push('Окно в норме: работа не рискует потеряться сильнее порога.')
  } else {
    lines.push(`ОКНО СЛИШКОМ БОЛЬШОЕ: ${verdict.red.join(', ')}.`)
    lines.push('Слишком большое незакоммиченное окно. Сделай МИКРОКОММИТ:')
    lines.push('- разбей правки на логические блоки')
    lines.push('- git add поимённо по каждому блоку')
    lines.push('- запиши блок в «Что сделано.txt»')
    lines.push('- git commit --no-verify -F + git push origin main')
    lines.push('Затем продолжай следующий блок.')
    lines.push('Работа сверх порога теряется при обрыве сессии: окно не закоммичено — значит, не сохранено.')
  }
  if (untracked.some((u) => u.ignored)) {
    lines.push(
      `Не считается (черновик владельца, не коммитить): ${untracked
        .filter((u) => u.ignored)
        .map((u) => u.file)
        .join(', ')}`
    )
  }
  return lines.join('\n')
}

export function hasRepo(root = ROOT) {
  try {
    const stat = fs.statSync(path.join(root, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

export function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function collectRetention(root = ROOT) {
  // core.quotepath=false — git отдаёт не-ASCII пути буквами, а не \320\226…:
  // иначе имена в отчёте нечитаемы и сравнение с IGNORED_UNTRACKED не срабатывает.
  const porcelain = git(['-c', 'core.quotepath=false', 'status', '--porcelain'], root)
  const numstat = git(['-c', 'core.quotepath=false', 'diff', '--numstat', 'HEAD'], root)
  const entries = parsePorcelain(porcelain)
  const { tracked, untracked } = classify(entries, parseNumstat(numstat))
  const summary = summarize(tracked, untracked)
  return { entries, tracked, untracked, summary }
}

function main() {
  if (!hasRepo()) {
    console.log('=== RETENTION (незакоммиченное окно) ===')
    console.log(`Гейт не применим: в ${ROOT} нет .git — это рабочая копия, а не клон.`)
    console.log('Запускайте там, где делаются коммиты: D:\\ИИ агент\\3060 16 gb')
    process.exit(2)
  }
  const preflight = process.argv.includes('--preflight')
  const asJson = process.argv.includes('--json')
  const limits = preflight ? PREFLIGHT_LIMITS : LIMITS
  const { tracked, untracked, summary } = collectRetention()
  const verdict = verdictOf(summary, limits)
  if (asJson) {
    console.log(JSON.stringify({ ...verdict, ...summary }, null, 2))
  } else {
    console.log(renderReport(summary, verdict, tracked, untracked))
  }
  process.exit(verdict.exit)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main()
