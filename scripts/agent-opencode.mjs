// Headless-прогон evals/tasks.json агентом OpenCode (без GUI и без человека).
//
// Зачем: AGT-02 требовал ручных 10 задач в Cline. У `opencode-cli` есть
// `run --auto --format json`, инструменты и песочница, поэтому тот же набор
// можно прогнать машинно: копия проекта на задачу, один запуск, судья по
// фактам (`agent-live.mjs`: каждая цитата `file:line` обязана существовать).
//
// Что важно: OpenCode читает stdin, если тот — пайп, и тогда молча висит.
// Поэтому stdin закрыт (`stdio: ['ignore', ...]`); это проверено на 2.2.5.
//
// Использование:
//   node scripts/agent-opencode.mjs --root <проект> --model ollama/swiftmatch-coder-14b:latest --tag local14b
//   node scripts/agent-opencode.mjs --root <проект> --model opencode/deepseek-v4.1-flash-free --tag ds41 [--record]
//
// Коды выхода: 0 — прогон завершён (независимо от pass/fail задач),
// 1 — ни одна задача не прошла, 2 — ошибка аргументов/окружения.

import { spawn, spawnSync as spawnSyncReal } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatPrompt, loadResults, recordRun } from './agent-eval.mjs'
import { autoVerdict, checkCitations, citationsOf } from './agent-live.mjs'

const KIT_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_CLI = path.join(
  process.env.APPDATA || '',
  'ai.opencode.desktop',
  'cli',
  '2.2.5-x64',
  'opencode-cli.exe',
)
export const TASKS_FILE = path.join(KIT_ROOT, 'evals', 'tasks.json')
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'backups', 'tmp', 'playwright-report'])
const SKIP_EXT = /\.(?:log|pdf|png|jpg|jpeg|zip|7z)$/iu

export function parseArgs(argv) {
  const out = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`неизвестный аргумент: ${arg}`)
    const key = arg.slice(2)
    if (['record', 'keep', 'help'].includes(key)) {
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

/** События `--format json` → ответ, число шагов и инструментов. */
export function parseEvents(raw) {
  const events = []
  for (const line of String(raw).split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Не JSON — значит CLI печатает что-то служебное; в расчёт не берём.
    }
  }
  const texts = []
  let tools = 0
  let steps = 0
  for (const event of events) {
    const part = event?.part || {}
    if (event.type === 'step_start') steps += 1
    if (event.type === 'tool_use' || part.type === 'tool') tools += 1
    if (event.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  return { answer: texts.length ? texts[texts.length - 1] : '', tools, steps, events }
}

/** Песочница задачи: копия проекта без тяжёлых каталогов плюс junction на node_modules. */
export function prepareWorkspace(base, work, root) {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true })
  cpSync(base, work, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src)
      if (SKIP.has(name)) return false
      return !SKIP_EXT.test(name)
    },
  })
  const modules = path.join(root, 'node_modules')
  if (existsSync(modules)) {
    try {
      symlinkSync(modules, path.join(work, 'node_modules'), 'junction')
    } catch {
      // Без node_modules задачи с тестами просто не смогут их запустить.
    }
  }
  // В проекте бывают вложенные наборы зависимостей (server/node_modules):
  // они тоже не копируются, а подключаются junction'ом.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue
    const nested = path.join(root, entry.name, 'node_modules')
    if (!existsSync(nested)) continue
    try {
      symlinkSync(nested, path.join(work, entry.name, 'node_modules'), 'junction')
    } catch {
      // Уже существует (скопирован как обычный каталог) — не мешаем.
    }
  }
  return work
}

let spawnSync = spawnSyncReal

export function setSpawnSync(fn) {
  spawnSync = fn
}

export function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/** E-06 проверяет `git diff`, значит в песочнице нужен репозиторий и осмысленный дифф. */
export function initRepository(work) {
  git(work, ['init', '-q'])
  git(work, ['-c', 'user.email=agent@local', '-c', 'user.name=agent', 'add', '-A'])
  git(work, ['-c', 'user.email=agent@local', '-c', 'user.name=agent', 'commit', '-qm', 'baseline'])
}

export function seedDiff(work) {
  const limits = path.join(work, 'server', 'src', 'limits.js')
  if (existsSync(limits)) {
    const text = readFileSync(limits, 'utf8')
    writeFileSync(limits, text.replace('const WINDOW_MS = 60_000', 'const WINDOW_MS = 30_000'), 'utf8')
  }
}

export function changedFiles(work) {
  const result = git(work, ['status', '--porcelain'])
  if (!result || result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
}

/** Правила, которые нельзя вывести из цитат: тест должен быть добавлен, правка — в конкретном файле. */
export function taskRule(task, changed, answer) {
  if (task.id === 'E-04') {
    const added = changed.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file))
    if (!added.length) return { pass: false, reason: 'тест не добавлен в песочницу' }
  }
  if (task.id === 'E-05') {
    if (!changed.length && !/дефект[а-яё]*\s+(?:нет|не найд)|ничего не меня/iu.test(answer)) {
      return { pass: false, reason: 'ни правки, ни доказанного отказа' }
    }
  }
  return null
}

