// Лимит мощности видеокарты: показать температуру и поставить безопасный потолок.
//
//   node scripts/gpu-temp.mjs                 статус (только чтение)
//   node scripts/gpu-temp.mjs --set 130       поставить лимит в ваттах (нужен админ)
//   node scripts/gpu-temp.mjs --reset         вернуть заводской лимит
//   node scripts/gpu-temp.mjs --json          статус в JSON
//
// Почему мощность, а не вентилятор: 80 °C у 14B — это стоковые 170 W. Замеры
// 3060 Ti на 7B (Ollama): 200 → 150 W даёт 77.8 → 75.5 tok/s и 66 → 57 °C;
// 125 W — 72.3 tok/s и 53 °C. Ниже 125 W скорость падает резко.
//
// Скрипт ничего не меняет без --set/--reset: по умолчанию только читает.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const QUERY = [
  'name',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'power.min_limit',
  'power.default_limit',
  'clocks.sm',
]

export const DEFAULT_TARGET = 130

const FIELDS = ['name', 'temperature', 'draw', 'limit', 'minLimit', 'defaultLimit', 'clock']

export function parseStatus(csv) {
  const line = String(csv ?? '')
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .find((row) => row.length > 0)
  if (!line) throw new Error('nvidia-smi не вернул строку со статусом')

  const parts = line.split(',').map((part) => part.trim())
  if (parts.length < FIELDS.length) {
    throw new Error(`ожидалось ${FIELDS.length} полей, получено ${parts.length}: ${line}`)
  }

  const out = { name: parts[0] }
  FIELDS.slice(1).forEach((field, index) => {
    const raw = parts[index + 1]
    const value = raw === '' || /^\[?N\/A\]?$/iu.test(raw) ? null : Number(raw)
    if (value !== null && !Number.isFinite(value)) throw new Error(`поле ${field}: не число «${raw}»`)
    out[field] = value
  })
  return out
}

export function pickLimit(status, target = DEFAULT_TARGET) {
  const min = status.minLimit ?? 0
  const max = status.defaultLimit ?? status.limit
  if (!Number.isFinite(max)) throw new Error('не известен заводской лимит мощности')
  if (target < min) return { watts: min, clamped: 'min', asked: target }
  if (target > max) return { watts: max, clamped: 'max', asked: target }
  return { watts: target, clamped: null, asked: target }
}

export function powerArgs(watts) {
  return ['-pl', String(watts)]
}

export function renderStatus(status) {
  const temp = status.temperature === null ? '—' : `${status.temperature} °C`
  const draw = status.draw === null ? '—' : `${status.draw} W`
  const clock = status.clock === null ? '—' : `${status.clock} MHz`
  const limit = status.limit === null ? '—' : `${status.limit} W`
  const min = status.minLimit === null ? '—' : `${status.minLimit} W`
  const def = status.defaultLimit === null ? '—' : `${status.defaultLimit} W`
  return [
    `GPU: ${status.name}`,
    `  температура: ${temp}`,
    `  мощность:    ${draw} из ${limit} (минимум ${min}, заводской ${def})`,
    `  частота:     ${clock}`,
  ].join('\n')
}

export function advice(status, target = DEFAULT_TARGET) {
  const picked = pickLimit(status, target)
  const temp = status.temperature
  const lines = []
  if (picked.clamped === 'min') {
    lines.push(`Запрошено ${picked.asked} W, карта не умеет ниже ${picked.watts} W — беру минимум.`)
  } else if (picked.clamped === 'max') {
    lines.push(`Запрошено ${picked.asked} W, выше заводского ${picked.watts} W не ставлю.`)
  }
  lines.push(`Лимит: ${picked.watts} W (${picked.asked} W запрошено).`)
  if (temp !== null && temp >= 80) {
    lines.push('Температура 80 °C и выше: сначала лимит мощности, потом вентилятор и корпус.')
  } else if (temp !== null && temp >= 70) {
    lines.push('Температура 70–79 °C: рабочий режим, но лимит мощности даст запас.')
  }
  lines.push(`Команда: nvidia-smi ${powerArgs(picked.watts).join(' ')}`)
  return { picked, text: lines.join('\n') }
}

function runSmi(args) {
  return execFileSync('nvidia-smi', args, { encoding: 'utf8' })
}

export function readStatus(run = runSmi) {
  return parseStatus(run([`--query-gpu=${QUERY.join(',')}`, '--format=csv,noheader,nounits']))
}

export function applyLimit(watts, run = runSmi) {
  try {
    run(powerArgs(watts))
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim()
    const admin = /insufficient|permission|denied|admin|Access is denied/iu.test(detail)
    const hint = admin
      ? 'Нужны права администратора: запусти терминал от имени администратора (в комплекте — 11-Температура.bat).'
      : 'Не удалось изменить лимит: смотри вывод nvidia-smi выше.'
    throw new Error(`${hint}\n${detail}`)
  }
  return readStatus(run)
}

export function parseArgs(argv) {
  let mode = 'status'
  let target = DEFAULT_TARGET
  let json = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--set') {
      mode = 'set'
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value <= 0) throw new Error('--set требует целое число ватт')
      target = value
      i += 1
    } else if (arg.startsWith('--set=')) {
      mode = 'set'
      const value = Number(arg.slice('--set='.length))
      if (!Number.isInteger(value) || value <= 0) throw new Error('--set требует целое число ватт')
      target = value
    } else if (arg === '--reset') {
      mode = 'reset'
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`)
    }
  }

  return { mode, target, json, help }
}

function usage() {
  return [
    'Лимит мощности видеокарты: температура и безопасный потолок.',
    '',
    '  node scripts/gpu-temp.mjs                 статус (только чтение)',
    `  node scripts/gpu-temp.mjs --set ${DEFAULT_TARGET}       поставить лимит (нужен админ)`,
    '  node scripts/gpu-temp.mjs --reset         вернуть заводской лимит',
    '  node scripts/gpu-temp.mjs --json          статус в JSON',
    '',
    '  Без --set/--reset ничего не меняется. Откат: --reset или nvidia-smi -pl <заводской>.',
    '  Windows: запускать в терминале от имени администратора.',
    '',
  ].join('\n')
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }

  let status
  try {
    status = readStatus()
  } catch (err) {
    console.error(`✗ nvidia-smi недоступен: ${String(err.message || err).trim()}`)
    return 2
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ...status, target: args.target, mode: args.mode }, null, 2)}\n`,
    )
    return 0
  }

  process.stdout.write(`${renderStatus(status)}\n`)

  if (args.mode === 'status') {
    process.stdout.write(`\n${advice(status, args.target).text}\n`)
    return 0
  }

  const plan =
    args.mode === 'reset'
      ? { watts: status.defaultLimit ?? status.limit }
      : pickLimit(status, args.target).watts
  if (!Number.isFinite(plan.watts)) {
    console.error('✗ не известен заводской лимит: укажи ватты через --set')
    return 2
  }

  try {
    const after = applyLimit(plan.watts)
    process.stdout.write(`\nЛимит выставлен: ${plan.watts} W\n${renderStatus(after)}\n`)
    return 0
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
