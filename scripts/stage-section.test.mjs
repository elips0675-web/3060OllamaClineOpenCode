import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FIELDS,
  buildHeaderChecklist,
  buildSection,
  collectGit,
  diffSummary,
  hasRepo,
  parseArgs,
  parseDate,
  todayRu,
} from './stage-section.mjs'

describe('todayRu', () => {
  it('печатает дату с ведущими нулями', () => {
    expect(todayRu(new Date(2026, 9, 31))).toBe('31.10.2026')
    expect(todayRu(new Date(2026, 0, 5))).toBe('05.01.2026')
  })
})

describe('diffSummary', () => {
  it('пустой diff объясняет, что работа уже закоммичена', () => {
    expect(diffSummary('')).toContain('уже закоммичены')
    expect(diffSummary(null)).toContain('уже закоммичены')
  })

  it('из общего числа файлов и последней строки собирает сводку', () => {
    const stat = ' scripts/a.mjs | 3 ++\n scripts/b.mjs | 1 +\n 2 files changed, 4 insertions(+)\n'
    expect(diffSummary(stat)).toBe('изменено файлов: 2 (2 files changed, 4 insertions(+))')
  })

  it('без строки files changed оставляет последнюю строку как есть', () => {
    expect(diffSummary(' a.mjs | 3 +++\n b.mjs | 1 +')).toBe('b.mjs | 1 +')
  })
})

describe('buildSection', () => {
  const section = buildSection({
    title: 'AGT-24 (этап 3): заготовка записи',
    date: '31.10.2026',
    diffStat: ' a.mjs | 2 ++\n 1 file changed, 2 insertions(+)\n',
    untracked: ['scripts/stage-section.mjs'],
  })

  it('заголовок состоит из даты и названия блока под разделителем', () => {
    const lines = section.split('\n')
    expect(lines[0]).toBe('='.repeat(80))
    expect(lines[1]).toBe('31.10.2026. AGT-24 (этап 3): заготовка записи')
    expect(lines[2]).toBe('='.repeat(80))
  })

  it('содержит все пять полей журнала', () => {
    for (const field of FIELDS) expect(section).toContain(`- ${field}: `)
    expect(FIELDS).toEqual(['Задача', 'Что сделано', 'Ломка', 'Тесты', 'Проверки'])
  })

  it('добавляет поле «Гейты» после пяти полей', () => {
    expect(section).toContain('- Гейты: ')
    expect(section.indexOf('- Гейты:')).toBeGreaterThan(section.indexOf('- Проверки: '))
  })

  it('вставляет факт-блок с diff и сводкой', () => {
    expect(section).toContain('git diff --stat HEAD на 31.10.2026:')
    expect(section).toContain('1 file changed, 2 insertions(+)')
    expect(section).toContain('Изменения на 31.10.2026: изменено файлов: 1')
    expect(section).toContain('новых (untracked): 1 — scripts/stage-section.mjs')
  })

  it('на чистом дереве пишет, что коммитить нечего, и не врёт про untracked', () => {
    const clean = buildSection({ title: 'DOC-03 (этап 5): правила', date: '31.10.2026' })
    expect(clean).toContain('рабочее дерево чистое')
    expect(clean).not.toContain('untracked')
  })

  it('плейсхолдер нельзя случайно принять за готовый текст', () => {
    expect(section).toContain('РЕДАКТИРУЙ:')
    expect(section).not.toContain('## ')
  })

  it('без git не врёт «дерево чистое», а честно говорит, где нет .git', () => {
    const noRepo = buildSection({ title: 'AGT-24 (этап 3): заготовка', date: '31.10.2026', repo: false })
    expect(noRepo).toContain('нет `.git`')
    expect(noRepo).not.toContain('рабочее дерево чистое')
    expect(noRepo).not.toContain('git diff --stat HEAD на')
    for (const field of FIELDS) expect(noRepo).toContain(`- ${field}: `)
  })
})

describe('hasRepo и collectGit', () => {
  it('в каталоге без .git не вызывает git и отдаёт repo: false', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stage-section-'))
    try {
      expect(hasRepo(dir)).toBe(false)
      expect(collectGit(dir)).toEqual({ diffStat: '', untracked: [], repo: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('видит .git-каталог', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stage-section-'))
    try {
      mkdirSync(path.join(dir, '.git'))
      expect(hasRepo(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildHeaderChecklist', () => {
  const checklist = buildHeaderChecklist({ date: '31.10.2026', id: 'AGT-24' })

  it('закрывает пункт скриптом и указывает ID', () => {
    expect(checklist).toContain('node scripts/backlog.mjs close --id AGT-24')
    expect(checklist).toContain('31.10.2026')
  })

  it('не требует команд, которых в комплекте нет', () => {
    expect(checklist).not.toContain('test-counter-audit')
    expect(checklist).not.toContain('check-doc-mirrors')
    expect(checklist).toContain('node test/build-pack.mjs --check')
    expect(checklist).toContain('npm.cmd run retent:check')
  })
})

describe('parseArgs', () => {
  it('без заголовка отдаёт текст Usage и просит код 2', () => {
    expect(parseArgs(['node', 'stage-section.mjs']).error).toContain('Usage')
  })

  it('берёт дату из аргумента и ID из заголовка', () => {
    const args = parseArgs(['node', 'stage-section.mjs', 'DOC-04 (этап 6): питфоллы', '01.11.2026'])
    expect(args).toEqual({ title: 'DOC-04 (этап 6): питфоллы', date: '01.11.2026', id: 'DOC-04' })
  })

  it('некривую дату заменяет сегодняшней, а заголовок без ID не ломает вывод', () => {
    const args = parseArgs(['node', 'stage-section.mjs', 'Просто заголовок', '32.13.2026'])
    expect(args.date).toBe(todayRu())
    expect(args.id).toBe('ID')
  })
})

describe('parseDate', () => {
  it('принимает существующую дату в формате журнала', () => {
    expect(parseDate('31.10.2026')).toBe('31.10.2026')
    expect(parseDate('29.02.2024')).toBe('29.02.2024')
  })

  it('отбивает несуществующие дни и месяцы, а не только формат', () => {
    expect(parseDate('32.13.2026')).toBeNull()
    expect(parseDate('29.02.2026')).toBeNull()
    expect(parseDate('00.10.2026')).toBeNull()
  })

  it('отбивает мусор и пустой аргумент', () => {
    expect(parseDate('31/10/2026')).toBeNull()
    expect(parseDate('')).toBeNull()
    expect(parseDate(undefined)).toBeNull()
  })
})
