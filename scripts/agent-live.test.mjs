import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AUTO_SKIP,
  READ_ONLY_TASKS,
  autoVerdict,
  checkCitations,
  citationsOf,
  formatSummary,
  initialMessages,
  parseArgs,
  parseTextCall,
  parseTextCalls,
  readFileTool,
  rescoreRows,
  safeResolve,
  searchTool,
  summarize,
} from './agent-live.mjs'

const TASK = { id: 'E-01', title: 'Точка входа', prompt: 'Найди вход и объясни старт.', criterion: '3 факта с file:line' }

describe('цитаты', () => {
  it('находит путь со строкой и без', () => {
    const found = citationsOf('Факт: `src/main.tsx:12`, ещё `server/app.js`.')
    expect(found).toEqual([
      { path: 'src/main.tsx', line: 12 },
      { path: 'server/app.js', line: null },
    ])
  })

  it('не считает URL и посторонний текст цитатой', () => {
    expect(citationsOf('см. https://example.com/a.ts')).toEqual([])
    expect(citationsOf('просто текст без файлов')).toEqual([])
  })

  it('нормализует обратные слеши и ./', () => {
    expect(citationsOf('`./src\\a.ts:3`')[0]).toEqual({ path: 'src/a.ts', line: 3 })
  })

  it('не обрезает .json до .js', () => {
    expect(citationsOf('`server/package.json:10`')[0]).toEqual({ path: 'server/package.json', line: 10 })
    expect(citationsOf('`server/vitest-server.json:1`')[0]).toEqual({ path: 'server/vitest-server.json', line: 1 })
  })

  it('не принимает вызов функции за файл', () => {
    expect(citationsOf('`app.use(express.json())`')).toEqual([])
    expect(citationsOf('`Sentry.Handlers.requestHandler()`')).toEqual([])
  })
})

describe('проверка по файловой системе', () => {
  let dir
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  const make = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-live-'))
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n', 'utf8')
    return dir
  }

  it('существующий файл и строка — ok', () => {
    const root = make()
    const check = checkCitations(root, [{ path: 'src/a.ts', line: 2 }])
    expect(check.fabricated).toBe(0)
    expect(check.badLines).toBe(0)
    expect(check.checked[0].ok).toBe(true)
  })

  it('выдуманный файл — fabricated', () => {
    const root = make()
    const check = checkCitations(root, [{ path: 'src/nope.ts', line: 1 }])
    expect(check.fabricated).toBe(1)
    expect(check.checked[0].reason).toBe('missing-file')
  })

  it('строка за концом файла — badLines', () => {
    const root = make()
    const check = checkCitations(root, [{ path: 'src/a.ts', line: 99 }])
    expect(check.badLines).toBe(1)
  })

  it('короткий путь разрешается по уникальному суффиксу, а не считается выдумкой', () => {
    const root = make()
    const check = checkCitations(root, [{ path: 'a.ts', line: 1 }])
    expect(check.fabricated).toBe(0)
    expect(check.checked[0].resolved).toBe('src/a.ts')
  })

  it('неоднозначный суффикс остаётся выдумкой', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-live-'))
    mkdirSync(path.join(dir, 'one'), { recursive: true })
    mkdirSync(path.join(dir, 'two'), { recursive: true })
    writeFileSync(path.join(dir, 'one', 'b.ts'), 'x\n', 'utf8')
    writeFileSync(path.join(dir, 'two', 'b.ts'), 'y\n', 'utf8')
    const check = checkCitations(dir, [{ path: 'b.ts', line: 1 }])
    expect(check.fabricated).toBe(1)
  })

  it('не выпускает за корень проекта', () => {
    const root = make()
    expect(() => safeResolve(root, '../secret.txt')).toThrow(/вне проекта/)
  })
})

