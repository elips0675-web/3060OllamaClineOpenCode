// Переключение профилей «локально ↔ облако» для Cline (VS Code) и OpenCode.
//
// Скрипт живёт в комплекте, а работает с ПРОЕКТОМ: запускать из корня проекта
// (там, где лежат AGENTS.md и opencode.json) или указать --root <путь>.
//
// Что меняет:
//   OpenCode  — opencode.json: model + default_agent + описания моделей Ollama.
//               Конфиг читается при старте; уже открытая сессия модель не меняет
//               (нужна новая сессия или /models), при сомнении — перезапуск.
//   Cline     — globalState расширения saoudrizwan.claude-dev в state.vscdb
//               (провайдер, модель, base URL, context window).
//               VS Code должен быть закрыт: иначе он перезапишет состояние.
//
// Использование (из корня проекта):
//   node <комплект>\scripts\ai-profile.mjs status
//   node <комплект>\scripts\ai-profile.mjs local
//   node <комплект>\scripts\ai-profile.mjs local-q5
//   node <комплект>\scripts\ai-profile.mjs cloud
//   node <комплект>\scripts\ai-profile.mjs cloud --dry-run
//   node <комплект>\scripts\ai-profile.mjs local --opencode-only
//   node <комплект>\scripts\ai-profile.mjs local --cline-only
//   node <комплект>\scripts\ai-profile.mjs status --root "D:\путь\к\проекту"
//
// То же короче — через switch-ai.bat в корне комплекта.
//
// Переменные окружения (необязательно):
//   AI_PROJECT_ROOT            — корень проекта, если не запускать из него
//   OLLAMA_URL                 — по умолчанию http://127.0.0.1:11434
//   AI_CLOUD_OLLAMA_MODEL      — по умолчанию gpt-oss:120b-cloud
//   AI_CLOUD_OPENCODE_MODEL    — по умолчанию opencode/deepseek-v4.1-flash-free
//   CLINE_STATE_DB             — путь к state.vscdb (для тестов и переносов)

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const KIT_ROOT = path.resolve(SCRIPT_DIR, '..')

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const CLOUD_OLLAMA = process.env.AI_CLOUD_OLLAMA_MODEL || 'gpt-oss:120b-cloud'
const CLOUD_OPENCODE = process.env.AI_CLOUD_OPENCODE_MODEL || 'opencode/deepseek-v4.1-flash-free'
const CLINE_KEY = 'saoudrizwan.claude-dev'

// Имена моделей — из 02-Установить-локально.bat. Cline принимает короткое имя,
// OpenCode показывает сборку как ollama/<имя>:latest, поэтому в профиле храним
// короткое имя и подставляем точный тег из живого /api/tags.
export const PROFILES = {
  local: {
    title: 'локальная 14B Q4_K_M · ctx 12k (основной, офлайн)',
    vram: '~10.1 ГБ',
    cline: { provider: 'ollama', model: 'swiftmatch-coder-14b', ctx: 12288 },
    opencode: {
      model: 'ollama/swiftmatch-coder-14b:latest',
      ollamaModel: 'swiftmatch-coder-14b',
      agent: 'local',
    },
  },
  local7: {
    title: 'локальная 7B Q8_0 · ctx 16k (быстрее, ~7.6 ГБ)',
    vram: '~7.6 ГБ',
    cline: { provider: 'ollama', model: 'swiftmatch-coder-7b', ctx: 16384 },
    opencode: {
      model: 'ollama/swiftmatch-coder-7b:latest',
      ollamaModel: 'swiftmatch-coder-7b',
      agent: 'local',
    },
  },
  'local-q5': {
    title: 'локальная 7B Q5_K_M · ctx 16k (легче Q8, ~5.4 ГБ)',
    vram: '~6.5 ГБ',
    cline: { provider: 'ollama', model: 'swiftmatch-coder-7b-q5', ctx: 16384 },
    opencode: {
      model: 'ollama/swiftmatch-coder-7b-q5:latest',
      ollamaModel: 'swiftmatch-coder-7b-q5',
      agent: 'local',
    },
  },
  'local14-hq': {
    title: 'локальная 14B Q6_K · ctx 16k (только 16 ГБ VRAM)',
    vram: '~13.5 ГБ',
    cline: { provider: 'ollama', model: 'swiftmatch-coder-14b-hq', ctx: 16384 },
    opencode: {
      model: 'ollama/swiftmatch-coder-14b-hq:latest',
      ollamaModel: 'swiftmatch-coder-14b-hq',
      agent: 'local',
    },
  },
  cloud: {
    title: `облако: Cline — Ollama ${CLOUD_OLLAMA}, OpenCode — ${CLOUD_OPENCODE}`,
    vram: '0 ГБ',
    cline: { provider: 'ollama', model: CLOUD_OLLAMA, ctx: 32768 },
    opencode: { model: CLOUD_OPENCODE, agent: 'cloud' },
  },
  'cloud-ollama': {
    title: `облако Ollama в обоих: ${CLOUD_OLLAMA}`,
    vram: '0 ГБ',
    cline: { provider: 'ollama', model: CLOUD_OLLAMA, ctx: 32768 },
    opencode: { model: `ollama/${CLOUD_OLLAMA}`, ollamaModel: CLOUD_OLLAMA, agent: 'cloud' },
  },
}

