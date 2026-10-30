import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  THRESHOLDS,
  formatPrompt,
  formatScore,
  loadResults,
  loadTasks,
  parseArgs,
  recordRun,
  scoreRuns,
  validateRun,
} from './agent-eval.mjs'

const SCRIPT = path.join(import.meta.dirname, 'agent-eval.mjs')
const TASKS = loadTasks()

const run = (id, pass, steps, fabricated = 0, note = '') => ({
  id,
  pass,
  steps,
  fabricated,
  note,
})

describe('задачи', () => {
  it('содержит 10 задач с уникальными ID', () => {
    expect(TASKS).toHaveLength(10)
    expect(new Set(TASKS.map((task) => task.id)).size).toBe(10)
    expect(TASKS[0].id).toBe('E-01')
    expect(TASKS[9].id).toBe('E-10')
  })

  it('у каждой задачи есть маршрут и критерий', () => {
    for (const task of TASKS) {
      expect(['local', 'cloud']).toContain(task.route)
      expect(task.criterion.length).toBeGreaterThan(20)
    }
  })

  it('у каждой задачи есть готовый промпт без заглушек', () => {
    for (const task of TASKS) {
      expect(task.prompt.length).toBeGreaterThan(60)
      expect(task.prompt).not.toMatch(/TODO|\.\.\.|<файл>|<ID>/u)
    }
  })

  it('formatPrompt печатает задачу, критерий и правила', () => {
    const text = formatPrompt(TASKS[0])
    expect(text).toContain('E-01')
    expect(text).toContain(TASKS[0].title)
    expect(text).toContain('Критерий pass:')
    expect(text).toContain('file:line')
    expect(text).toContain('Не проверено')
  })
})

