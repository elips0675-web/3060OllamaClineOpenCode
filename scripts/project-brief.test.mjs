import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  collectBrief,
  detectEntryPoints,
  isConfigFile,
  isDbFile,
  isNoiseDir,
  isRouteFile,
  isTestFile,
  parseArgs,
  renderBrief,
  walkFiles,
} from './project-brief.mjs'

const SCRIPT = path.join(import.meta.dirname, 'project-brief.mjs')

const write = (root, rel, content) => {
  const target = path.join(root, rel)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

// Мини-проект, в котором у каждого списка брифа есть ровно один очевидный ответ.
function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'brief-'))
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      main: 'src/main.js',
      scripts: { test: 'vitest' },
      dependencies: { express: '^4' },
      devDependencies: { vitest: '^1' },
    }),
  )
  write(root, 'src/main.js', '// TODO: подключить роуты\nconst value: any = 1\n// FIXME: убрать\n')
  write(root, 'src/routes/users.js', 'export const users = []\n')
  write(root, 'src/routes/users.test.js', "import { users } from './users.js'\n")
  write(root, 'src/db/schema.prisma', 'model User { id Int @id }\n')
  write(root, 'db/migrations/001_init.sql', 'create table users (id int);\n')
  write(root, 'tsconfig.json', '{ "compilerOptions": {} }\n')
  write(root, 'big.js', `// ${'x'.repeat(3000)}\n`)
  // Шум: не должен попасть ни в списки, ни в счётчики.
  write(root, 'node_modules/junk/index.js', '// TODO: из зависимости\n')
  write(root, 'dist/bundle.js', '// TODO: из сборки\n')
  write(root, '.git/config', '[core]\n')
  return root
}

let root