const PROVIDER_MODELS = [
  { tag: 'swiftmatch-coder-14b', name: 'swiftmatch-coder 14B Q4_K_M · 12k · локально', ctx: 12288 },
  { tag: 'swiftmatch-coder-7b', name: 'swiftmatch-coder 7B Q8_0 · 16k · локально', ctx: 16384 },
  { tag: 'swiftmatch-coder-7b-q5', name: 'swiftmatch-coder 7B Q5_K_M · 16k · локально', ctx: 16384 },
  { tag: 'swiftmatch-coder-14b-hq', name: 'swiftmatch-coder 14B Q6_K · 16k · 16 ГБ VRAM', ctx: 16384 },
  { tag: 'swiftmatch-coder-tiny', name: 'swiftmatch-coder tiny 1.5B · 4k · автодополнение', ctx: 4096 },
  { tag: CLOUD_OLLAMA, name: `${CLOUD_OLLAMA} · Ollama Cloud`, ctx: 131072 },
]

// ---------------------------------------------------------------- аргументы

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const flags = new Set()
  const positional = []
  let root = env.AI_PROJECT_ROOT || cwd
  let rootGiven = Boolean(env.AI_PROJECT_ROOT)

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('--root требует путь к корню проекта')
      root = value
      rootGiven = true
      i += 1
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (!value) throw new Error('--root требует путь к корню проекта')
      root = value
      rootGiven = true
    } else if (arg.startsWith('--')) {
      flags.add(arg)
    } else {
      positional.push(arg)
    }
  }

  return { root: path.resolve(root), rootGiven, flags, positional }
}

export function looksLikeProject(dir) {
  return ['opencode.json', 'opencode.jsonc', 'AGENTS.md', '.opencode', 'package.json'].some((name) =>
    existsSync(path.join(dir, name)),
  )
}

// ---------------------------------------------------------------- opencode.json

const modelKey = (tag) => (tag.includes(':') ? tag : `${tag}:latest`)

export function baseOpencodeConfig() {
  const models = {}
  for (const m of PROVIDER_MODELS) {
    models[modelKey(m.tag)] = {
      name: m.name,
      limit: { context: m.ctx, output: 4096 },
      capabilities: { tools: true, input: ['text'], output: ['text'] },
    }
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    model: PROFILES.local.opencode.model,
    default_agent: 'local',
    providers: { ollama: { models } },
    agents: {
      local: {
        description: '3060: одна узкая правка одного файла, без сети',
        mode: 'primary',
        steps: 10,
        permissions: [
          { action: 'webfetch', resource: '*', effect: 'deny' },
          { action: 'websearch', resource: '*', effect: 'deny' },
        ],
      },
      cloud: {
        description: 'Эскалация: многофайловые задачи, ревью диффа, миграции',
        mode: 'primary',
      },
    },
  }
}