async function runCli({ cli, cwd, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cli, ['run', '--auto', '--format', 'json', '-m', model, prompt], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        ms: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

/**
 * Минимальный конфиг песочницы: модель прогона и (для ollama) описание модели
 * с включёнными инструментами — иначе OpenCode не предложит их модели.
 */
export function providerConfig(model) {
  const config = { $schema: 'https://opencode.ai/config.json', model }
  if (model.startsWith('ollama/')) {
    const id = model.slice('ollama/'.length)
    config.providers = {
      ollama: {
        models: {
          [id]: {
            name: id,
            limit: { context: 12288, output: 4096 },
            capabilities: { tools: true, input: ['text'], output: ['text'] },
          },
        },
      },
    }
  }
  return config
}

export function judge(task, { answer, work }) {
  const citations = citationsOf(answer)
  const { checked, fabricated, badLines } = checkCitations(work, citations)
  // autoVerdict ждёт уже проверенные цитаты (с полями ok/resolved), как в
  // agent-live.summarize: иначе проверки «ok» и «resolved» молча не срабатывают.
  const verdict = autoVerdict(task, { answer, citations: checked, fabricated, badLines, root: work })
  return { verdict, citations: checked, fabricated, badLines }
}

function usage() {
  return `Прогон evals/tasks.json агентом OpenCode (headless).

  node scripts/agent-opencode.mjs --root <проект> --model <provider/model> --tag <метка>
    [--tasks E-01,E-02] [--timeout 420] [--out <файл>] [--record] [--keep] [--cli <exe>]

  --root     проект, по которому идут задачи (копируется в песочницу)
  --model    модель OpenCode, например ollama/swiftmatch-coder-14b:latest
  --tag      метка прогона: попадает в имя файла и в note записи результатов
  --record   дописать результаты в evals/results.json через agent-eval
  --keep     не удалять песочницы задач (по умолчанию удаляются)
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
  if (args.flags.has('help')) {
    console.log(usage())
    return 0
  }
  const root = path.resolve(args.values.root || '')
  const model = args.values.model
  const tag = args.values.tag
  if (!root || !model || !tag) {
    console.error('✗ нужны --root, --model и --tag')
    console.error(usage())
    return 2
  }
  if (!existsSync(root)) {
    console.error(`✗ нет каталога: ${root}`)
    return 2
  }
  const cli = path.resolve(args.values.cli || DEFAULT_CLI)
  if (!existsSync(cli)) {
    console.error(`✗ нет opencode-cli: ${cli}`)
    return 2
  }
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
  const only = args.values.tasks ? new Set(args.values.tasks.split(',').map((id) => id.trim())) : null
  const selected = only ? tasks.filter((task) => only.has(task.id)) : tasks
  const timeoutMs = Number(args.values.timeout || 420) * 1000

  const sandbox = path.join(KIT_ROOT, 'tmp', 'agent-opencode')
  const base = path.join(sandbox, 'base')
  const rows = []
  mkdirSync(sandbox, { recursive: true })
  prepareWorkspace(root, base, root)
  writeFileSync(
    path.join(base, 'opencode.json'),
    `${JSON.stringify(providerConfig(model), null, 2)}\n`,
    'utf8',
  )

  for (const task of selected) {
    const work = path.join(sandbox, 'work', task.id)
    const prompt = formatPrompt(task)
    let run = null
    let parsed = null
    let attempts = 0
    // Повтор — только на сбой обвязки (ненулевой код или пустой вывод), не на
    // вердикт: иначе это уже «переспросим, пока не понравится ответ».
    for (attempts = 1; attempts <= 3; attempts += 1) {
      prepareWorkspace(base, work, root)
      initRepository(work)
      if (task.id === 'E-06') seedDiff(work)
      run = await runCli({ cli, cwd: work, model, prompt, timeoutMs })
      parsed = parseEvents(run.stdout)
      if (run.code === 0 && parsed.answer.trim().length > 0) break
      console.log(`  ↻ ${task.id}: попытка ${attempts} не дала ответа (exit=${run.code})`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    const { answer, tools, steps } = parsed
    const changed = changedFiles(work)
    const { verdict, citations, fabricated, badLines } = judge(task, { answer, work })
    const rule = taskRule(task, changed, answer)
    const final = rule || verdict
    rows.push({
      id: task.id,
      pass: Boolean(final.pass),
      reason: final.reason || '',
      steps: tools + 1,
      toolCalls: tools,
      modelSteps: steps,
      attempts,
      fabricated,
      badLines,
      citations: citations.length,
      changed,
      ms: run.ms,
      exit: run.code,
      answer,
      stderr: run.stderr.slice(0, 2000),
    })
    console.log(
      `${task.id} ${final.pass ? 'PASS' : 'FAIL'} · ${tools} инструментов · ${citations.length} цитат · ` +
        `${Math.round(run.ms / 1000)} с${final.pass ? '' : ` · ${final.reason}`}`,
    )
    if (!args.flags.has('keep')) rmSync(work, { recursive: true, force: true })
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    tag,
    model,
    root,
    cli,
    rows,
  }
  const out = path.resolve(args.values.out || path.join(KIT_ROOT, 'evals', `opencode-${tag}.json`))
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const passed = rows.filter((row) => row.pass).length
  console.log(`\nИтог: ${passed}/${rows.length} pass · ${model} · ${out}`)

  if (args.flags.has('record')) {
    const resultsFile = path.join(KIT_ROOT, 'evals', 'results.json')
    let data = loadResults(resultsFile)
    for (const row of rows) {
      data = recordRun(
        data,
        {
          id: row.id,
          pass: row.pass,
          steps: row.steps,
          fabricated: row.fabricated,
          note: `opencode ${tag}${row.pass ? '' : `: ${row.reason}`}`,
        },
        tasks,
      )
    }
    writeFileSync(resultsFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    console.log(`Записано в ${resultsFile}`)
  }

  return passed > 0 ? 0 : 1
}

setSpawnSync(spawnSyncReal)

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((err) => {
    console.error(`✗ ${err.message}`)
    process.exitCode = 2
  })
}

export const SCRIPT_FILE = fileURLToPath(import.meta.url)
