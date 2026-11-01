// Карта документации: что агент читает всегда, что — по задаче, что не читает.
// Цель — не «все документы», а минимальный вход: AGENTS.md + карточка задачи.
//
//   node scripts/doc-map.mjs          показать карту и размеры
//   node scripts/doc-map.mjs --check  exit 1, если входной бюджет превышен

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECK = process.argv.includes('--check')

const ENTRY = [
  { file: 'AGENTS.md', budget: 6 * 1024, role: 'вход OpenCode/облака (читать всегда)' },
  { file: '.clinerules', budget: 18 * 1024, role: 'правила Cline (читать всегда)' },
  { file: 'Что доделать.txt', budget: 40 * 1024, role: 'задача: только выбранный пункт' },
]

const OPT_IN = [
  { file: 'README.md', role: 'витрина GitHub для человека' },
  { file: '00-ЧИТАЙ-ПЕРВЫМ.txt', role: 'установка для человека' },
  { file: '01-Как-всё-работает.txt', role: 'общая картина; читать при вопросе «как устроено»' },
  { file: '11-Правки-по-оценке.txt', role: 'история внешних рецензий' },
  { file: 'Что сделано.txt', role: 'журнал закрытий; только по конкретному решению' },
]

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
const sizeOf = (rel) => {
  const abs = path.join(ROOT, rel)
  return existsSync(abs) ? statSync(abs).size : null
}

function dirSize(rel) {
  const abs = path.join(ROOT, rel)
  if (!existsSync(abs)) return null
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else {
        files += 1
        bytes += stat.size
      }
    }
  }
  walk(abs)
  return { files, bytes }
}

const problems = []
console.log('ДОКУМЕНТАЦИЯ: карта чтения')
console.log('='.repeat(72))
console.log('Уровень 0–2 — то, что агент читает по правилу:')
for (const item of ENTRY) {
  const size = sizeOf(item.file)
  if (size === null) {
    problems.push(`нет файла ${item.file}`)
    console.log(`  ✗ ${item.file.padEnd(24)} отсутствует`)
    continue
  }
  const over = size > item.budget
  if (over) problems.push(`${item.file}: ${kb(size)} > бюджета ${kb(item.budget)}`)
  console.log(
    `  ${over ? '✗' : '✓'} ${item.file.padEnd(24)} ${kb(size).padStart(9)} ` +
      `(бюджет ${kb(item.budget)}) — ${item.role}`,
  )
}

console.log('')
console.log('Не читать без прямой необходимости:')
for (const item of OPT_IN) {
  const size = sizeOf(item.file)
  if (size === null) continue
  console.log(`  · ${item.file.padEnd(24)} ${kb(size).padStart(9)} — ${item.role}`)
}
const pack = dirSize('test')
if (pack) {
  console.log(
    `  · ${'test/'.padEnd(24)} ${kb(pack.bytes).padStart(9)} — ` +
      `пакет для внешней рецензии (${pack.files} файлов)`,
  )
}

console.log('')
console.log('Правило: один шаг — ≤ 3 файла и ≤ 60 KB входа; больше — дробить или облако.')
if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(`✗ ${problem}`)
  console.log(`Итог: бюджет входа нарушен (${problems.length}).`)
  process.exitCode = 1
} else {
  console.log('Итог: бюджет входа соблюдён ✓')
}