// Мержит, а не заменяет: instructions, чужие провайдеры, агенты и прочие
// ключи проекта остаются на месте. Меняются только model/default_agent и
// описания моделей Ollama (нужны для облачных тегов: их нет в автодискавери).
export function mergeOpencodeConfig(profile, existing) {
  const base = baseOpencodeConfig()
  const cfg = existing && typeof existing === 'object' ? structuredClone(existing) : {}

  cfg.$schema = cfg.$schema || base.$schema

  const providers = { ...(cfg.providers || {}) }
  const ollama = { ...(providers.ollama || {}) }
  ollama.models = { ...base.providers.ollama.models, ...(ollama.models || {}) }
  providers.ollama = ollama
  cfg.providers = providers

  const mergedAgents = { ...base.agents, ...(cfg.agents || {}) }
  cfg.agents = Object.fromEntries(
    Object.entries(mergedAgents).map(([name, value]) => [
      name,
      { ...(base.agents[name] || {}), ...(value || {}) },
    ]),
  )

  cfg.model = profile.opencode.model
  cfg.default_agent = profile.opencode.agent
  return cfg
}

export function pickTag(name, tags) {
  if (!name || name.includes(':')) return name
  if (Array.isArray(tags)) {
    if (tags.includes(name)) return name
    if (tags.includes(`${name}:latest`)) return `${name}:latest`
  }
  return `${name}:latest`
}

export function resolveOpencodeModel(profile, tags) {
  const { ollamaModel, model } = profile.opencode
  if (!ollamaModel) return model
  return `ollama/${pickTag(ollamaModel, tags)}`
}

export function modelAvailability(tags, profiles = PROFILES) {
  const present = new Set(Array.isArray(tags) ? tags : [])
  return Object.entries(profiles).map(([name, p]) => {
    const model = p.opencode.ollamaModel || p.opencode.model
    const cloud = !p.opencode.ollamaModel || p.opencode.ollamaModel.includes(':')
    const installed = cloud
      ? null
      : present.has(model) || present.has(`${model}:latest`)
    return { profile: name, model, cloud, installed }
  })
}

