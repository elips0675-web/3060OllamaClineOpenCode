import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_OUTPUT_BYTES,
  codeFiles,
  collectSymbols,
  parseArgs,
  renderSymbols,
  scanSource,
} from './symbols.mjs'

const SCRIPT = path.join(import.meta.dirname, 'symbols.mjs')

const write = (root, rel, content) => {
  const target = path.join(root, rel)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

let root

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'symbols-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanSource', () => {
  it('находит экспорты всех форм', () => {
    const text = [
      'export const a = 1',
      'export function b() {}',
      'export async function c() {}',
      'export class D {}',
      'export interface E {}',
      'export type F = string',
      'export enum G { X }',
      'export default class H {}',
    ].join('\n')
    const result = scanSource(text)
    expect(result.exports).toEqual(['a', 'b', 'c', 'D', 'E', 'F', 'G', 'H'])
  })

  it('разбирает export { … } и export * from', () => {
    const result = scanSource(
      ["export { x, y as z } from './m.js'", "export * from './other.js'"].join('\n'),
    )
    expect(result.exports).toContain('x')
    expect(result.exports).toContain('y')
    expect(result.exports).toContain('from ./other.js')
  })

  it('находит функции: объявление, стрелку, async-стрелку, тип в const', () => {
    const result = scanSource(
      [
        'function plain() {}',
        'export const arrow = (a) => a',
        'const asyncArrow = async (a) => a',
        'const typed: Handler = (req) => req',
      ].join('\n'),
    )
    expect(result.functions).toEqual(['plain', 'arrow', 'asyncArrow', 'typed'])
  })

  it('ловит роуты app/router/fastify и не ловит map.get', () => {
    const text = [
      "app.get('/api/users', handler)",
      "usersRouter.post('/api/users', handler)",
      "fastify.delete('/api/users/:id', handler)",
      "map.get('key')",
      "app.use('/static', express.static('public'))",
    ].join('\n')
    const result = scanSource(text)
    expect(result.routes).toEqual([
      'GET /api/users',
      'POST /api/users',
      'DELETE /api/users/:id',
      'USE /static',
    ])
  })

  it('находит CommonJS-экспорты', () => {
    const result = scanSource(
      [
        'module.exports = { alpha, beta }',
        'exports.gamma = 1',
        'module.exports.delta = 2',
      ].join('\n'),
    )
    expect(result.exports).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('пропускает закомментированные строки', () => {
    const result = scanSource(["// export const hidden = 1", '/* export const also = 2 */'].join('\n'))
    expect(result).toBeNull()
  })

  it('возвращает null, если символов нет', () => {
    expect(scanSource('const value = 1\n')).toBeNull()
  })
})

describe('codeFiles', () => {
  it('берёт только src/ и server/src/, пропускает шум и чужие каталоги', () => {
    write(root, 'src/App.tsx', 'export const App = 1\n')
    write(root, 'server/src/index.js', 'export const server = 1\n')
    write(root, 'scripts/tool.mjs', 'export const tool = 1\n')
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    write(root, 'dist/bundle.js', 'export const bundle = 1\n')
    write(root, 'src/readme.md', '# not code\n')

    const result = codeFiles(root)
    expect(result.files).toEqual(['server/src/index.js', 'src/App.tsx'])
    expect(result.fallback).toBe(false)
  })

  it('ставит тестовые файлы в конец среза', () => {
    write(root, 'src/a.test.ts', 'export const t = 1\n')
    write(root, 'src/b.ts', 'export const b = 1\n')
    expect(codeFiles(root).files).toEqual(['src/b.ts', 'src/a.test.ts'])
  })

  it('без src/ и server/src/ снимает срез по всему проекту', () => {
    write(root, 'lib/util.js', 'export const util = 1\n')
    write(root, 'node_modules/x/y.js', 'export const y = 1\n')

    const result = codeFiles(root)
    expect(result.files).toEqual(['lib/util.js'])
    expect(result.fallback).toBe(true)
  })
})

describe('collectSymbols', () => {
  it('считает итоги и уважает --limit', () => {
    for (let i = 0; i < 5; i += 1) {
      write(root, `src/f${i}.ts`, `export const value${i} = ${i}\n`)
    }
    const result = collectSymbols(root, { limit: 3 })
    expect(result.totals.files).toBe(5)
    expect(result.files).toHaveLength(3)
    expect(result.skipped).toBe(2)
    expect(result.totals.exports).toBe(3)
  })

  it('пропускает файлы без символов', () => {
    write(root, 'src/empty.ts', 'const local = 1\n')
    write(root, 'src/real.ts', 'export const real = 1\n')
    const result = collectSymbols(root)
    expect(result.files.map((item) => item.path)).toEqual(['src/real.ts'])
  })
})

describe('renderSymbols', () => {
  it('печатает шапку, файлы и честную сноску', () => {
    write(root, 'src/real.ts', 'export const real = 1\n')
    const text = renderSymbols(collectSymbols(root))
    expect(text).toContain('Индекс символов:')
    expect(text).toContain('src/real.ts')
    expect(text).toContain('export: real')
    expect(text).toContain('не доказательство')
  })

  it('держит вывод в бюджете 5 КБ', () => {
    for (let i = 0; i < 120; i += 1) {
      const names = Array.from({ length: 6 }, (_, n) => `export const value${i}_${n} = 1`).join('\n')
      write(root, `src/deep/dir${i}/file${i}.ts`, `${names}\n`)
    }
    const text = renderSymbols(collectSymbols(root, { limit: 120 }))
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 400)
    expect(text).toContain('обрезано')
  })
})

describe('parseArgs', () => {
  it('по умолчанию берёт текущий каталог и лимит 60', () => {
    const args = parseArgs([], 'C:\\work')
    expect(args.root).toBe(path.resolve('C:\\work'))
    expect(args.limit).toBe(60)
    expect(args.json).toBe(false)
  })

  it('понимает формы --key=value', () => {
    const args = parseArgs(['--root=D:\\p', '--out=x.txt', '--limit=5', '--json'])
    expect(args.root).toBe(path.resolve('D:\\p'))
    expect(args.out).toBe('x.txt')
    expect(args.limit).toBe(5)
    expect(args.json).toBe(true)
  })

  it('ругается на неизвестный аргумент и плохой limit', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестный аргумент/u)
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/u)
    expect(() => parseArgs(['--root'])).toThrow(/--root/u)
  })
})

describe('CLI', () => {
  it('пишет индекс в --out и выходит с кодом 0', () => {
    write(root, 'src/a.ts', 'export const a = 1\n')
    const out = path.join(root, 'symbols.txt')
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('export: a')
  })

  it('на несуществующем каталоге выходит с кодом 2', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--root', path.join(root, 'nope')], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('Нет такого каталога')
  })
})
