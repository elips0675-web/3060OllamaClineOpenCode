import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  IGNORED_UNTRACKED,
  LIMITS,
  PREFLIGHT_LIMITS,
  classify,
  decodeGitPath,
  hasRepo,
  parseNumstat,
  parsePorcelain,
  renderReport,
  summarize,
  verdictOf,
} from './retention-gate.mjs'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'retention-'))

describe('decodeGitPath', () => {
  it('раскрывает восьмеричные байты, которые git отдаёт для не-ASCII', () => {
    expect(decodeGitPath('\\320\\226\\320\\275')).toBe('Жн')
  })

  it('оставляет обычный путь как есть', () => {
    expect(decodeGitPath('scripts/next-task.mjs')).toBe('scripts/next-task.mjs')
  })

  it('понимает экранированные кавычку и обратный слэш', () => {
    expect(decodeGitPath('a\\\\b')).toBe('a\\b')
  })
})

describe('parsePorcelain', () => {
  it('различает изменённые и untracked файлы', () => {
    const entries = parsePorcelain(' M scripts/next-task.mjs\n?? test/new.txt\n')
    expect(entries).toEqual([
      { status: ' M', file: 'scripts/next-task.mjs', untracked: false },
      { status: '??', file: 'test/new.txt', untracked: true },
    ])
  })

  it('для переименования берёт новое имя', () => {
    const entries = parsePorcelain('R  old.txt -> new.txt\n')
    expect(entries[0].file).toBe('new.txt')
  })

  it('пропускает пустые строки и снимает CR', () => {
    expect(parsePorcelain('\n M a.txt\r\n\n')).toHaveLength(1)
  })
})

describe('parseNumstat', () => {
  it('складывает добавленные и удалённые строки по файлам', () => {
    const stat = parseNumstat('3\t1\ta.mjs\n5\t0\tb.mjs\n')
    expect(stat.added).toBe(8)
    expect(stat.removed).toBe(1)
    expect(stat.perFile.get('b.mjs')).toEqual({ added: 5, removed: 0 })
  })

  it('бинарный файл считается нулём строк, а не NaN', () => {
    const stat = parseNumstat('-\t-\timage.png\n')
    expect(stat.perFile.get('image.png')).toEqual({ added: 0, removed: 0 })
    expect(stat.added).toBe(0)
  })
})

describe('classify и summarize', () => {
  const numstat = parseNumstat('10\t2\ta.mjs\n')

  it('untracked считается по числу строк файла', () => {
    const entries = parsePorcelain(' M a.mjs\n?? новый.txt\n')
    const { tracked, untracked } = classify(entries, numstat, () => 20)
    const summary = summarize(tracked, untracked)
    expect(summary.files).toBe(2)
    expect(summary.lines).toBe(32)
    expect(summary.ignoredFiles).toBe(0)
  })

  it('файл из IGNORED_UNTRACKED считается проигнорированным', () => {
    const draft = IGNORED_UNTRACKED[0]
    const withDraft = parsePorcelain(` M a.mjs\n?? ${draft}\n`)
    const { tracked, untracked } = classify(withDraft, numstat, () => 40)
    const summary = summarize(tracked, untracked)
    expect(summary.ignoredFiles).toBe(1)
    expect(summary.files).toBe(1)
    expect(summary.lines).toBe(12)
  })
})

describe('verdictOf', () => {
  it('зелёный, когда окно в пределах лимита', () => {
    expect(verdictOf({ files: LIMITS.files, lines: LIMITS.lines }).exit).toBe(0)
  })

  it('красный по файлам и по строкам отдельно', () => {
    const byFiles = verdictOf({ files: LIMITS.files + 1, lines: 10 })
    expect(byFiles.exit).toBe(1)
    expect(byFiles.red[0]).toContain('файлов')
    const byLines = verdictOf({ files: 1, lines: LIMITS.lines + 1 })
    expect(byLines.red[0]).toContain('строк')
  })

  it('preflight прощает больше файлов, чем строгий режим', () => {
    const summary = { files: LIMITS.files + 2, lines: 100 }
    expect(verdictOf(summary, LIMITS).exit).toBe(1)
    expect(verdictOf(summary, PREFLIGHT_LIMITS).exit).toBe(0)
  })
})

describe('renderReport', () => {
  const summary = { files: 9, lines: 400, trackedFiles: 7, untrackedFiles: 2, ignoredFiles: 0 }
  const verdict = verdictOf(summary)

  it('на красном окне печатает требование микрокоммита', () => {
    const report = renderReport(summary, verdict, [], [])
    expect(report).toContain('ОКНО СЛИШКОМ БОЛЬШОЕ')
    expect(report).toContain('git add поимённо')
  })

  it('на зелёном окне не пугает и печатает порог', () => {
    const ok = { files: 1, lines: 5, trackedFiles: 1, untrackedFiles: 0, ignoredFiles: 0 }
    const report = renderReport(ok, verdictOf(ok), [], [])
    expect(report).toContain('Окно в норме')
    expect(report).not.toContain('ОКНО СЛИШКОМ БОЛЬШОЕ')
    expect(report).toContain(`Порог: ${LIMITS.files} файлов / ${LIMITS.lines} строк`)
  })

  it('перечисляет проигнорированные черновики', () => {
    const report = renderReport(
      summary,
      verdict,
      [],
      [{ file: 'черновик.txt', lines: 10, ignored: true }]
    )
    expect(report).toContain('Не считается')
    expect(report).toContain('черновик.txt')
  })
})

describe('hasRepo', () => {
  it('в каталоге без .git гейт не применим', () => {
    const dir = tempDir()
    try {
      expect(hasRepo(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('видит .git-каталог и .git-файл рабочего дерева', () => {
    const dir = tempDir()
    try {
      mkdirSync(path.join(dir, '.git'))
      expect(hasRepo(dir)).toBe(true)
      const worktree = tempDir()
      writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n')
      expect(hasRepo(worktree)).toBe(true)
      rmSync(worktree, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