export function matchProfile({ opencodeModel, clineModel }, profiles = PROFILES) {
  const norm = (value) => String(value || '').replace(/^ollama\//, '').replace(/:latest$/, '')
  if (!opencodeModel && !clineModel) return null

  const matches = Object.entries(profiles).filter(([, p]) => {
    const opencodeOk = !opencodeModel || norm(opencodeModel) === norm(p.opencode.model)
    const clineOk = !clineModel || norm(clineModel) === norm(p.cline.model)
    return opencodeOk && clineOk
  })
  return matches.length === 1 ? matches[0][0] : null
}

// ---------------------------------------------------------------- cline

export function clineDbCandidates(env = process.env) {
  if (env.CLINE_STATE_DB) return [env.CLINE_STATE_DB]
  const appData = env.APPDATA || ''
  return [
    path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'),
    path.join(appData, 'Code - Insiders', 'User', 'globalStorage', 'state.vscdb'),
  ]
}

export function clinePatch(profile, ollamaUrl = OLLAMA_URL) {
  const patch = {
    welcomeViewCompleted: true,
    apiProvider: profile.cline.provider,
    apiModelId: profile.cline.model,
    planModeApiProvider: profile.cline.provider,
    actModeApiProvider: profile.cline.provider,
    planModeApiModelId: profile.cline.model,
    actModeApiModelId: profile.cline.model,
    planActSeparateModelsSetting: false,
  }

  if (profile.cline.provider === 'ollama') {
    Object.assign(patch, {
      ollamaModelId: profile.cline.model,
      ollamaBaseUrl: ollamaUrl,
      ollamaApiOptionsCtxNum: String(profile.cline.ctx),
      planModeOllamaModelId: profile.cline.model,
      actModeOllamaModelId: profile.cline.model,
    })
  }
  return patch
}

// ---------------------------------------------------------------- вывод

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

function usage() {
  const bat = path.join(KIT_ROOT, 'switch-ai.bat')
  log(`Профили:
  local         ${PROFILES.local.title}
  local7        ${PROFILES.local7.title}
  local-q5      ${PROFILES['local-q5'].title}
  local14-hq    ${PROFILES['local14-hq'].title}
  cloud         ${PROFILES.cloud.title}
  cloud-ollama  ${PROFILES['cloud-ollama'].title}
  status        показать текущие настройки (по умолчанию)

Флаги:
  --root <путь>    корень проекта (по умолчанию — текущий каталог)
  --dry-run        показать, что изменится, ничего не записывать
  --opencode-only  трогать только opencode.json
  --cline-only     трогать только настройки Cline (VS Code должен быть закрыт)
  --force          писать настройки Cline даже при запущенном VS Code (риск)
  --help           эта справка

Примеры (из корня проекта):
  "${bat}" status
  "${bat}" local
  "${bat}" cloud --dry-run
  node "${path.join(KIT_ROOT, 'scripts', 'ai-profile.mjs')}" status`)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function ollamaTags() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json()
    return (data.models || []).map((m) => m.name)
  } catch {
    return null
  }
}

async function applyOpencode(profile, { root, dryRun }) {
  const file = path.join(root, 'opencode.json')
  const jsonc = path.join(root, 'opencode.jsonc')

  if (existsSync(jsonc) && !existsSync(file)) {
    warn(`✗ Найден ${path.basename(jsonc)}, а не opencode.json.`)
    warn('  Скрипт не правит .jsonc, чтобы не потерять комментарии.')
    warn('  Перенесите настройки в opencode.json или правьте вручную.')
    return false
  }

  let existing = null
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      warn(`✗ ${file} не разбирается как JSON: ${err.message}`)
      return false
    }
  }

  const tags = await ollamaTags()
  const model = resolveOpencodeModel(profile, tags)
  const check = validateModel(model, tags)
  if (!check.ok) warn(`⚠ ${check.message}`)

  const next = mergeOpencodeConfig({ ...profile, opencode: { ...profile.opencode, model } }, existing)
  const payload = `${JSON.stringify(next, null, 2)}\n`
  const before = existing ? readFileSync(file, 'utf8') : ''
  const changed = payload !== before

  log(`\nOpenCode: ${path.relative(root, file) || 'opencode.json'}`)
  log(`  model          = ${next.model}`)
  log(`  default_agent  = ${next.default_agent}`)

  if (!changed) {
    log('  изменений нет')
    return true
  }
  if (dryRun) {
    log('  --dry-run: не записано')
    return true
  }

  if (existsSync(file)) {
    const backup = `${file}.bak-${stamp()}`
    copyFileSync(file, backup)
    log(`  бэкап: ${path.basename(backup)}`)
  }
  writeFileSync(file, payload, 'utf8')
  log('  записано')
  return true
}

function validateModel(model, tags) {
  if (!model.startsWith('ollama/')) return { ok: true }
  const name = model.slice('ollama/'.length)
  if (name.endsWith('-cloud')) return { ok: true }
  if (!tags) {
    return { ok: false, message: `Ollama не отвечает на ${OLLAMA_URL} — модель не проверить` }
  }
  if (tags.includes(name) || tags.includes(`${name}:latest`)) return { ok: true }
  return {
    ok: false,
    message: `в Ollama нет модели «${name}». Проверьте: ollama list (или ollama create ...)`,
  }
}

