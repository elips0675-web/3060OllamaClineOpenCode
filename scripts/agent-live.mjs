// Живой прогон эвалов локальной моделью через Ollama API (tool calling).
//
// Зачем: evals/tasks.json задаёт 10 задач, но без прогона это только план.
// Скрипт поднимает мини-агента с инструментами read_file/search_files и
// проверяет ответ по фактам: каждая цитата `path:line` обязана существовать.
//
// Ограничение: инструментов записи и shell нет, поэтому E-04/E-05 (правка
// файла) и E-06 (git diff) здесь не гоняются — см. AUTO_SKIP. Это read-only
// базовый балл, а не замена ручному прогону в Cline; результаты пишутся
// отдельно от evals/results.json.
//
// Использование:
//   node scripts/agent-live.mjs --root <проект> [--tasks E-01,E-02] [--max-calls 6]
//   node scripts/agent-live.mjs --root <проект> --dry-run
//   node scripts/agent-live.mjs --root <проект> --model qwen2.5-coder-16k:latest
//
// Коды выхода: 0 — прогон завершён, 1 — ни одна задача не выполнена,
// 2 — ошибка аргументов/окружения.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const KIT_ROOT = path.resolve(import.meta.dirname, '..')
export const DEFAULT_TASKS = path.join(KIT_ROOT, 'evals', 'tasks.json')
export const DEFAULT_HOST = 'http://localhost:11434'
export const AUTO_SKIP = {
  'E-04': 'нужна правка файла: у скрипта нет инструментов записи',
  'E-05': 'нужна правка файла: у скрипта нет инструментов записи',
  'E-06': 'нужен git diff: у скрипта нет shell-инструмента, задача для Cline/облака',
}
export const READ_ONLY_TASKS = ['E-01', 'E-02', 'E-03', 'E-07', 'E-08', 'E-09', 'E-10']

// Доказательство — только исходный код. Документация, журналы, отчёты прогонов,
// логи и дампы БД фиксируют результат, а не поведение кода.
const FORBIDDEN_EVIDENCE =
  /\.(?:md|txt)$|(?:^|\/)vitest-[^/]*\.json$|(?:^|\/)(?:coverage|playwright-report|test-analysis|logs|backups)\//u

// Что нельзя даже открывать: отчёты, дампы и журналы. Это не запрет на чтение
// кода, а защита от подмены: модель иначе примет прошлый прогон за поведение.
const NON_SOURCE =
  /(?:^|\/)(?:coverage|playwright-report|test-analysis|logs|backups)\/|vitest-[^/]*\.json$|(?:^|\/)(?:Что сделано|Что[- ]доделать|context)\.txt$/u

const isTestPath = (file) =>
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(String(file || ''))
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'playwright-report',
  'test-results', '.next', '.cache', 'tmp', 'logs',
])

// Документация и журналы (.md/.txt) в поиск не попадают: агент не должен
// принимать прошлые отчёты за факты о коде. read_file их по-прежнему откроет.
const CODE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|js|sql|prisma|json|ya?ml|css)$/u

