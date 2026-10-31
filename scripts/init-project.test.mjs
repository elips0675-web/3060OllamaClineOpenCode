import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  KIT_ROOT,
  UserError,
  installProject,
  parseArgs,
  runCli,
} from './init-project.mjs'

const tempDirs = []

function tempProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-init-'))
  tempDirs.push(dir)
  return dir
}

const read = (root, name) => readFileSync(path.join(root, name), 'utf8')
const write = (root, name, text) => writeFileSync(path.join(root, name), text, 'utf8')

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

describe('init-project: аргументы', () => {
  it('разбирает --root и флаги', () => {
    const options = parseArgs(['--root', 'C:\\project', '--dry-run', '--force', '--convert-rules'])
    expect(options.root).toBe(path.resolve('C:\\project'))
    expect(options.dryRun).toBe(true)
    expect(options.force).toBe(true)
    expect(options.convertRules).toBe(true)
  })

  it('падает на неизвестном флаге и пустом --root', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестный аргумент/u)
    expect(() => parseArgs(['--root'])).toThrow(/--root требует/u)
  })

  it('запрещает установку в сам комплект', () => {
    expect(() => installProject({ root: KIT_ROOT, dryRun: true })).toThrow(UserError)
  })
})

describe('init-project: установка', () => {
  it('создаёт правила, workflows, память и docs', () => {
    const root = tempProject()
    const result = installProject({ root })

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', '00-project.md'))).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', '40-agent-cycle.md'))).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', '50-few-shot.md'))).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', 'workflows', 'deep-planning.md'))).toBe(true)
    expect(existsSync(path.join(root, 'cline_docs', 'activeContext.md'))).toBe(true)
    expect(existsSync(path.join(root, 'docs', 'AGENTS-cline-setup.md'))).toBe(true)
    expect(existsSync(path.join(root, 'docs', 'AGENTS-verify-checklist.md'))).toBe(true)
    expect(read(root, '.clinerules/40-agent-cycle.md')).toMatch(/RESTATE/u)
    expect(read(root, 'cline_docs/activeContext.md')).toMatch(/Текущая задача/u)
  })

  it('повторный запуск ничего не перезаписывает', () => {
    const root = tempProject()
    installProject({ root })
    const first = read(root, '.clinerules/40-agent-cycle.md')
    const second = installProject({ root })

    expect(second.ok).toBe(true)
    expect(second.results.filter((row) => row.type === 'copy' && row.applied)).toEqual([])
    expect(read(root, '.clinerules/40-agent-cycle.md')).toBe(first)
  })

  it('--dry-run не создаёт файлов', () => {
    const root = tempProject()
    const result = installProject({ root, dryRun: true })

    expect(result.ok).toBe(true)
    expect(result.results.some((row) => row.type === 'copy' && row.dryRun)).toBe(true)
    expect(existsSync(path.join(root, '.clinerules'))).toBe(false)
    expect(existsSync(path.join(root, 'cline_docs'))).toBe(false)
  })

  it('--no-workflows и --no-memory отключают части', () => {
    const root = tempProject()
    installProject({ root, noWorkflows: true, noMemory: true })

    expect(existsSync(path.join(root, '.clinerules', '40-agent-cycle.md'))).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', 'workflows'))).toBe(false)
    expect(existsSync(path.join(root, 'cline_docs'))).toBe(false)
  })
})

describe('init-project: существующие файлы', () => {
  it('не перезаписывает правила без --force', () => {
    const root = tempProject()
    installProject({ root })
    write(root, '.clinerules/40-agent-cycle.md', 'МОИ ПРАВИЛА\n')

    const result = installProject({ root })
    expect(result.ok).toBe(true)
    expect(read(root, '.clinerules/40-agent-cycle.md')).toBe('МОИ ПРАВИЛА\n')
  })

  it('перезаписывает правила с --force', () => {
    const root = tempProject()
    installProject({ root })
    write(root, '.clinerules/40-agent-cycle.md', 'МОИ ПРАВИЛА\n')

    installProject({ root, force: true })
    expect(read(root, '.clinerules/40-agent-cycle.md')).toMatch(/RESTATE/u)
  })

  it('не перезаписывает паспорт проекта даже с --force', () => {
    const root = tempProject()
    installProject({ root })
    write(root, '.clinerules/00-project.md', 'МОЙ ПАСПОРТ\n')

    installProject({ root, force: true })
    expect(read(root, '.clinerules/00-project.md')).toBe('МОЙ ПАСПОРТ\n')
  })

  it('сохраняет Memory Bank без --force-memory', () => {
    const root = tempProject()
    installProject({ root })
    write(root, 'cline_docs/activeContext.md', 'МОЯ ПАМЯТЬ\n')

    installProject({ root, force: true })
    expect(read(root, 'cline_docs/activeContext.md')).toBe('МОЯ ПАМЯТЬ\n')
  })

  it('перезаписывает Memory Bank с --force-memory', () => {
    const root = tempProject()
    installProject({ root })
    write(root, 'cline_docs/activeContext.md', 'МОЯ ПАМЯТЬ\n')

    installProject({ root, forceMemory: true })
    expect(read(root, 'cline_docs/activeContext.md')).toMatch(/Текущая задача/u)
  })
})

describe('init-project: .clinerules-файл', () => {
  it('без --convert-rules возвращает конфликт и ничего не ломает', () => {
    const root = tempProject()
    write(root, '.clinerules', 'СТАРЫЕ ПРАВИЛА\n')

    const result = installProject({ root })
    expect(result.ok).toBe(false)
    expect(result.results.some((row) => row.type === 'conflict')).toBe(true)
    expect(read(root, '.clinerules')).toBe('СТАРЫЕ ПРАВИЛА\n')
    expect(existsSync(path.join(root, '.clinerules', '40-agent-cycle.md'))).toBe(false)
  })

  it('с --convert-rules сохраняет старый файл как 00-project-rules.md', () => {
    const root = tempProject()
    write(root, '.clinerules', 'СТАРЫЕ ПРАВИЛА\n')

    const result = installProject({ root, convertRules: true })
    expect(result.ok).toBe(true)
    expect(existsSync(path.join(root, '.clinerules', '00-project-rules.md'))).toBe(true)
    expect(read(root, '.clinerules/00-project-rules.md')).toBe('СТАРЫЕ ПРАВИЛА\n')
    expect(existsSync(path.join(root, '.clinerules', '40-agent-cycle.md'))).toBe(true)
    expect(existsSync(path.join(root, '.clinerules'))).toBe(true)
  })
})

describe('init-project: CLI', () => {
  it('печатает справку без записи', () => {
    const lines = []
    const code = runCli(['--help'], { log: (line) => lines.push(line), error: (line) => lines.push(line) })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/init-project/u)
    expect(lines.join('\n')).toMatch(/--dry-run/u)
  })

  it('возвращает 2 на неизвестный флаг', () => {
    const errors = []
    const code = runCli(['--nope'], { log: () => {}, error: (line) => errors.push(line) })
    expect(code).toBe(2)
    expect(errors.join('\n')).toMatch(/неизвестный аргумент/u)
  })

  it('возвращает 1 на конфликт .clinerules-файла', () => {
    const root = tempProject()
    write(root, '.clinerules', 'СТАРЫЕ ПРАВИЛА\n')
    const output = []
    const code = runCli(['--root', root], { log: (line) => output.push(line), error: (line) => output.push(line) })
    expect(code).toBe(1)
    expect(output.join('\n')).toMatch(/CONFLICT/u)
  })
})