function isVsCodeRunning() {
  if (process.platform !== 'win32') return false
  const images = ['Code.exe', 'Code - Insiders.exe']
  return images.some((image) => {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      return out.toLowerCase().includes(image.toLowerCase())
    } catch {
      return false
    }
  })
}

async function openClineDb(env = process.env) {
  const existing = clineDbCandidates(env).find((file) => existsSync(file))
  if (!existing) {
    warn('\nCline: не найден state.vscdb.')
    warn('  Похоже, VS Code с расширением Cline ещё не запускался на этой машине.')
    return null
  }
  try {
    const sqlite = await import('node:sqlite')
    // В новых Node класс называется Database, DatabaseSync — устаревший алиас.
    const Database = sqlite.Database || sqlite.DatabaseSync
    if (!Database) throw new Error('в node:sqlite нет класса Database')
    return { db: new Database(existing), file: existing }
  } catch (err) {
    warn(`\nCline: node:sqlite недоступен (${err.message}).`)
    warn('  Нужен Node.js 22.13+ (на 22.5-22.12 — с флагом --experimental-sqlite).')
    return null
  }
}

function readCline(db) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CLINE_KEY)
  if (row?.value == null) return {}
  const bytes = row.value
  const text = bytes instanceof Uint8Array ? Buffer.from(bytes).toString('utf8') : String(bytes)
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function applyCline(profile, { dryRun, force }) {
  const opened = await openClineDb()
  if (!opened) return false
  const { db, file } = opened

  try {
    const current = readCline(db)
    const patch = clinePatch(profile)
    const keys = Object.keys(patch)
    const changed = keys.some((k) => JSON.stringify(current[k]) !== JSON.stringify(patch[k]))

    log('\nCline:')
    for (const k of keys) {
      const before = current[k] === undefined ? '—' : String(current[k])
      const after = String(patch[k])
      log(`  ${before === after ? '=' : '~'} ${k}: ${before} → ${after}`)
    }

    if (!changed) {
      log('  изменений нет')
      return true
    }
    if (dryRun) {
      log('  --dry-run: не записано')
      return true
    }
    if (isVsCodeRunning() && !force) {
      warn('\n✗ VS Code запущен: настройки Cline не записаны.')
      warn('  Закройте VS Code и повторите (Cline читает состояние при старте).')
      warn('  Принудительно: добавьте --force (VS Code может перезаписать при выходе).')
      return false
    }

    db.exec('PRAGMA busy_timeout = 5000')
    const backup = `${file}.bak-${stamp()}`
    copyFileSync(file, backup)
    log(`  бэкап: ${path.basename(backup)}`)

    const next = { ...current, ...patch }
    const payload = JSON.stringify(next)
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CLINE_KEY)
      const value = row?.value instanceof Uint8Array ? Buffer.from(payload, 'utf8') : payload
      if (row) db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(value, CLINE_KEY)
      else db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(CLINE_KEY, value)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    log('  записано')
    return true
  } catch (err) {
    warn(`\n✗ Cline не обновлён: ${err.message}`)
    return false
  } finally {
    try {
      db.close()
    } catch {
      // база уже закрыта или недоступна — сообщать нечего
    }
  }
}

