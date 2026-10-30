// Эвалы агента: 10 задач, запись результатов и счёт.
//
// Зачем: «стало лучше» — это не ощущение, а число. Каждая правка правил,
// workflow или промпта проверяется на одном наборе. Оценка бинарная: pass/fail.
//
// Использование:
//   node scripts/agent-eval.mjs list
//   node scripts/agent-eval.mjs record --id E-01 --pass --steps 4 --fabricated 0
//   node scripts/agent-eval.mjs record --id E-02 --fail --steps 9 --fabricated 2 --note "…"
//   node scripts/agent-eval.mjs score [--strict]
//
// Коды выхода: 0 — готово, 1 — ошибка записи/порог не достигнут (--strict),
// 2 — ошибка аргументов/файла.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KIT_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_TASKS = path.join(KIT_ROOT, 'evals', 'tasks.json')
export const DEFAULT_RESULTS = path.join(KIT_ROOT, 'evals', 'results.json')

export const THRESHOLDS = {
  minPass: 7,
  maxFabricated: 0,
  maxAvgSteps: 6,
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

export function loadTasks(file = DEFAULT_TASKS) {
  const tasks = readJson(file)
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`нет задач в ${file}`)
  const seen = new Set()
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !/^E-\d{2}$/u.test(task.id)) {
      throw new Error(`задача без ID формата E-NN в ${file}`)
    }
    if (seen.has(task.id)) throw new Error(`дубль ID ${task.id} в ${file}`)
    if (typeof task.prompt !== 'string' || task.prompt.trim().length < 20) {
      throw new Error(`у задачи ${task.id} нет промпта (prompt) в ${file}`)
    }
    seen.add(task.id)
  }
  return tasks
}

export function loadResults(file = DEFAULT_RESULTS) {
  if (!existsSync(file)) return { runs: [] }
  const data = readJson(file)
  if (!data || !Array.isArray(data.runs)) throw new Error(`битый файл результатов: ${file}`)
  return data
}

const isCount = (value) => Number.isInteger(value) && value >= 0

export function validateRun(run, tasks) {
  if (!run || !tasks.some((task) => task.id === run.id)) {
    throw new Error(`неизвестная задача: ${run?.id || '—'}`)
  }
  if (typeof run.pass !== 'boolean') throw new Error('нужен ровно один из флагов --pass / --fail')
  if (!isCount(run.steps)) throw new Error('--steps требует целое ≥ 0')
  if (!isCount(run.fabricated)) throw new Error('--fabricated требует целое ≥ 0')
  return { ...run, note: String(run.note || '').trim() }
}

export function recordRun(data, run, tasks) {
  const clean = validateRun(run, tasks)
  const entry = { ...clean, at: run.at || new Date().toISOString() }
  return { ...data, runs: [...data.runs, entry] }
}

/** Последний прогон по каждой задаче; непройденные/незапущенные не считаются pass. */
export function scoreRuns(data, tasks) {
  const rows = tasks.map((task) => {
    const runs = data.runs.filter((run) => run.id === task.id)
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    return {
      id: task.id,
      title: task.title,
      route: task.route,
      attempts: runs.length,
      pass: Boolean(last && last.pass),
      steps: last ? last.steps : null,
      fabricated: last ? last.fabricated : null,
      note: last ? last.note : '',
      at: last ? last.at : '',
    }
  })

  const attempted = rows.filter((row) => row.attempts > 0)
  const passed = rows.filter((row) => row.pass).length
  const fabricated = attempted.reduce((sum, row) => sum + (row.fabricated || 0), 0)
  const steps = attempted.filter((row) => row.steps !== null).map((row) => row.steps)
  const avgSteps = steps.length
    ? Math.round((steps.reduce((sum, value) => sum + value, 0) / steps.length) * 10) / 10
    : 0

  return {
    rows,
    total: rows.length,
    attempted: attempted.length,
    passed,
    fabricated,
    avgSteps,
    ready:
      passed >= THRESHOLDS.minPass &&
      fabricated <= THRESHOLDS.maxFabricated &&
      (attempted.length === 0 || avgSteps <= THRESHOLDS.maxAvgSteps),
  }
}

export function formatPrompt(task) {
  return [
    `# ${task.id} — ${task.title}`,
    `Маршрут: ${task.route}`,
    `Критерий pass: ${task.criterion}`,
    '',
    task.prompt,
    '',
    'Правила ответа:',
    '- цикл RESTATE → MAP → PLAN → ACT → VERIFY → REPORT;',
    '- не больше 5 прочитанных файлов и одного изменения;',
    '- каждый факт — с file:line и короткой цитатой;',
    '- если задача шире 6 файлов или задевает деньги/доступы/БД — остановись',
    '  и предложи облако (это тоже правильный ответ);',
    '- в конце — «Не проверено» и один следующий шаг.',
  ].join('\n')
}