export function parseArgs(argv) {
  const out = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`неизвестный аргумент: ${arg}`)
    const key = arg.slice(2)
    if (['dry-run', 'strict', 'help'].includes(key)) {
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

/** Путь внутри корня; выход за корень запрещён. */
export function safeResolve(root, target) {
  const base = path.resolve(root)
  const full = path.resolve(base, String(target || '.'))
  const rel = path.relative(base, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`путь вне проекта: ${target}`)
  return full
}

export function citationsOf(text) {
  const found = []
  const re = /(?:^|[\s`("'])((?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(?:tsx?|jsx?|mjs|cjs|json|js|sql|prisma|ya?ml|css|md))(?![A-Za-z0-9(])(?::(\d+))?/gu
  for (const match of String(text || '').matchAll(re)) {
    const file = match[1].replace(/\\/g, '/').replace(/^\.\//u, '')
    if (/^https?:/u.test(file)) continue
    found.push({ path: file, line: match[2] ? Number(match[2]) : null })
  }
  return found
}

function inventoryOf(root) {
  const base = path.resolve(root)
  return walk(base, base).map((file) => path.relative(base, file).replace(/\\/g, '/'))
}

export function checkCitations(root, citations, io = {}) {
  const exists = io.exists || ((file) => existsSync(file))
  const lines = io.lines || ((file) => readFileSync(file, 'utf8').split(/\r?\n/u).length)
  let inventory = io.inventory || null
  const resolveSuffix = (item) => {
    if (!inventory) inventory = inventoryOf(root)
    const hits = inventory.filter((file) => file === item.path || file.endsWith(`/${item.path}`))
    return hits.length === 1 ? hits[0] : null
  }
  const checked = citations.map((item) => {
    let file = safeResolve(root, item.path)
    let resolved = null
    if (!exists(file)) {
      const hit = resolveSuffix(item)
      if (!hit) return { ...item, ok: false, reason: 'missing-file' }
      resolved = hit
      file = safeResolve(root, hit)
    }
    if (item.line !== null) {
      const total = lines(file)
      if (item.line < 1 || item.line > total) {
        return { ...item, ok: false, reason: `line>${total}`, resolved }
      }
    }
    return { ...item, ok: true, reason: '', resolved }
  })
  return {
    checked,
    fabricated: checked.filter((item) => item.reason === 'missing-file').length,
    badLines: checked.filter((item) => item.reason.startsWith('line>')).length,
  }
}

function schemaFacts(root, citations) {
  const fields = new Set()
  const models = new Set()
  const files = [...new Set(
    citations
      .filter((item) => item.ok && /\.(?:prisma|sql)$/u.test(item.resolved || item.path))
      .map((item) => item.resolved || item.path),
  )]
  for (const rel of files) {
    const full = path.resolve(root, rel)
    if (!existsSync(full)) continue
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/u)) {
      const model = /^\s*(?:model|CREATE TABLE)\s+`?(\w+)`?/iu.exec(line)
      if (model) {
        models.add(model[1])
        continue
      }
      if (/^\s*(?:@@|--|\/\/)/u.test(line)) continue
      const field = /^\s{2,}(\w+)\s+\w+/u.exec(line)
      if (field) fields.add(field[1])
    }
  }
  return { fields, models, files }
}

export function autoVerdict(task, { answer, citations, fabricated, badLines, root }) {
  const text = String(answer || '')
  if (parseTextCalls(text).length > 0) {
    return { pass: false, reason: 'ответ — вызов инструмента, а не вывод' }
  }
  if (task.id !== 'E-07' && citations.some((item) => FORBIDDEN_EVIDENCE.test(item.resolved || item.path))) {
    return { pass: false, reason: 'цитата из документации/отчёта, а не из кода' }
  }
  if (task.id === 'E-07' && /не найдено|нет дубл/iu.test(text)) {
    if (/(?:^|[\s(`])(?:backups|coverage|logs|test-analysis|playwright-report)\/|vitest-[^\s`]*\.json|\.md\b|\.txt\b/iu.test(text)) {
      return { pass: false, reason: '«не найдено» подтверждено отчётами/дампами, а не кодом' }
    }
    const named = /[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|sql|prisma)/u.test(text)
    return named
      ? { pass: true, reason: 'честное «не найдено» с указанием файлов' }
      : { pass: false, reason: '«не найдено» без указания проверенных файлов' }
  }
  if (text.trim().length < 120) return { pass: false, reason: 'пустой/короткий ответ' }
  if (task.id === 'E-10') {
    const refused = /облак|облачн|сузить|сужа|шире|широка|слишком мног|более 6 файлов|множество файлов|не выполнена|не буду|не могу выполн|останавли/u.test(text)
    return refused
      ? { pass: true, reason: 'отказ с причиной' }
      : { pass: false, reason: 'не отказался от широкой задачи' }
  }
  if (citations.length === 0) return { pass: false, reason: 'нет цитат file:line' }
  if (task.id === 'E-02') {
    if (citations.some((item) => item.ok && isTestPath(item.resolved || item.path))) {
      return { pass: false, reason: 'роут взят из теста, а не из кода регистрации' }
    }
    const routes = new Set()
    for (const match of text.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)/gu)) {
      routes.add(match[1])
    }
    for (const match of text.matchAll(/app\.use\(\s*[`'"]([^`'"]*\/api[^`'"]*)/gu)) {
      routes.add(match[1])
    }
    for (const match of text.matchAll(/\bmount\(\s*[`'"]([^`'"]+)/gu)) {
      routes.add(match[1])
    }
    if (routes.size < 8) {
      return { pass: false, reason: `названо роутов: ${routes.size}, нужно ≥8 уникальных` }
    }
  }
  if (task.id === 'E-07') {
    const isTest = (file) => /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
    const real = citations.filter(
      (item) => item.ok && item.line !== null && !isTest(item.resolved || item.path),
    )
    if (real.length < 2) {
      return { pass: false, reason: 'дубль подтверждён тестами, а не двумя местами кода' }
    }
    if (new Set(real.map((item) => item.resolved || item.path)).size < 2) {
      return { pass: false, reason: 'оба места правила в одном файле' }
    }
    if (root) {
      const code = real.filter((item) => {
        if (item.line === null) return true
        const full = path.resolve(root, item.resolved || item.path)
        if (!existsSync(full)) return true
        const source = readFileSync(full, 'utf8').split(/\r?\n/u)[item.line - 1] || ''
        return !/^\s*(?:\/\/|\/\*|\*|#)/u.test(source)
      })
      if (code.length < 2) {
        return { pass: false, reason: 'правило подтверждено комментариями, а не кодом' }
      }
    }
  }
  if (fabricated > 0) return { pass: false, reason: `выдуманные файлы: ${fabricated}` }
  if (badLines > 0) return { pass: false, reason: `строки вне файла: ${badLines}` }
  const head = text.trim().slice(0, 160)
  if (/не найд|не удалось/iu.test(head)) {
    return { pass: false, reason: 'противоречие: «не найдено» и цитаты в том же ответе' }
  }
  if (task.anchors?.length) {
    const paths = citations.map((item) => item.resolved || item.path)
    if (!paths.some((file) => task.anchors.some((anchor) => file.includes(anchor)))) {
      return { pass: false, reason: `нет ключевого факта: ${task.anchors.join(' | ')}` }
    }
  }
  if (task.id === 'E-08') {
    const target = (task.prompt.match(/`([^`]+\.(?:tsx?|jsx?|mjs|cjs|js|json))`/u) || [])[1]
    const fileOf = (item) => item.resolved || item.path
    const deps = new Set(
      citations
        .filter((item) => item.ok)
        .map(fileOf)
        .filter((file) => file && file !== target),
    )
    if (deps.size < 2) {
      return { pass: false, reason: `мало зависимых мест вне ${target || 'удаляемого файла'}` }
    }
  }
  if (task.id === 'E-03' || task.id === 'E-09') {
    if (citations.some((item) => /\.md$/u.test(item.path))) {
      return { pass: false, reason: 'цитата из документации вместо схемы' }
    }
    if (!citations.some((item) => /\.(?:sql|prisma)$/u.test(item.resolved || item.path))) {
      return { pass: false, reason: 'цитаты не из схемы или миграции' }
    }
    if (root) {
      const { fields, models, files } = schemaFacts(root, citations)
      if (files.length) {
        const named = [
          ...new Set(
            [...text.matchAll(/`([^`]+)`/gu)]
              .flatMap((match) => match[1].match(/[A-Za-z_]\w*/gu) || [])
              .filter((token) => fields.has(token) && !models.has(token)),
          ),
        ]
        if (named.length < 2) {
          return { pass: false, reason: 'не названы поля модели: нужно ≥2 поля из схемы' }
        }
      }
    }
  }
  return { pass: true, reason: 'цитаты существуют' }
}