describe('запись прогона', () => {
  it('проверяет ID, флаг и числа', () => {
    expect(() => validateRun(run('E-99', true, 1), TASKS)).toThrow(/неизвестная задача/)
    expect(() => validateRun({ id: 'E-01', steps: 1 }, TASKS)).toThrow(/--pass \/ --fail/)
    expect(() => validateRun(run('E-01', true, -1), TASKS)).toThrow(/--steps/)
    expect(() => validateRun(run('E-01', true, 1, -1), TASKS)).toThrow(/--fabricated/)
  })

  it('добавляет запись, не меняя исходные данные', () => {
    const data = { runs: [] }
    const next = recordRun(data, run('E-01', true, 4, 0, '  ок  '), TASKS)
    expect(data.runs).toHaveLength(0)
    expect(next.runs).toHaveLength(1)
    expect(next.runs[0].note).toBe('ок')
    expect(next.runs[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('счёт', () => {
  it('берёт последний прогон по каждой задаче', () => {
    const data = {
      runs: [
        run('E-01', false, 9, 2),
        run('E-01', true, 4, 0),
        run('E-02', true, 3),
      ],
    }
    const score = scoreRuns(data, TASKS)
    const e01 = score.rows.find((row) => row.id === 'E-01')
    expect(e01.pass).toBe(true)
    expect(e01.attempts).toBe(2)
    expect(e01.steps).toBe(4)
    expect(score.attempted).toBe(2)
    expect(score.passed).toBe(2)
    expect(score.fabricated).toBe(0)
  })

  it('считает выдуманное по последнему прогону', () => {
    const data = { runs: [run('E-01', true, 4), run('E-02', false, 9, 2)] }
    const score = scoreRuns(data, TASKS)
    expect(score.passed).toBe(1)
    expect(score.fabricated).toBe(2)
    expect(score.avgSteps).toBe(6.5)
  })

  it('готовность требует pass ≥ 7, 0 выдуманного и среднее ≤ 6', () => {
    const passing = { runs: TASKS.slice(0, 7).map((task) => run(task.id, true, 4)) }
    expect(scoreRuns(passing, TASKS).ready).toBe(true)

    const fabricated = { runs: TASKS.map((task) => run(task.id, true, 4, 1)) }
    expect(scoreRuns(fabricated, TASKS).ready).toBe(false)

    const slow = { runs: TASKS.map((task) => run(task.id, true, 7)) }
    expect(scoreRuns(slow, TASKS).ready).toBe(false)

    expect(THRESHOLDS.minPass).toBe(7)
  })

  it('пустой файл результатов не считается готовым', () => {
    const score = scoreRuns({ runs: [] }, TASKS)
    expect(score.attempted).toBe(0)
    expect(score.ready).toBe(false)
  })

  it('печатает таблицу и порог', () => {
    const text = formatScore(scoreRuns({ runs: [run('E-01', true, 4)] }, TASKS))
    expect(text).toContain('E-01')
    expect(text).toContain('PASS')
    expect(text).toContain('Порог:')
    expect(text).toContain('не готов')
  })
})

describe('аргументы', () => {
  it('понимает флаги и значения', () => {
    const args = parseArgs(['record', '--id', 'E-01', '--pass', '--steps', '4'])
    expect(args.mode).toBe('record')
    expect(args.values.id).toBe('E-01')
    expect(args.flags.has('pass')).toBe(true)
  })

  it('запрещает pass+fail одновременно', () => {
    expect(() => parseArgs(['record', '--id', 'E-01', '--pass', '--fail'])).toThrow(
      /взаимоисключающие/,
    )
  })

  it('падает на неизвестном аргументе', () => {
    expect(() => parseArgs(['list', 'лишнее'])).toThrow(/неизвестный/)
    expect(() => parseArgs(['record', '--id'])).toThrow(/--id/)
  })
})

describe('CLI', () => {
  let dir
  let results

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'eval-'))
    results = path.join(dir, 'results.json')
    writeFileSync(results, '{"runs":[]}\n', 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const exec = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 })

  it('list печатает задачи', () => {
    const result = exec(['list'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('E-01')
    expect(result.stdout).toContain('E-10')
  })

  it('prompt печатает готовый промпт, ошибки — 1/2', () => {
    const ok = exec(['prompt', '--id', 'E-01'])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('E-01')
    expect(ok.stdout).toContain('Критерий pass:')

    expect(exec(['prompt', '--id', 'E-99']).status).toBe(1)
    expect(exec(['prompt']).status).toBe(2)
  })

  it('record пишет результат, score его видит', () => {
    const record = exec([
      'record',
      '--id',
      'E-01',
      '--pass',
      '--steps',
      '4',
      '--fabricated',
      '0',
      '--note',
      'ок',
      '--results',
      results,
    ])
    expect(record.status).toBe(0)
    const data = loadResults(results)
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]).toMatchObject({ id: 'E-01', pass: true, steps: 4, note: 'ок' })

    const score = exec(['score', '--results', results])
    expect(score.status).toBe(0)
    expect(score.stdout).toContain('E-01')
    expect(score.stdout).toContain('1/10 pass')
  })

  it('record отдаёт 1 на неизвестной задаче и плохом числе', () => {
    const badId = exec(['record', '--id', 'E-99', '--pass', '--results', results])
    expect(badId.status).toBe(1)
    expect(badId.stderr).toMatch(/неизвестная задача/)

    const badSteps = exec([
      'record',
      '--id',
      'E-01',
      '--pass',
      '--steps',
      '-2',
      '--results',
      results,
    ])
    expect(badSteps.status).toBe(1)
    expect(badSteps.stderr).toMatch(/--steps/)
  })

  it('score --strict отдаёт 1, пока порог не достигнут', () => {
    const result = exec(['score', '--strict', '--results', results])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('не готов')
  })

  it('--help отдаёт 0, неизвестная команда — 2', () => {
    expect(exec(['--help']).status).toBe(0)
    expect(exec(['nope']).status).toBe(2)
  })
})

describe('битые файлы', () => {
  it('loadResults на отсутствующем файле возвращает пусто', () => {
    expect(loadResults(path.join(tmpdir(), 'no-such-eval-file.json'))).toEqual({ runs: [] })
  })

  it('loadTasks падает на дубле ID', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-bad-'))
    const file = path.join(dir, 'tasks.json')
    try {
      writeFileSync(
        file,
        JSON.stringify([
          { id: 'E-01', title: 'a', route: 'local', criterion: 'x'.repeat(30), prompt: 'y'.repeat(80) },
          { id: 'E-01', title: 'b', route: 'local', criterion: 'x'.repeat(30), prompt: 'y'.repeat(80) },
        ]),
        'utf8',
      )
      expect(() => loadTasks(file)).toThrow(/дубль ID/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('не перезаписывает файл результатов при ошибке валидации', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-keep-'))
    const file = path.join(dir, 'results.json')
    const before = '{"runs":[]}\n'
    try {
      writeFileSync(file, before, 'utf8')
      const result = spawnSync(
        process.execPath,
        [SCRIPT, 'record', '--id', 'E-99', '--pass', '--results', file],
        { encoding: 'utf8', timeout: 30000 },
      )
      expect(result.status).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
