import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  KIT_ROOT,
  PROFILES,
  baseOpencodeConfig,
  clineDbCandidates,
  clinePatch,
  looksLikeProject,
  matchProfile,
  mergeOpencodeConfig,
  modelAvailability,
  parseArgs,
  pickTag,
  resolveOpencodeModel,
  verifyProfileState,
} from './ai-profile.mjs'

describe('профили', () => {
  it('содержит все документированные профили', () => {
    expect(Object.keys(PROFILES)).toEqual([
      'local',
      'local7',
      'local-q5',
      'local14-hq',
      'cloud',
      'cloud-ollama',
    ])
  })

  it('держит контекст из Modelfile', () => {
    expect(PROFILES.local.cline.ctx).toBe(12288)
    expect(PROFILES.local7.cline.ctx).toBe(16384)
    expect(PROFILES['local-q5'].cline.ctx).toBe(16384)
    expect(PROFILES['local14-hq'].cline.ctx).toBe(16384)
    expect(PROFILES.cloud.cline.ctx).toBe(32768)
  })

  it('локальные профили указывают сборки комплекта', () => {
    expect(PROFILES.local.cline.model).toBe('swiftmatch-coder-14b')
    expect(PROFILES['local-q5'].cline.model).toBe('swiftmatch-coder-7b-q5')
    expect(PROFILES['local-q5'].opencode.ollamaModel).toBe('swiftmatch-coder-7b-q5')
  })

  it('облачный профиль ведёт OpenCode в бесплатную модель', () => {
    expect(PROFILES.cloud.opencode.model).toBe('opencode/deepseek-v4.1-flash-free')
    expect(PROFILES['cloud-ollama'].opencode.model).toBe('ollama/gpt-oss:120b-cloud')
  })
})

describe('аргументы', () => {
  it('по умолчанию берёт текущий каталог', () => {
    const args = parseArgs([], {}, 'D:\\work\\project')
    expect(args.root).toBe(path.resolve('D:\\work\\project'))
    expect(args.rootGiven).toBe(false)
  })

  it('понимает --root и --root=', () => {
    expect(parseArgs(['--root', 'D:\\a b'], {}, 'C:\\x').root).toBe(path.resolve('D:\\a b'))
    expect(parseArgs(['--root=D:\\c'], {}, 'C:\\x').root).toBe(path.resolve('D:\\c'))
    expect(parseArgs(['--root', 'D:\\p'], {}, 'C:\\x').rootGiven).toBe(true)
  })

  it('разделяет флаги и позиционные аргументы', () => {
    const args = parseArgs(['cloud', '--dry-run', '--opencode-only'], {}, 'C:\\x')
    expect(args.positional).toEqual(['cloud'])
    expect(args.flags.has('--dry-run')).toBe(true)
    expect(args.flags.has('--opencode-only')).toBe(true)
  })

  it('берёт корень из AI_PROJECT_ROOT', () => {
    const args = parseArgs(['status'], { AI_PROJECT_ROOT: 'D:\\env-project' }, 'C:\\x')
    expect(args.root).toBe(path.resolve('D:\\env-project'))
    expect(args.rootGiven).toBe(true)
  })

  it('падает без значения у --root', () => {
    expect(() => parseArgs(['--root'], {}, 'C:\\x')).toThrow(/--root/)
  })
})

describe('точный ID модели', () => {
  it('подставляет :latest для сборок без тега', () => {
    expect(pickTag('swiftmatch-coder-14b', ['swiftmatch-coder-14b:latest'])).toBe(
      'swiftmatch-coder-14b:latest',
    )
    expect(pickTag('swiftmatch-coder-7b-q5', null)).toBe('swiftmatch-coder-7b-q5:latest')
  })

  it('не трогает имя, если тег уже есть', () => {
    expect(pickTag('gpt-oss:120b-cloud', [])).toBe('gpt-oss:120b-cloud')
    expect(pickTag('', [])).toBe('')
  })

  it('собирает ID для OpenCode', () => {
    expect(resolveOpencodeModel(PROFILES.local, ['swiftmatch-coder-14b:latest'])).toBe(
      'ollama/swiftmatch-coder-14b:latest',
    )
    expect(resolveOpencodeModel(PROFILES.cloud, [])).toBe('opencode/deepseek-v4.1-flash-free')
  })
})