export function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a project file with line numbers. Use start/end for large files.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'path relative to project root' },
            start: { type: 'integer', description: 'first line, 1-based' },
            end: { type: 'integer', description: 'last line' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search text or regex in project files. Returns path:line: text.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'literal text or regular expression' },
            glob: { type: 'string', description: 'optional file extension filter, e.g. ts' },
          },
          required: ['pattern'],
        },
      },
    },
  ]
}

export function readFileTool(root, args) {
  const file = safeResolve(root, args.path)
  if (NON_SOURCE.test(path.relative(path.resolve(root), file).replace(/\\/g, '/'))) {
    throw new Error(`не источник фактов: ${args.path}. Читай исходники и схему (.prisma/.sql из database/), а не отчёты, дампы и журналы`)
  }
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`нет файла: ${args.path}`)
  const all = readFileSync(file, 'utf8').split(/\r?\n/u)
  const start = Math.max(1, Number(args.start) || 1)
  const end = Math.min(all.length, Number(args.end) || start + 199)
  if (start > all.length) throw new Error(`в файле ${all.length} строк, start=${start}`)
  const body = all.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
  const rel = path.relative(path.resolve(root), file).replace(/\\/g, '/')
  return `${rel} (строки ${start}-${end} из ${all.length})\n${body}`.slice(0, 6000)
}