describe('вердикт', () => {
  const ok = { answer: 'Вывод: точка входа src/a.ts:1. '.repeat(5), citations: [{}], fabricated: 0, badLines: 0 }

  it('pass при живых цитатах', () => {
    expect(autoVerdict(TASK, ok).pass).toBe(true)
  })

  it('fail без цитат, при выдуманном и при коротком ответе', () => {
    expect(autoVerdict(TASK, { ...ok, citations: [] }).reason).toMatch(/нет цитат/)
    expect(autoVerdict(TASK, { ...ok, fabricated: 1 }).reason).toMatch(/выдуманные/)
    expect(autoVerdict(TASK, { ...ok, answer: 'ок' }).reason).toMatch(/короткий/)
  })

  it('E-10 проходит только при отказе', () => {
    const task = { ...TASK, id: 'E-10' }
    const refusal = { answer: 'Задача шире 6 файлов, это облако. '.repeat(5), citations: [], fabricated: 0, badLines: 0 }
    expect(autoVerdict(task, refusal).pass).toBe(true)
    expect(autoVerdict(task, ok).pass).toBe(false)
  })

  it('E-10 засчитывает отказ словами «слишком широкая задача»', () => {
    const task = { ...TASK, id: 'E-10' }
    const refusal = {
      answer: 'Не могу выполнить: это слишком широкая задача, она затрагивает множество файлов и миграции. '.repeat(3),
      citations: [],
      fabricated: 0,
      badLines: 0,
    }
    expect(autoVerdict(task, refusal).pass).toBe(true)
  })

  it('E-10 засчитывает «более 6 файлов» и «облачных инструментов»', () => {
    const task = { ...TASK, id: 'E-10' }
    const refusal = {
      answer: 'Задача не выполнена: она затрагивает более 6 файлов и обновление зависимостей. ' +
        'Это выходит за рамки локальной работы, нужны облачные инструменты. '.repeat(2),
      citations: [],
      fabricated: 0,
      badLines: 0,
    }
    expect(autoVerdict(task, refusal).pass).toBe(true)
  })

  it('E-07 «не найдено» без файлов — fail, с файлами — pass', () => {
    const task = { ...TASK, id: 'E-07' }
    const bare = { answer: 'Не найдено. Проверил файлы с упоминаниями.', citations: [], fabricated: 0, badLines: 0 }
    expect(autoVerdict(task, bare).reason).toMatch(/без указания/)
    const named = {
      answer: 'Не найдено: проверил server/src/app.js, server/src/routes/tickets.js и AGENTS.md, дубля нет.',
      citations: [],
      fabricated: 0,
      badLines: 0,
    }
    expect(autoVerdict(task, named).pass).toBe(true)
  })

  it('E-09 не принимает markdown вместо схемы', () => {
    const task = { ...TASK, id: 'E-09' }
    const docs = { ...ok, citations: [{ path: 'PLAYBOOK.md', ok: true }] }
    expect(autoVerdict(task, docs).reason).toMatch(/документации/)
    const mixed = { ...ok, citations: [{ path: 'PLAYBOOK.md', ok: true }, { path: 'db/m.sql', ok: true }] }
    expect(autoVerdict(task, mixed).reason).toMatch(/документации/)
  })

  it('E-08 требует два зависимых места вне удаляемого файла', () => {
    const task = { ...TASK, id: 'E-08', prompt: 'Что сломается при удалении `server/src/index.js`?' }
    const self = { answer: 'Нет зависимостей. '.repeat(10), citations: [{ path: 'server/src/index.js', ok: true }], fabricated: 0, badLines: 0 }
    expect(autoVerdict(task, self).reason).toMatch(/мало зависимых мест/)
    const deps = {
      answer: 'Сломается запуск: server/package.json:10 и server/src/app.js:1. '.repeat(3),
      citations: [{ path: 'server/package.json', ok: true }, { path: 'server/src/app.js', ok: true }],
      fabricated: 0,
      badLines: 0,
    }
    expect(autoVerdict(task, deps).pass).toBe(true)
  })

  it('ответ «не найдено» с цитатами — противоречие', () => {
    const answer = 'Точка входа приложения не найдена. ' + 'Факт: server/src/index.js:56. '.repeat(6)
    expect(autoVerdict(TASK, { ...ok, answer }).reason).toMatch(/противоречие/)
  })

  it('обрыв на вызове инструмента — не финальный ответ', () => {
    const answer = '```json\n{"name":"read_file","arguments":{"path":"server/src/index.js"}}\n```'
    expect(autoVerdict(TASK, { ...ok, answer }).reason).toMatch(/вызов инструмента/)
  })

  it('якорный факт обязателен для зачёта', () => {
    const task = { ...TASK, anchors: ['server/src/index.js'] }
    const wrong = { ...ok, citations: [{ path: 'check-console.mjs', ok: true }] }
    expect(autoVerdict(task, wrong).reason).toMatch(/ключевого факта/)
    const right = { ...ok, citations: [{ path: 'server/src/index.js', ok: true }] }
    expect(autoVerdict(task, right).pass).toBe(true)
    const resolved = { ...ok, citations: [{ path: 'index.js', ok: true, resolved: 'server/src/index.js' }] }
    expect(autoVerdict(task, resolved).pass).toBe(true)
  })
})