describe('opencode.json', () => {
  it('базовая конфигурация описывает сборки и облачный тег', () => {
    const base = baseOpencodeConfig()
    expect(base.providers.ollama.models['swiftmatch-coder-14b:latest'].limit.context).toBe(12288)
    expect(base.providers.ollama.models['swiftmatch-coder-7b-q5:latest']).toBeDefined()
    expect(base.providers.ollama.models['gpt-oss:120b-cloud']).toBeDefined()
    expect(base.agents.local.permissions[0]).toEqual({
      action: 'webfetch',
      resource: '*',
      effect: 'deny',
    })
  })

  it('мержит, а не заменяет: instructions и чужие ключи на месте', () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      theme: 'dark',
      instructions: ['.opencode/persona.md', 'AGENTS.md'],
      providers: { other: { models: { custom: {} } } },
      agents: { local: { description: 'своё описание', steps: 5 } },
    }

    const next = mergeOpencodeConfig(PROFILES.cloud, existing)

    expect(next.instructions).toEqual(['.opencode/persona.md', 'AGENTS.md'])
    expect(next.theme).toBe('dark')
    expect(next.providers.other).toEqual({ models: { custom: {} } })
    expect(next.model).toBe('opencode/deepseek-v4.1-flash-free')
    expect(next.default_agent).toBe('cloud')

    // правки пользователя сохраняются, недостающее из шаблона добавляется
    expect(next.agents.local.description).toBe('своё описание')
    expect(next.agents.local.steps).toBe(5)
    expect(next.agents.local.permissions).toHaveLength(2)
    expect(next.agents.cloud.mode).toBe('primary')
  })

  it('не теряет deprecated agent: V2-блок имеет приоритет, но старый цел', () => {
    const existing = {
      agent: { local: { description: 'старый V1-блок' } },
    }
    const next = mergeOpencodeConfig(PROFILES.local, existing)
    expect(next.agent).toEqual({ local: { description: 'старый V1-блок' } })
    expect(next.agents.local.description).toContain('3060')
  })
})

describe('cline', () => {
  it('пишет провайдера, модель, base URL и контекст', () => {
    const patch = clinePatch(PROFILES['local-q5'], 'http://localhost:11434')
    expect(patch.apiProvider).toBe('ollama')
    expect(patch.ollamaModelId).toBe('swiftmatch-coder-7b-q5')
    expect(patch.ollamaBaseUrl).toBe('http://localhost:11434')
    expect(patch.ollamaApiOptionsCtxNum).toBe('16384')
    expect(patch.planModeOllamaModelId).toBe('swiftmatch-coder-7b-q5')
    expect(patch.actModeApiModelId).toBe('swiftmatch-coder-7b-q5')
  })

  it('находит базу stable и Insiders', () => {
    const paths = clineDbCandidates({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })
    expect(paths).toHaveLength(2)
    expect(paths[0]).toContain(path.join('Code', 'User', 'globalStorage', 'state.vscdb'))
    expect(paths[1]).toContain('Code - Insiders')
    expect(clineDbCandidates({ CLINE_STATE_DB: 'D:\\state.vscdb' })).toEqual(['D:\\state.vscdb'])
  })
})

describe('определение профиля и наличия моделей', () => {
  it('узнаёт профиль по паре model/default_agent', () => {
    expect(
      matchProfile({
        opencodeModel: 'ollama/swiftmatch-coder-14b:latest',
        clineModel: 'swiftmatch-coder-14b',
      }),
    ).toBe('local')
    expect(
      matchProfile({
        opencodeModel: 'ollama/swiftmatch-coder-7b-q5:latest',
        clineModel: 'swiftmatch-coder-7b-q5',
      }),
    ).toBe('local-q5')
    expect(
      matchProfile({
        opencodeModel: 'opencode/deepseek-v4.1-flash-free',
        clineModel: 'gpt-oss:120b-cloud',
      }),
    ).toBe('cloud')
    expect(
      matchProfile({
        opencodeModel: 'ollama/gpt-oss:120b-cloud',
        clineModel: 'gpt-oss:120b-cloud',
      }),
    ).toBe('cloud-ollama')
  })

  it('не угадывает при неполном совпадении', () => {
    expect(matchProfile({ opencodeModel: 'ollama/none:latest' })).toBeNull()
    expect(matchProfile({})).toBeNull()
  })

  it('показывает, какие сборки уже в Ollama', () => {
    const rows = modelAvailability(['swiftmatch-coder-14b:latest'])
    const local = rows.find((r) => r.profile === 'local')
    const q5 = rows.find((r) => r.profile === 'local-q5')
    const cloud = rows.find((r) => r.profile === 'cloud-ollama')
    expect(local.installed).toBe(true)
    expect(q5.installed).toBe(false)
    expect(cloud.cloud).toBe(true)
    expect(cloud.installed).toBeNull()
  })
})

describe('корень проекта', () => {
  it('отличает проект от служебного каталога', () => {
    expect(looksLikeProject(KIT_ROOT)).toBe(true) // package.json
    expect(looksLikeProject(path.join(KIT_ROOT, 'scripts'))).toBe(false)
  })
})