beforeEach(() => {
  root = makeProject()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('обход дерева', () => {
  it('пропускает служебные каталоги', () => {
    const paths = walkFiles(root).map((file) => file.path)
    expect(paths).toContain('src/main.js')
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false)
  })

  it('отдаёт posix-пути и детерминированный порядок', () => {
    const first = walkFiles(root).map((file) => file.path)
    const second = walkFiles(root).map((file) => file.path)
    expect(first).toEqual(second)
    expect(first).toEqual([...first].sort())
    expect(first.every((p) => !p.includes('\\'))).toBe(true)
  })

  it('знает имена шумных каталогов', () => {
    expect(isNoiseDir('node_modules')).toBe(true)
    expect(isNoiseDir('NODE_MODULES')).toBe(true)
    expect(isNoiseDir('.git')).toBe(true)
    expect(isNoiseDir('src')).toBe(false)
  })
})

describe('классификация файлов', () => {
  it('находит точки входа из package.json и по имени', () => {
    expect(detectEntryPoints(walkFiles(root).map((file) => ({ path: file.path, size: 0 })), {
      main: 'src/main.js',
    })).toEqual(['src/main.js'])
  })

  it('различает тесты, роуты, БД и конфиги', () => {
    expect(isTestFile('src/routes/users.test.js')).toBe(true)
    expect(isTestFile('tests/users.js')).toBe(true)
    expect(isTestFile('src/users.js')).toBe(false)

    expect(isRouteFile('src/routes/users.js')).toBe(true)
    expect(isRouteFile('src/pages/api/health.ts')).toBe(true)
    expect(isRouteFile('src/models/user.js')).toBe(false)

    expect(isDbFile('db/migrations/001_init.sql')).toBe(true)
    expect(isDbFile('src/db/schema.prisma')).toBe(true)
    expect(isDbFile('src/models/user.js')).toBe(true)
    expect(isDbFile('models/Modelfile-7b-q5')).toBe(false)
    expect(isDbFile('src/main.js')).toBe(false)

    expect(isConfigFile('tsconfig.json')).toBe(true)
    expect(isConfigFile('vite.config.ts')).toBe(true)
    expect(isConfigFile('.env.example')).toBe(true)
    expect(isConfigFile('src/main.js')).toBe(false)
  })
})

describe('сбор фактов', () => {
  it('наполняет списки без шума', () => {
    const brief = collectBrief(root)
    expect(brief.package.name).toBe('demo')
    expect(brief.package.dependencies).toEqual(['express'])
    expect(brief.entry).toEqual(['src/main.js'])
    expect(brief.routes).toContain('src/routes/users.js')
    expect(brief.routes.some((p) => p.startsWith('node_modules/'))).toBe(false)
    expect(brief.db).toEqual(['db/migrations/001_init.sql', 'src/db/schema.prisma'])
    expect(brief.tests).toEqual(['src/routes/users.test.js'])
    expect(brief.testsTotal).toBe(1)
    expect(brief.configs).toContain('tsconfig.json')
  })

  it('считает маркеры только в коде и только реальные', () => {
    const { markers } = collectBrief(root)
    expect(markers.TODO).toBe(1)
    expect(markers.FIXME).toBe(1)
    expect(markers.any).toBe(1)
    expect(markers.scanned).toBeGreaterThan(0)
  })

  it('сортирует крупные файлы по размеру', () => {
    const brief = collectBrief(root)
    expect(brief.largest[0].path).toBe('big.js')
    expect(brief.largest[0].bytes).toBeGreaterThan(3000)
  })

  it('уважает --limit', () => {
    const brief = collectBrief(root, { limit: 1 })
    expect(brief.largest).toHaveLength(1)
    expect(brief.configs).toHaveLength(1)
  })

  it('переживает каталог без package.json', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'brief-bare-'))
    try {
      write(bare, 'main.py', 'print(1)\n')
      const brief = collectBrief(bare)
      expect(brief.package).toBeNull()
      expect(brief.filesTotal).toBe(1)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('текстовый отчёт', () => {
  it('печатает факты и прямо говорит, что доказательством не является', () => {
    const text = renderBrief(collectBrief(root))
    expect(text).toContain('PROJECT BRIEF')
    expect(text).toContain('package: demo 1.0.0')
    expect(text).toContain('entry: src/main.js')
    expect(text).toContain('не доказательство')
    expect(text).toMatch(/каждое утверждение подкрепи file:line/i)
  })
})

describe('аргументы', () => {
  it('по умолчанию берёт текущий каталог', () => {
    const args = parseArgs([], 'D:\\work\\project')
    expect(args.root).toBe(path.resolve('D:\\work\\project'))
    expect(args.limit).toBe(20)
    expect(args.json).toBe(false)
  })

  it('понимает --root, --out, --json и --limit', () => {
    const args = parseArgs(['--root', 'D:\\a b', '--out', 'tmp\\b.txt', '--json', '--limit', '5'])
    expect(args.root).toBe(path.resolve('D:\\a b'))
    expect(args.out).toBe('tmp\\b.txt')
    expect(args.json).toBe(true)
    expect(args.limit).toBe(5)
  })

  it('понимает форму --key=value', () => {
    const args = parseArgs(['--root=D:\\c', '--out=x.txt', '--limit=3'])
    expect(args.root).toBe(path.resolve('D:\\c'))
    expect(args.out).toBe('x.txt')
    expect(args.limit).toBe(3)
  })

  it('падает без значения у --root и на плохом --limit', () => {
    expect(() => parseArgs(['--root'])).toThrow(/--root/)
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/)
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(/--limit/)
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестный/)
  })
})

describe('CLI', () => {
  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 30000,
    })

  it('печатает JSON по --json', () => {
    const result = run(['--root', root, '--json'])
    expect(result.status).toBe(0)
    const brief = JSON.parse(result.stdout)
    expect(brief.package.name).toBe('demo')
    expect(brief.entry).toContain('src/main.js')
  })

  it('пишет бриф в файл по --out', () => {
    const target = path.join(root, 'brief.txt')
    const result = run(['--root', root, '--out', target])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Бриф записан')
    const text = readFileSync(target, 'utf8')
    expect(text).toContain('PROJECT BRIEF')
  })

  it('отдаёт справку без ошибки', () => {
    const result = run(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--root')
  })

  it('возвращает 2 на несуществующий каталог и плохой аргумент', () => {
    const missing = run(['--root', path.join(root, 'nope')])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toMatch(/Нет такого каталога/)

    const bad = run(['--nope'])
    expect(bad.status).toBe(2)
    expect(bad.stderr).toMatch(/неизвестный аргумент/)
  })
})
