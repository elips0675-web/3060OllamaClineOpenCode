import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  auditBacklog,
  auditJournalEntry,
  closeItem,
  openItem,
  parseArgs,
  today,
} from './backlog.mjs'

const SCRIPT = path.join(import.meta.dirname, 'backlog.mjs')

const BACKLOG = [
  '# Что доделать — тест',
  '',
  '---',
  '',
  '## 🟡 Открытые (P1)',
  '',
  '### BLK-01 — Установить модели',
  'Факт: `02-Установить-локально.bat`',
  'Статус: ⏳ (проверено 30.10.2026)',
  '',
  '### BLK-02 — Проверить ID',
  'Факт: `scripts/next-task.mjs:16`',
  'Статус: ⏳ (проверено 30.10.2026)',
  '',
  '## Правила работы с журналами',
  '',
  '- закрытое уходит в журнал.',
  '',
].join('\n')

describe('аудит бэклога', () => {
  it('принимает открытые пункты с датой проверки', () => {
    const audit = auditBacklog(BACKLOG)
    expect(audit.problems).toEqual([])
    expect(audit.openIds).toEqual(['BLK-01', 'BLK-02'])
    expect(audit.legacyClosed).toEqual([])
  })

  it('требует строку статуса и дату', () => {
    const noStatus = BACKLOG.replace('Статус: ⏳ (проверено 30.10.2026)\n', '')
    expect(auditBacklog(noStatus).problems.join('\n')).toMatch(/нет строки «Статус/)

    const noDate = BACKLOG.replace('(проверено 30.10.2026)', '(проверено —)')
    expect(auditBacklog(noDate).problems.join('\n')).toMatch(/нет даты/)

    const closedStatus = BACKLOG.replace('Статус: ⏳', 'Статус: ✅')
    expect(auditBacklog(closedStatus).problems.join('\n')).toMatch(/должен начинаться с ⏳/)
  })

  it('ловит дубль ID и дубль заголовка по базе', () => {
    const dup = BACKLOG.replace('### BLK-02 — Проверить ID', '### BLK-01 — Проверить ID')
    expect(auditBacklog(dup).problems.join('\n')).toMatch(/ID «BLK-01» уже встречался/)

    const dupHeading = BACKLOG.replace('### BLK-02 — Проверить ID', '### BLK-02 — Установить модели (ещё)')
    expect(auditBacklog(dupHeading).problems.join('\n')).toMatch(/дублируется/)
  })

  it('отвергает устаревшую закрытую строку в бэклоге', () => {
    const text = BACKLOG.replace(
      '## 🟡 Открытые (P1)',
      '## ✅ BLK-03 — Старое — ЗАКРЫТО 29.10.2026\n\n## 🟡 Открытые (P1)',
    )
    const audit = auditBacklog(text)
    expect(audit.problems.join('\n')).toMatch(/устаревший формат/)
    expect(audit.problems.join('\n')).toMatch(/удаляется/)
    expect(audit.legacyClosed).toHaveLength(1)
  })

  it('требует в журнале и ID, и дату', () => {
    expect(auditJournalEntry('BLK-01', '30.10.2026', '30.10.2026. BLK-01 — запись')).toEqual([])
    expect(
      auditJournalEntry('BLK-01', '30.10.2026', 'журнал без даты BLK-01').join('\n'),
    ).toMatch(/даты 30\.10\.2026/)
    expect(
      auditJournalEntry('BLK-01', '30.10.2026', '30.10.2026 без нужного ID').join('\n'),
    ).toMatch(/ID «BLK-01»/)
  })
})