describe('инструменты', () => {
  let dir
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  const make = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-tools-'))
    writeFileSync(path.join(dir, 'a.ts'), 'const x = 1\nconst y = 2\n', 'utf8')
    return dir
  }

  it('read_file печатает номера строк и диапазон', () => {
    const root = make()
    const text = readFileTool(root, { path: 'a.ts', start: 2, end: 2 })
    expect(text).toContain('2: const y = 2')
    expect(text).not.toContain('const x')
  })

  it('read_file падает на отсутствующем файле', () => {
    const root = make()
    expect(() => readFileTool(root, { path: 'nope.ts' })).toThrow(/нет файла/)
  })

  it('read_file печатает путь относительно корня, даже если дали абсолютный', () => {
    const root = make()
    const absolute = path.join(root, 'a.ts')
    const text = readFileTool(root, { path: absolute, start: 1, end: 1 })
    expect(text.startsWith('a.ts (строки 1-1')).toBe(true)
  })

  it('search_files находит строку с file:line', () => {
    const root = make()
    expect(searchTool(root, { pattern: 'const y' })).toContain('a.ts:2')
  })

  it('search_files понимает glob с звёздочкой и точкой', () => {
    const root = make()
    writeFileSync(path.join(root, 'b.sql'), 'CREATE TABLE ticket (id int)\n', 'utf8')
    expect(searchTool(root, { pattern: 'CREATE TABLE', glob: '*.sql' })).toContain('b.sql:1')
    expect(searchTool(root, { pattern: 'CREATE TABLE', glob: '.sql' })).toContain('b.sql:1')
    expect(searchTool(root, { pattern: 'CREATE TABLE', glob: 'ts' })).toContain('Ничего не найдено')
  })

  it('search_files возвращает понятное «ничего»', () => {
    const root = make()
    expect(searchTool(root, { pattern: 'zzz' })).toContain('Ничего не найдено')
  })
})

describe('текстовый вызов инструмента', () => {
  it('понимает JSON в ответе и в код-блоке', () => {
    expect(parseTextCall('{"name":"read_file","arguments":{"path":"a.ts"}}')).toEqual({
      name: 'read_file',
      args: { path: 'a.ts' },
    })
    expect(parseTextCall('```json\n{"name":"search_files","arguments":{"pattern":"x"}}\n```')).toEqual({
      name: 'search_files',
      args: { pattern: 'x' },
    })
  })

  it('не принимает неизвестный инструмент и обычный текст', () => {
    expect(parseTextCall('{"name":"delete_all","arguments":{}}')).toBe(null)
    expect(parseTextCall('Вывод: файл a.ts:1')).toBe(null)
    expect(parseTextCall('{битый json')).toBe(null)
  })

  it('достаёт несколько вызовов из одного ответа', () => {
    const content = [
      '```json',
      '{"name":"read_file","arguments":{"path":"a.ts","start":304,"end":306}}',
      '```',
      'и ещё',
      '{"name":"search_files","arguments":{"pattern":"validate"}}',
    ].join('\n')
    expect(parseTextCalls(content)).toEqual([
      { name: 'read_file', args: { path: 'a.ts', start: 304, end: 306 } },
      { name: 'search_files', args: { pattern: 'validate' } },
    ])
  })
})

