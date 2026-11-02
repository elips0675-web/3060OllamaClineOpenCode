import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  changedFiles,
  judge,
  parseEvents,
  prepareWorkspace,
  providerConfig,
  taskRule,
} from './agent-opencode.mjs'

const TASKS = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'evals', 'tasks.json'), 'utf8'))
const task = (id) => TASKS.find((item) => item.id === id)

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-opencode-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const event = (obj) => `${JSON.stringify(obj)}\n`

describe('разбор вывода opencode', () => {
  it('берёт последний текст и считает инструменты с шагами', () => {
    const raw =
      event({ type: 'step_start', part: { type: 'step-start' } }) +
      event({ type: 'tool_use', part: { type: 'tool', tool: 'read' } }) +
      event({ type: 'tool_use', part: { type: 'tool', tool: 'grep' } }) +
      event({ type: 'step_start', part: { type: 'step-start' } }) +
      event({ type: 'text', part: { type: 'text', text: 'черновик' } }) +
      event({ type: 'text', part: { type: 'text', text: 'итог: ok' } })
    const parsed = parseEvents(raw)
    expect(parsed.answer).toBe('итог: ok')
    expect(parsed.tools).toBe(2)
    expect(parsed.steps).toBe(2)
  })

  it('переживает служебные строки, которые не JSON', () => {
    const parsed = parseEvents(`> build · model\n${event({ type: 'text', part: { type: 'text', text: 'ответ' } })}`)
    expect(parsed.answer).toBe('ответ')
    expect(parsed.tools).toBe(0)
  })

  it('пустой вывод — пустой ответ, а не падение', () => {
    expect(parseEvents('')).toEqual({ answer: '', tools: 0, steps: 0, events: [] })
  })
})

describe('конфиг песочницы', () => {
  it('для ollama объявляет модель с инструментами', () => {
    const config = providerConfig('ollama/swiftmatch-coder-14b:latest')
    expect(config.model).toBe('ollama/swiftmatch-coder-14b:latest')
    expect(config.providers.ollama.models['swiftmatch-coder-14b:latest'].capabilities.tools).toBe(true)
  })

  it('для облачной модели не выдумывает провайдера', () => {
    const config = providerConfig('opencode/deepseek-v4.1-flash-free')
    expect(config.providers).toBeUndefined()
  })
})

describe('правила задач', () => {
  it('E-04 без теста не проходит', () => {
    expect(taskRule(task('E-04'), ['src/lib/utils.ts'], 'текст').pass).toBe(false)
  })

  it('E-04 с тестом проходит', () => {
    expect(taskRule(task('E-04'), ['src/test/utils.test.ts'], 'текст')).toBeNull()
  })

  it('E-05 без правки и без отказа не проходит', () => {
    expect(taskRule(task('E-05'), [], 'обычный текст').pass).toBe(false)
  })

  it('E-05 с правкой или доказанным отказом проходит', () => {
    expect(taskRule(task('E-05'), ['server/src/limits.js'], 'текст')).toBeNull()
    expect(taskRule(task('E-05'), [], 'дефекта нет: строка 12 делает всё верно')).toBeNull()
  })

  it('остальные задачи правил не добавляют', () => {
    expect(taskRule(task('E-01'), [], 'текст')).toBeNull()
  })
})

describe('судья по фактам', () => {
  it('пропускает ответ с существующей цитатой', () => {
    writeFileSync(path.join(dir, 'app.js'), 'const a = 1\nconsole.log(a)\n', 'utf8')
    const answer =
      'Стиль соседнего теста повторён: проверка вызывает функцию и сравнивает результат. ' +
      'Доказательство — `app.js:2`, где значение выводится в консоль, поэтому тест воспроизводит существующее поведение.'
    const verdict = judge(task('E-04'), { answer, work: dir })
    expect(verdict.verdict.pass).toBe(true)
    expect(verdict.fabricated).toBe(0)
  })

  it('не пропускает выдуманный файл', () => {
    const answer =
      'Тест добавлен рядом с соседним и повторяет его моки, проверка описана в `ghost.js:5` ' +
      'и опирается на существующее поведение функции, ничего в продакшн-коде не менялось.'
    const verdict = judge(task('E-04'), { answer, work: dir })
    expect(verdict.verdict.pass).toBe(false)
    expect(verdict.fabricated).toBe(1)
  })

  it('не пропускает пустой ответ', () => {
    expect(judge(task('E-04'), { answer: 'ок', work: dir }).verdict.pass).toBe(false)
  })
})

describe('песочница задачи', () => {
  it('копирует код и не копирует node_modules', () => {
    const root = path.join(dir, 'repo')
    mkdirSync(path.join(root, 'server', 'src'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(root, 'server', 'src', 'index.js'), 'export const ok = 1\n', 'utf8')
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n', 'utf8')
    const work = path.join(dir, 'work')
    prepareWorkspace(root, work, root)
    expect(readFileSync(path.join(work, 'server', 'src', 'index.js'), 'utf8')).toContain('ok = 1')
    expect(changedFiles(work)).toEqual([])
  })
})