export function formatScore(score) {
  const lines = ['ID    задача                          попыток  итог   шаги  выдумано']
  for (const row of score.rows) {
    const verdict = row.attempts === 0 ? '—' : row.pass ? 'PASS' : 'FAIL'
    lines.push(
      `${row.id.padEnd(5)} ${String(row.title).padEnd(31)} ${String(row.attempts).padStart(7)}  ` +
        `${verdict.padEnd(5)} ${String(row.steps ?? '—').padStart(4)}  ${String(row.fabricated ?? '—').padStart(9)}`,
    )
    if (row.note) lines.push(`      … ${row.note}`)
  }
  lines.push('')
  lines.push(
    `Итог: ${score.passed}/${score.total} pass, пройдено задач ${score.attempted}/${score.total}, ` +
      `среднее шагов ${score.avgSteps}, выдумано ${score.fabricated}`,
  )
  lines.push(
    `Порог: pass ≥ ${THRESHOLDS.minPass}, выдумано ≤ ${THRESHOLDS.maxFabricated}, ` +
      `среднее шагов ≤ ${THRESHOLDS.maxAvgSteps} — ${score.ready ? 'готов ✓' : 'не готов ✗'}`,
  )
  return lines.join('\n')
}

export function parseArgs(argv) {
  const mode = argv[0]
  const out = { mode, flags: new Set(), values: {} }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`неизвестный аргумент: ${arg}`)
    const key = arg.slice(2)
    if (['pass', 'fail', 'strict', 'help'].includes(key)) {
      out.flags.add(key)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} требует значение`)
    out.values[key] = value
    i += 1
  }
  if (out.flags.has('pass') && out.flags.has('fail')) {
    throw new Error('--pass и --fail взаимоисключающие')
  }
  return out
}

function usage() {
  return `Эвалы агента: 10 задач.

  node scripts/agent-eval.mjs list [--tasks <файл>]
  node scripts/agent-eval.mjs prompt --id E-01 [--tasks <файл>]
  node scripts/agent-eval.mjs record --id E-01 (--pass|--fail) [--steps N] [--fabricated N] [--note "..."] [--results <файл>]
  node scripts/agent-eval.mjs score [--strict] [--tasks <файл>] [--results <файл>]

  --steps       сколько шагов/правок сделал агент
  --fabricated  сколько несуществующих файлов/функций/полей назвал
  --strict      exit 1, если порог не достигнут
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

  if (!args.mode || args.mode === '--help' || args.flags.has('help')) {
    console.log(usage())
    return args.mode ? 0 : 2
  }
  if (!['list', 'prompt', 'record', 'score'].includes(args.mode)) {
    console.error(`✗ неизвестная команда: ${args.mode}`)
    console.error(usage())
    return 2
  }

  const tasksFile = path.resolve(args.values.tasks || DEFAULT_TASKS)
  const resultsFile = path.resolve(args.values.results || DEFAULT_RESULTS)

  let tasks
  try {
    tasks = loadTasks(tasksFile)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }

  if (args.mode === 'list') {
    for (const task of tasks) {
      console.log(`${task.id}\t${task.route.padEnd(5)}\t${task.title}`)
    }
    return 0
  }

  if (args.mode === 'prompt') {
    if (!args.values.id) {
      console.error('✗ --id обязателен (например --id E-01)')
      return 2
    }
    const task = tasks.find((item) => item.id === args.values.id)
    if (!task) {
      console.error(`✗ неизвестная задача: ${args.values.id}`)
      return 1
    }
    console.log(formatPrompt(task))
    return 0
  }

  let data
  try {
    data = loadResults(resultsFile)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    return 2
  }

  if (args.mode === 'record') {
    try {
      const value = (key) => {
        const raw = args.values[key]
        if (raw === undefined) return 0
        const num = Number(raw)
        if (!Number.isInteger(num) || num < 0) throw new Error(`--${key} требует целое ≥ 0`)
        return num
      }
      const next = recordRun(
        data,
        {
          id: args.values.id,
          pass: args.flags.has('pass'),
          steps: value('steps'),
          fabricated: value('fabricated'),
          note: args.values.note || '',
        },
        tasks,
      )
      mkdirSync(path.dirname(resultsFile), { recursive: true })
      writeFileSync(resultsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      const verdict = args.flags.has('pass') ? 'PASS' : 'FAIL'
      console.log(`✓ записано ${args.values.id}: ${verdict}`)
      return 0
    } catch (err) {
      console.error(`✗ ${err.message}`)
      return 1
    }
  }

  const score = scoreRuns(data, tasks)
  console.log(formatScore(score))
  if (args.flags.has('strict') && !score.ready) return 1
  return 0
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}

export const SCRIPT_FILE = fileURLToPath(import.meta.url)