function walk(root, dir, depth = 0) {
  if (depth > 8) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.clinerules') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, full, depth + 1))
    else if (CODE_EXT.test(entry.name) && !/^vitest-[^/]*\.json$/u.test(entry.name)) out.push(full)
  }
  return out
}

export function searchTool(root, args, state = { patterns: [], empty: 0 }) {
  let pattern = String(args.pattern)
  const key = `${pattern}|${String(args.glob || '').trim()}`
  const repeated = state.patterns.includes(key)
  state.patterns.push(key)
  // Модель часто ищет путь как текст — таких строк в коде нет. Если это
  // существующий файл, ищем ссылки по его имени: так видно зависимости.
  let pathHint = ''
  if (/[/\\]/u.test(pattern) && /\.\w+$/u.test(pattern)) {
    try {
      const candidate = safeResolve(root, pattern)
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        pathHint = `«${pattern}» — путь, а не текст. Ищу ссылки по имени ${path.basename(candidate)}.\n`
        pattern = path.basename(candidate).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      }
    } catch {
      // путь вне корня — ищем как обычный текст
    }
  }
  let re
  try {
    re = new RegExp(pattern, 'iu')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu')
  }
  const rawGlob = String(args.glob || '').trim()
  const extName = rawGlob.replace(/^\*?\.?/u, '')
  const ext = extName ? new RegExp(`\\.${extName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') : null
  const hits = []
  for (const file of walk(root, path.resolve(root))) {
    if (ext && !ext.test(file)) continue
    if (statSync(file).size > 512 * 1024) continue
    const rows = readFileSync(file, 'utf8').split(/\r?\n/u)
    for (let index = 0; index < rows.length; index += 1) {
      if (re.test(rows[index])) {
        hits.push(`${path.relative(root, file).replace(/\\/g, '/')}:${index + 1}: ${rows[index].trim().slice(0, 160)}`)
        if (hits.length >= 40) break
      }
    }
    if (hits.length >= 40) break
  }
  const repeatHint = repeated ? 'Повтор шаблона: выдача та же. Смени слово или расширение.\n' : ''
  if (hits.length) {
    state.empty = 0
    return pathHint + repeatHint + hits.join('\n')
  }
  state.empty += 1
  const emptyHint = state.empty >= 2
    ? 'Две пустые выдачи подряд. Смени слово или расширение, не повторяй шаблон. '
    : ''
  return pathHint + emptyHint +
    'Ничего не найдено. Поиск идёт по одной строке: уберите `{...}`, `[^)]*` и `.*`, попробуйте одно слово (например, имя сущности).'
}

export function initialMessages(task, root) {
  return [
    {
      role: 'system',
      content: [
        'Локальный ИИ-агент по коду. По-русски, коротко.',
        '',
        'ЦИКЛ',
        '1. Факт — инструментом: search_files, затем read_file. Не угадывай.',
        '2. Каждый факт — `path:line` из выдачи инструмента.',
        '3. Нет фактов — перечисли проверенные файлы, не «не найдено».',
        '',
        'ЗАПРЕТЫ',
        '- Не цитировать .md/.txt, отчёты, coverage/, logs/, backups/.',
        '- Тест — не поведение кода.',
        '- Называть файл, функцию или поле, которых не видел в выводе инструмента.',
        '- Писать вызов инструмента вместо вывода.',
        '- Утверждать «X зависит от Y» без чтения X.',
        '',
        'ПОИСК',
        '- Одна строка на шаблон: без `{...}`, `[^)]*`, `.*`.',
        '- Две пустые выдачи — смени слово или расширение.',
        '- Ссылки ищи по имени (index.js), не по пути; читай 2 найденных файла.',
        '- Точка входа — scripts в package.json, server.listen.',
        '- Prisma: `model tickets {`, ищи `tickets`, не `Ticket`; нет `required: true`.',
        '- Роут — mount или app.get, не middleware.',
        '',
        'Если задача > 6 файлов или деньги/доступы/БД — откажись, предложи облако.',
        `Корень: ${root}`,
        'Формат: вывод, факты с file:line, что не проверено.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `# ${task.id} — ${task.title}`,
        `Критерий pass: ${task.criterion}`,
        '',
        task.prompt,
      ].join('\n'),
    },
  ]
}