describe('закрытие и открытие', () => {
  it('закрывает пункт удалением секции, без строки ✅', () => {
    const next = closeItem(
      BACKLOG,
      { id: 'BLK-01', date: '30.10.2026', ref: 'раздел «BLK-01»' },
      { doneText: '30.10.2026. BLK-01 — запись журнала' },
    )
    expect(next).not.toContain('BLK-01')
    expect(next).not.toContain('02-Установить-локально.bat')
    expect(next).not.toContain('✅')
    expect(next).toContain('### BLK-02 — Проверить ID')
    expect(auditBacklog(next).problems).toEqual([])
  })

  it('не закрывает без записи в журнале и без пункта', () => {
    expect(() =>
      closeItem(BACKLOG, { id: 'BLK-01', date: '30.10.2026' }, { doneText: 'без даты' }),
    ).toThrow(/сначала развёрнутая запись/)
    expect(() =>
      closeItem(BACKLOG, { id: 'BLK-01', date: '30.10.2026' }, { doneText: '30.10.2026 без ID' }),
    ).toThrow(/ID «BLK-01»/)
    expect(() => closeItem(BACKLOG, { id: 'BLK-01', date: '30.10.2026' })).toThrow(/журнал/)
    expect(() =>
      closeItem(BACKLOG, { id: 'NOPE-01', date: '30.10.2026' }, { doneText: '30.10.2026 NOPE-01' }),
    ).toThrow(/не найден/)
    expect(() =>
      closeItem(BACKLOG, { id: 'bad', date: '30.10.2026' }, { doneText: '30.10.2026' }),
    ).toThrow(/PREFIX-NN/)
    expect(() =>
      closeItem(BACKLOG, { id: 'BLK-01', date: '2026-10-30' }, { doneText: '2026-10-30' }),
    ).toThrow(/ДД\.ММ\.ГГГГ/)
  })

  it('добавляет открытый пункт перед правилами, а не после', () => {
    const next = openItem(BACKLOG, {
      id: 'DOC-01',
      title: 'Новый пункт',
      body: 'Факт: `README.md:1`',
      date: '30.10.2026',
    })
    const rules = next.indexOf('## Правила работы')
    expect(next.indexOf('### DOC-01')).toBeLessThan(rules)
    expect(next).toContain('Статус: ⏳ (проверено 30.10.2026)')
    expect(auditBacklog(next).openIds).toContain('DOC-01')
  })

  it('не открывает пункт с занятым ID или без заголовка', () => {
    expect(() => openItem(BACKLOG, { id: 'BLK-01', title: 'Дубль' })).toThrow(/уже занят/)
    expect(() => openItem(BACKLOG, { id: 'DOC-01', title: '  ' })).toThrow(/title/)
    expect(() => openItem(BACKLOG, { id: 'X', title: 'x' })).toThrow(/PREFIX-NN/)
  })

  it('не переиспользует ID из устаревшей закрытой строки', () => {
    const text = BACKLOG.replace(
      '## 🟡 Открытые (P1)',
      '## ✅ DOC-09 — Старое — ЗАКРЫТО 29.10.2026\n\n## 🟡 Открытые (P1)',
    )
    expect(() => openItem(text, { id: 'DOC-09', title: 'Снова' })).toThrow(/уже занят/)
  })

  it('сохраняет CRLF, если файл был в CRLF', () => {
    const crlf = BACKLOG.replace(/\n/g, '\r\n')
    const next = openItem(crlf, { id: 'DOC-02', title: 'CRLF', date: '30.10.2026' })
    expect(next).toContain('\r\n')
    expect(next.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('аргументы', () => {
  it('разбирает режим, флаги и значения', () => {
    const args = parseArgs(['close', '--id', 'BLK-01', '--date', '30.10.2026', '--dry-run'])
    expect(args.mode).toBe('close')
    expect(args.values.id).toBe('BLK-01')
    expect(args.flags.has('dry-run')).toBe(true)
  })

  it('падает на плохом аргументе', () => {
    expect(() => parseArgs(['check', 'лишнее'])).toThrow(/неизвестный/)
    expect(() => parseArgs(['close', '--id'])).toThrow(/--id/)
  })
})

describe('CLI', () => {
  let dir
  let backlogFile
  let doneFile

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'backlog-'))
    backlogFile = path.join(dir, 'Что доделать.txt')
    doneFile = path.join(dir, 'Что сделано.txt')
    writeFileSync(backlogFile, BACKLOG, 'utf8')
    writeFileSync(doneFile, '30.10.2026. Запись журнала', 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 })

  it('check отдаёт 0 на корректном бэклоге', () => {
    const result = run(['check', '--file', backlogFile, '--done', doneFile])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('открытых 2')
    expect(result.stdout).toContain('устаревших закрытых строк 0')
    expect(result.stdout).toContain('канон бэклога соблюдён')
  })

  it('check отдаёт 1 при нарушении', () => {
    writeFileSync(backlogFile, BACKLOG.replace('Статус: ⏳ (проверено 30.10.2026)', ''), 'utf8')
    const result = run(['check', '--file', backlogFile, '--done', doneFile])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/нет строки «Статус/)
  })

  it('check отдаёт 1, если осталась строка ✅', () => {
    writeFileSync(
      backlogFile,
      BACKLOG.replace('## 🟡 Открытые (P1)', '## ✅ BLK-03 — Старое — ЗАКРЫТО 29.10.2026\n\n## 🟡 Открытые (P1)'),
      'utf8',
    )
    const result = run(['check', '--file', backlogFile, '--done', doneFile])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/устаревший формат/)
  })

  it('close удаляет пункт и не пишет ✅', () => {
    const result = run([
      'close',
      '--id',
      'BLK-01',
      '--ref',
      'разд. 1',
      '--date',
      '30.10.2026',
      '--file',
      backlogFile,
      '--done',
      doneFile,
    ])
    expect(result.status).toBe(1) // в журнале нет ID BLK-01
    expect(result.stderr).toMatch(/ID «BLK-01»/)

    writeFileSync(doneFile, '30.10.2026. BLK-01 — запись журнала', 'utf8')
    const ok = run([
      'close',
      '--id',
      'BLK-01',
      '--ref',
      'разд. 1',
      '--date',
      '30.10.2026',
      '--file',
      backlogFile,
      '--done',
      doneFile,
    ])
    expect(ok.status).toBe(0)
    const text = readFileSync(backlogFile, 'utf8')
    expect(text).not.toContain('BLK-01')
    expect(text).not.toContain('✅')
  })

  it('close отдаёт 1, если даты нет в журнале', () => {
    writeFileSync(doneFile, 'без даты', 'utf8')
    const result = run([
      'close',
      '--id',
      'BLK-01',
      '--date',
      '30.10.2026',
      '--file',
      backlogFile,
      '--done',
      doneFile,
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/сначала развёрнутая запись/)
  })

  it('open добавляет пункт, --dry-run не меняет файл', () => {
    const before = readFileSync(backlogFile, 'utf8')
    const result = run([
      'open',
      '--id',
      'DOC-01',
      '--title',
      'Новый',
      '--date',
      '30.10.2026',
      '--file',
      backlogFile,
      '--done',
      doneFile,
    ])
    expect(result.status).toBe(0)
    expect(readFileSync(backlogFile, 'utf8')).toContain('### DOC-01 — Новый')

    const dry = run([
      'open',
      '--id',
      'DOC-02',
      '--title',
      'Сухой',
      '--dry-run',
      '--file',
      backlogFile,
      '--done',
      doneFile,
    ])
    expect(dry.status).toBe(0)
    expect(readFileSync(backlogFile, 'utf8')).not.toContain('DOC-02')
    expect(readFileSync(backlogFile, 'utf8')).toContain('DOC-01')
    expect(before).not.toContain('DOC-01')
  })

  it('--help отдаёт 0, неизвестная команда — 2', () => {
    expect(run(['--help']).status).toBe(0)
    expect(run(['nope']).status).toBe(2)
  })
})

describe('дата', () => {
  it('печатает ДД.ММ.ГГГГ', () => {
    expect(today(new Date(2026, 9, 30))).toBe('30.10.2026')
    expect(today(new Date(2026, 0, 5))).toBe('05.01.2026')
  })
})
