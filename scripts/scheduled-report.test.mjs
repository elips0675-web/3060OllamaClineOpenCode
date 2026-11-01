import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildReport,
  defaultOut,
  parseArgs,
  stamp,
} from './scheduled-report.mjs'

const SCRIPT = path.join(import.meta.dirname, 'scheduled-report.mjs')
const FIXED = new Date(2026, 10, 1, 9, 5)

const write = (root, rel, content) => {
  const target = path.join(root, rel)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'report-'))
  write(root, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: {} }))
  write(root, 'src/app.ts', 'export const app = 1\n')
  write(root, 'server/src/index.js', 'export function start() {}\n')
  return root
}

let root

beforeEach(() => {
  root = makeProject()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('stamp и defaultOut', () => {
  it('печатает дату и время в ДД.ММ.ГГГГ ЧЧ:ММ', () => {
    expect(stamp(FIXED)).toBe('01.11.2026 09:05')
  })

  it('по умолчанию кладёт отчёт в tmp/report-ГГГГ-ММ-ДД.md', () => {
    expect(defaultOut('C:\\work', FIXED)).toBe(path.join('C:\\work', 'tmp', 'report-2026-11-01.md'))
  })
})

describe('buildReport', () => {
  it('содержит шапку, секции и честную границу', () => {
    const report = buildReport(root, { now: FIXED })
    expect(report.markdown).toContain('# Отчёт по проекту — 01.11.2026 09:05')
    expect(report.markdown).toContain(`- Проект: ${report.root}`)
    expect(report.markdown).toContain('## Бриф')
    expect(report.markdown).toContain('## Индекс символов')
    expect(report.markdown).toContain('## Чего отчёт не делает')
    expect(report.markdown).toContain('не делает commit/push')
  })

  it('включает найденные символы из src и server/src', () => {
    const report = buildReport(root, { now: FIXED })
    expect(report.markdown).toContain('src/app.ts')
    expect(report.markdown).toContain('export: app')
    expect(report.markdown).toContain('server/src/index.js')
  })

  it('без git печатает прочерк, а не падает', () => {
    const report = buildReport(root, { now: FIXED })
    expect(report.git.branch).toBe('')
    expect(report.markdown).toContain('- Ветка: — | последний коммит: —')
  })

  it('возвращает данные для JSON-режима', () => {
    const report = buildReport(root, { now: FIXED })
    expect(report.at).toBe('01.11.2026 09:05')
    expect(report.brief.root).toBe(root)
    expect(Array.isArray(report.symbols.files)).toBe(true)
  })
})

describe('parseArgs', () => {
  it('понимает формы --key=value', () => {
    const args = parseArgs(['--root=D:\\p', '--out=r.md', '--limit=5', '--json'])
    expect(args.root).toBe(path.resolve('D:\\p'))
    expect(args.out).toBe('r.md')
    expect(args.limit).toBe(5)
    expect(args.json).toBe(true)
  })

  it('ругается на неизвестный аргумент и плохой limit', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестный аргумент/u)
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/u)
    expect(() => parseArgs(['--out'])).toThrow(/--out/u)
  })
})

describe('CLI', () => {
  it('пишет markdown в --out и не трогает проект', () => {
    const before = {
      source: readFileSync(path.join(root, 'src', 'app.ts'), 'utf8'),
      entries: readdirSync(root).sort(),
    }
    const out = path.join(root, 'tmp', 'custom.md')
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('## Бриф')
    expect(readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toBe(before.source)
    expect(readdirSync(path.join(root, 'src')).sort()).toEqual(['app.ts'])
    expect(before.entries).toContain('src')
  })

  it('по умолчанию пишет отчёт в tmp рядом с запуском', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    const files = readdirSync(path.join(root, 'tmp'))
    expect(files.some((file) => /^report-\d{4}-\d{2}-\d{2}\.md$/u.test(file))).toBe(true)
    expect(run.stdout).toContain('Отчёт записан')
  })

  it('в --json пишет JSON без markdown-поля', () => {
    const out = path.join(root, 'tmp', 'report.json')
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out, '--json'], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    const data = JSON.parse(readFileSync(out, 'utf8'))
    expect(data.root).toBe(root)
    expect(data.markdown).toBeUndefined()
  })

  it('на несуществующем каталоге выходит с кодом 2', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--root', path.join(root, 'nope')], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('Нет такого каталога')
  })
})