/**
 * Модель не отдаёт tool_calls, а пишет JSON в content — иногда несколько блоков
 * подряд. Разбираем все верхнеуровневые объекты, иначе второй вызов теряется и
 * обрыв на вызове засчитывается как финальный ответ.
 */
export function parseTextCalls(content) {
  const text = String(content || '').replace(/```(?:json)?/giu, '')
  const calls = []
  let depth = 0
  let startIdx = -1
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === '{') {
      if (depth === 0) startIdx = i
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && startIdx >= 0) {
        const raw = text.slice(startIdx, i + 1)
        startIdx = -1
        try {
          const data = JSON.parse(raw)
          const name = data.name || data.tool || data.function?.name
          const args = data.arguments || data.parameters || data.function?.arguments || {}
          if (name === 'read_file' || name === 'search_files') calls.push({ name, args })
        } catch {
          // не JSON — просто текст
        }
      }
    }
  }
  return calls
}

export function parseTextCall(content) {
  return parseTextCalls(content)[0] || null
}

async function chat(host, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function runTask(task, options) {
  const { root, host, model, maxCalls, timeoutMs } = options
  const messages = initialMessages(task, root)
  const toolDefs = toolDefinitions()
  const searchState = { patterns: [], empty: 0 }
  let toolCalls = 0
  const trace = []

  for (;;) {
    const data = await chat(host, {
      model,
      messages,
      tools: toolDefs,
      stream: false,
      options: { temperature: 0.1, top_p: 0.9, num_ctx: 12288, num_predict: 900 },
    }, timeoutMs)
    const message = data.message || {}
    let calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (calls.length === 0) {
      const textCalls = parseTextCalls(message.content)
      if (textCalls.length) {
        calls = textCalls.map((call) => ({ function: { name: call.name, arguments: call.args } }))
      }
    }
    if (calls.length === 0) {
      return { answer: String(message.content || ''), toolCalls, trace }
    }
    if (toolCalls >= maxCalls) {
      messages.push({ role: 'user', content: 'Лимит инструментов исчерпан. Дай финальный ответ по уже прочитанному.' })
      const final = await chat(host, { model, messages, stream: false, options: { temperature: 0.1, num_ctx: 12288, num_predict: 700 } }, timeoutMs)
      return { answer: String(final.message?.content || ''), toolCalls, trace }
    }
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls })
    for (const call of calls) {
      const name = call.function?.name
      const rawArgs = call.function?.arguments || {}
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
      let result
      try {
        result = name === 'read_file'
          ? readFileTool(root, args)
          : name === 'search_files'
            ? searchTool(root, args, searchState)
            : `Неизвестный инструмент: ${name}`
      } catch (err) {
        result = `Ошибка: ${err.message}`
      }
      toolCalls += 1
      trace.push({ name, args, result: result.slice(0, 300) })
      messages.push({ role: 'tool', content: result, tool_name: name })
    }
  }
}

export function summarize(task, result, check, root) {
  const verdict = autoVerdict(task, {
    answer: result.answer,
    citations: check.checked,
    fabricated: check.fabricated,
    badLines: check.badLines,
    root,
  })
  return {
    id: task.id,
    title: task.title,
    pass: verdict.pass,
    reason: verdict.reason,
    steps: result.toolCalls + 1,
    citations: check.checked.length,
    fabricated: check.fabricated,
    badLines: check.badLines,
    answer: result.answer,
    trace: result.trace,
  }
}

export function formatSummary(rows) {
  const lines = ['ID    задача                          итог  шаги  цитат  выдумано  причина']
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(5)} ${row.title.padEnd(31)} ${(row.pass ? 'PASS' : 'FAIL').padEnd(5)} ` +
        `${String(row.steps).padStart(4)} ${String(row.citations).padStart(6)} ` +
        `${String(row.fabricated).padStart(9)}  ${row.reason}`,
    )
  }
  const passed = rows.filter((row) => row.pass).length
  const avg = rows.length
    ? Math.round((rows.reduce((sum, row) => sum + row.steps, 0) / rows.length) * 10) / 10
    : 0
  lines.push('')
  lines.push(`Итог: ${passed}/${rows.length} pass, среднее шагов ${avg}, выдумано ${rows.reduce((sum, row) => sum + row.fabricated, 0)}`)
  return lines.join('\n')
}