describe('сообщения и отчёт', () => {
  it('в промпт попадают задача, критерий и корень', () => {
    const messages = initialMessages(TASK, 'E:/repo')
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('E:/repo')
    expect(messages[0].content).toContain('Отчёты тестов')
    expect(messages[1].content).toContain('E-01')
    expect(messages[1].content).toContain('Критерий pass')
  })

  it('summarize считает шаги и цитаты', () => {
    const row = summarize(
      TASK,
      { answer: 'Факт: src/a.ts:1. '.repeat(10), toolCalls: 3, trace: [] },
      { checked: [{ ok: true }], fabricated: 0, badLines: 0 },
    )
    expect(row).toMatchObject({ id: 'E-01', pass: true, steps: 4, citations: 1, fabricated: 0 })
  })

  it('formatSummary печатает итог и среднее шагов', () => {
    const text = formatSummary([
      { id: 'E-01', title: 'a', pass: true, steps: 2, citations: 1, fabricated: 0, reason: 'ok' },
      { id: 'E-02', title: 'b', pass: false, steps: 4, citations: 0, fabricated: 1, reason: 'bad' },
    ])
    expect(text).toContain('PASS')
    expect(text).toContain('FAIL')
    expect(text).toContain('1/2 pass')
    expect(text).toContain('среднее шагов 3')
  })

  it('read-only набор не содержит задач с правкой и git diff', () => {
    expect(READ_ONLY_TASKS).not.toContain('E-04')
    expect(READ_ONLY_TASKS).not.toContain('E-05')
    expect(READ_ONLY_TASKS).not.toContain('E-06')
    expect(READ_ONLY_TASKS).toContain('E-10')
    expect(AUTO_SKIP['E-06']).toContain('git diff')
  })
})

describe('пересчёт вердиктов', () => {
  let dir
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('пересчитывает pass по сохранённым ответам, не вызывая модель', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-rescore-'))
    writeFileSync(path.join(dir, 'server-index.js'), 'a\nb\nc\n', 'utf8')
    const tasks = [{ ...TASK, anchors: ['server-index.js'] }]
    const payload = {
      rows: [
        {
          id: 'E-01', title: TASK.title, pass: true, reason: 'старый вердикт',
          steps: 3, citations: 1, fabricated: 0, badLines: 0,
          answer: 'Факт: server-index.js:1 и ещё server-index.js:2. '.repeat(4),
          trace: [],
        },
        {
          id: 'E-01', title: TASK.title, pass: true, reason: 'старый вердикт',
          steps: 1, citations: 1, fabricated: 0, badLines: 0,
          answer: 'Факт: nope-missing.js:1. '.repeat(8),
          trace: [],
        },
      ],
    }
    const rows = rescoreRows(payload, dir, tasks)
    expect(rows[0].pass).toBe(true)
    expect(rows[1].pass).toBe(false)
    expect(rows[1].fabricated).toBeGreaterThan(0)
  })
})

describe('аргументы', () => {
  it('понимает root, tasks и флаги', () => {
    const args = parseArgs(['--root', '.', '--tasks', 'E-01,E-02', '--dry-run'])
    expect(args.values.root).toBe('.')
    expect(args.values.tasks).toBe('E-01,E-02')
    expect(args.flags.has('dry-run')).toBe(true)
  })

  it('падает на неизвестном аргументе и без значения', () => {
    expect(() => parseArgs(['лишнее'])).toThrow(/неизвестный/)
    expect(() => parseArgs(['--root'])).toThrow(/--root/)
  })
})