async function status(root) {
  log(`Проект: ${root}`)
  log(`Ollama:  ${OLLAMA_URL}`)

  const tags = await ollamaTags()
  if (tags) {
    log(`         локальных моделей: ${tags.length}`)
    log('         профили комплекта:')
    for (const row of modelAvailability(tags)) {
      const mark = row.cloud ? '☁' : row.installed ? '✅' : '❌'
      log(`           ${row.profile.padEnd(13)} ${mark} ${row.model}`)
    }
    log('         ❌ — модели нет: поставьте её через 02-Установить-локально.bat')
  } else {
    warn('         ✗ Ollama не отвечает (запустите Ollama или проверьте OLLAMA_URL)')
  }

  const opencodeFile = path.join(root, 'opencode.json')
  let opencodeModel = null
  if (existsSync(opencodeFile)) {
    try {
      const cfg = JSON.parse(readFileSync(opencodeFile, 'utf8'))
      opencodeModel = cfg.model || null
      log(`\nOpenCode: ${path.basename(opencodeFile)}`)
      log(`  model         = ${cfg.model || '—'}`)
      log(`  default_agent = ${cfg.default_agent || '—'}`)
    } catch {
      warn(`\nOpenCode: ${path.basename(opencodeFile)} не разбирается как JSON`)
    }
  } else {
    log('\nOpenCode: opencode.json нет (профиль ещё не применялся)')
  }

  const opened = await openClineDb()
  let clineModel = null
  if (opened) {
    try {
      const cur = readCline(opened.db)
      clineModel = cur.ollamaModelId || cur.apiModelId || null
      log('\nCline (VS Code globalState):')
      log(`  apiProvider = ${cur.apiProvider || '—'}`)
      log(`  model       = ${clineModel || '—'}`)
      log(`  baseUrl     = ${cur.ollamaBaseUrl || '—'}`)
      log(`  ctx         = ${cur.ollamaApiOptionsCtxNum || '—'}`)
      log(`  VS Code запущен: ${isVsCodeRunning() ? 'да (настройки Cline менять нельзя)' : 'нет'}`)
    } finally {
      opened.db.close()
    }
  }

  const guess = matchProfile({ opencodeModel, clineModel })
  log(`\nПохоже на профиль: ${guess || 'не совпадает ни с одним (переключите явно)'}`)
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    warn(`✗ ${err.message}`)
    return 2
  }

  const { root, rootGiven, flags, positional } = args
  const command = positional[0] || 'status'

  if (flags.has('--help') || command === 'help') {
    usage()
    return 0
  }

  if (!existsSync(root)) {
    warn(`✗ Нет такого каталога: ${root}`)
    return 2
  }
  if (path.resolve(root) === KIT_ROOT) {
    warn('✗ Это корень комплекта, а не проект.')
    warn('  Запустите скрипт из корня проекта (где AGENTS.md и opencode.json)')
    warn(`  или укажите: --root "D:\\путь\\к\\проекту"`)
    return 2
  }
  if (!rootGiven && !looksLikeProject(root)) {
    warn(`✗ В каталоге ${root} нет признаков проекта (opencode.json / AGENTS.md / package.json).`)
    warn('  Перейдите в корень проекта или укажите --root <путь>.')
    return 2
  }

  if (command === 'status') {
    await status(root)
    return 0
  }

  const profile = PROFILES[command]
  if (!profile) {
    warn(`✗ Неизвестный профиль: ${command}`)
    usage()
    return 1
  }

  log(`Профиль: ${command} — ${profile.title}`)
  if (profile.vram) log(`VRAM: ${profile.vram}`)
  if (flags.has('--dry-run')) log('Режим: --dry-run (ничего не записывается)')

  const dryRun = flags.has('--dry-run')
  const wantsOpencode = !flags.has('--cline-only')
  const wantsCline = !flags.has('--opencode-only')

  let ok = true
  if (wantsOpencode) ok = (await applyOpencode(profile, { root, dryRun })) && ok
  if (wantsCline) ok = (await applyCline(profile, { dryRun, force: flags.has('--force') })) && ok

  if (ok) {
    log('\nГотово.')
    if (wantsOpencode) {
      log('OpenCode: конфиг читается при старте; уже открытая сессия модель не меняет —')
      log('          выберите модель в /models, начните новую сессию или перезапустите opencode.')
    }
    if (wantsCline) {
      log('Cline:    перезапустите VS Code и проверьте шестерёнку → API Configuration.')
      if (profile.opencode.agent === 'cloud') {
        log('          Авто-одобрение записи и команд в облаке держите выключенным.')
      }
    }
  }
  return ok ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