describe('запись Cline (интеграция, без живого VS Code)', () => {
  it('пишет профиль в отдельную state.vscdb и делает бэкап', async () => {
    let sqlite
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return // Node без node:sqlite: тест неприменим, отдельный тест уже проверяет warn
    }
    const Database = sqlite.Database || sqlite.DatabaseSync

    const tmp = mkdtempSync(path.join(tmpdir(), 'ai-profile-cline-'))
    const project = path.join(tmp, 'project')
    mkdirSync(project)
    writeFileSync(
      path.join(project, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
      'utf8',
    )

    const dbFile = path.join(tmp, 'state.vscdb')
    const db = new Database(dbFile)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    const before = {
      apiProvider: 'openrouter',
      apiModelId: 'old/model',
      autoApprovalEnabled: true,
    }
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'saoudrizwan.claude-dev',
      Buffer.from(JSON.stringify(before), 'utf8'),
    )
    db.close()

    const script = path.join(KIT_ROOT, 'scripts', 'ai-profile.mjs')
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', script, 'local-q5', '--root', project, '--cline-only', '--force'],
      { encoding: 'utf8', env: { ...process.env, CLINE_STATE_DB: dbFile }, timeout: 30000 },
    )

    try {
      expect(result.status, result.stderr || result.stdout).toBe(0)

      const check = new Database(dbFile)
      const row = check.prepare('SELECT value FROM ItemTable WHERE key = ?').get(
        'saoudrizwan.claude-dev',
      )
      check.close()
      const saved = JSON.parse(Buffer.from(row.value).toString('utf8'))

      expect(saved.apiProvider).toBe('ollama')
      expect(saved.ollamaModelId).toBe('swiftmatch-coder-7b-q5')
      expect(saved.ollamaApiOptionsCtxNum).toBe('16384')
      expect(saved.actModeApiModelId).toBe('swiftmatch-coder-7b-q5')
      // настройки, которых нет в патче, не теряются
      expect(saved.autoApprovalEnabled).toBe(true)

      const backups = readdirSync(tmp).filter((name) => name.startsWith('state.vscdb.bak-'))
      expect(backups).toHaveLength(1)
      // opencode.json не тронут: был --cline-only
      expect(readFileSync(path.join(project, 'opencode.json'), 'utf8')).toBe(
        JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('сверка профиля (verify, только чтение)', () => {
  const profile = PROFILES['local-q5']

  it('считает совпадением localhost и 127.0.0.1 в base URL', () => {
    const cline = { ...clinePatch(profile), ollamaBaseUrl: 'http://localhost:11434/' }
    const result = verifyProfileState(profile, { cline })

    expect(result.failed).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('показывает расхождение по модели и контексту', () => {
    const cline = { ...clinePatch(profile), ollamaModelId: 'servicedesk-qwen', ollamaApiOptionsCtxNum: '8192' }
    const result = verifyProfileState(profile, { cline })
    const names = result.failed.map((row) => row.name)

    expect(result.ok).toBe(false)
    expect(names).toContain('ollamaModelId')
    expect(names).toContain('ollamaApiOptionsCtxNum')
    expect(result.failed.find((row) => row.name === 'ollamaModelId').expected).toBe(
      'swiftmatch-coder-7b-q5',
    )
  })

  it('сверяет opencode.json с точным тегом и агентом', () => {
    const opencode = { model: 'ollama/swiftmatch-coder-7b-q5:latest', default_agent: 'local' }
    const tags = ['swiftmatch-coder-7b-q5:latest']
    const ok = verifyProfileState(profile, { cline: clinePatch(profile), opencode, tags })
    const bad = verifyProfileState(profile, {
      cline: clinePatch(profile),
      opencode: { model: 'ollama/swiftmatch-coder-14b:latest', default_agent: 'cloud' },
      tags,
    })

    expect(ok.ok).toBe(true)
    expect(bad.failed.map((row) => `${row.scope}.${row.name}`)).toEqual([
      'opencode.model',
      'opencode.default_agent',
    ])
  })

  it('через CLI: exit 0 после переключения и exit 1 на чужом состоянии', async () => {
    let sqlite
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return // Node без node:sqlite: интеграция неприменима
    }
    const Database = sqlite.Database || sqlite.DatabaseSync

    const tmp = mkdtempSync(path.join(tmpdir(), 'ai-profile-verify-'))
    const project = path.join(tmp, 'project')
    mkdirSync(project)
    writeFileSync(
      path.join(project, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
      'utf8',
    )

    const dbFile = path.join(tmp, 'state.vscdb')
    const db = new Database(dbFile)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'saoudrizwan.claude-dev',
      Buffer.from(JSON.stringify({ apiModelId: 'servicedesk-qwen', ollamaModelId: 'servicedesk-qwen' }), 'utf8'),
    )
    db.close()

    const script = path.join(KIT_ROOT, 'scripts', 'ai-profile.mjs')
    const env = { ...process.env, CLINE_STATE_DB: dbFile, OLLAMA_URL: 'http://127.0.0.1:1' }
    const run = (...args) =>
      spawnSync(process.execPath, ['--no-warnings', script, ...args, '--root', project], {
        encoding: 'utf8',
        env,
        timeout: 30000,
      })

    try {
      const mismatch = run('verify', 'local-q5')
      expect(mismatch.status, mismatch.stderr || mismatch.stdout).toBe(1)
      expect(mismatch.stdout).toContain('servicedesk-qwen')

      const applied = run('local-q5', '--force')
      expect(applied.status, applied.stderr || applied.stdout).toBe(0)

      const match = run('verify', 'local-q5')
      expect(match.status, match.stderr || match.stdout).toBe(0)
      expect(match.stdout).toContain('совпадает с профилем local-q5')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