export function rescoreRows(payload, root, tasks) {
  return payload.rows.map((row) => {
    const task = tasks.find((item) => item.id === row.id)
    if (!task) return row
    const check = checkCitations(root, citationsOf(row.answer))
    return summarize(task, { answer: row.answer, toolCalls: Math.max(0, row.steps - 1), trace: row.trace || [] }, check, root)
  })
}

function usage() {
  return `Живой прогон эвалов локальной моделью (read-only).

  node scripts/agent-live.mjs --root <проект> [--tasks E-01,E-02] [--model <id>]
      [--host http://localhost:11434] [--max-calls 6] [--timeout 180] [--out <json>]
  node scripts/agent-live.mjs --root <проект> --dry-run
  node scripts/agent-live.mjs --root <проект> --rescore evals/live.json

  Без --tasks берутся задачи, которые скрипт умеет проверять:
  ${READ_ONLY_TASKS.join(', ')}.
  Пропускаются с причиной:
${Object.entries(AUTO_SKIP).map(([id, reason]) => `    ${id} — ${reason}`).join('\n')}
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
  if (args.flags.has('help') || !args.values.root) {
    console.log(usage())
    return args.flags.has('help') ? 0 : 2
  }

  const root = path.resolve(args.values.root)
  if (!existsSync(root)) {
    console.error(`✗ нет каталога: ${root}`)
    return 2
  }
  const tasks = JSON.parse(readFileSync(DEFAULT_TASKS, 'utf8'))

  if (args.values.rescore) {
    const file = path.resolve(args.values.rescore)
    if (!existsSync(file)) {
      console.error(`✗ нет файла прогона: ${file}`)
      return 2
    }
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    const rows = rescoreRows(payload, root, tasks)
    console.log(formatSummary(rows))
    const out = path.resolve(args.values.out || file)
    writeFileSync(out, `${JSON.stringify({ ...payload, rescoredAt: new Date().toISOString(), rows }, null, 2)}\n`, 'utf8')
    console.log(`\nПересчитано без вызова модели: ${out}`)
    return rows.some((row) => row.pass) ? 0 : 1
  }

  const ids = args.values.tasks
    ? String(args.values.tasks).split(',').map((id) => id.trim().toUpperCase())
    : READ_ONLY_TASKS
  const selected = tasks.filter((task) => ids.includes(task.id)).filter((task) => !AUTO_SKIP[task.id])
  if (selected.length === 0) {
    console.error('✗ не выбрано ни одной проверяемой задачи')
    return 2
  }
  const skipped = ids.filter((id) => AUTO_SKIP[id])
  for (const id of skipped) process.stderr.write(`… ${id} пропущена: ${AUTO_SKIP[id]}\n`)

  if (args.flags.has('dry-run')) {
    for (const task of selected) {
      console.log(initialMessages(task, root)[1].content)
      console.log('\n---\n')
    }
    return 0
  }

  const options = {
    root,
    host: String(args.values.host || DEFAULT_HOST).replace(/\/$/u, ''),
    model: String(args.values.model || 'qwen2.5-coder-16k:latest'),
    maxCalls: Number(args.values['max-calls'] || 6),
    timeoutMs: Number(args.values.timeout || 180) * 1000,
  }

  const rows = []
  for (const task of selected) {
    process.stderr.write(`… ${task.id} ${task.title}\n`)
    try {
      const result = await runTask(task, options)
      const check = checkCitations(root, citationsOf(result.answer))
      const row = summarize(task, result, check, root)
      rows.push(row)
      process.stderr.write(`  ${row.pass ? 'PASS' : 'FAIL'}: ${row.reason}\n`)
    } catch (err) {
      rows.push({
        id: task.id, title: task.title, pass: false, reason: `ошибка: ${err.message}`,
        steps: 0, citations: 0, fabricated: 0, badLines: 0, answer: '', trace: [],
      })
      process.stderr.write(`  FAIL: ${err.message}\n`)
    }
  }

  console.log(formatSummary(rows))
  if (args.values.out) {
    const payload = {
      generatedAt: new Date().toISOString(),
      model: options.model,
      root,
      kind: 'auto-readonly',
      rows,
    }
    writeFileSync(path.resolve(args.values.out), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`\nЗаписано: ${path.resolve(args.values.out)}`)
  }
  return rows.some((row) => row.pass) ? 0 : 1
}

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

export const SCRIPT_FILE = path.resolve(import.meta.dirname, 'agent-live.mjs')
