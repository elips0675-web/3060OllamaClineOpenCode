import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildCard,
  classifySection,
  extractFiles,
  gatesFor,
  listRows,
  parseBacklog,
  phasesFor,
  phasesText,
  pickTask,
  projectCommands,
  readBacklogFile,
  resolveBarePaths,
  routeFor,
  walkInventory,
} from './next-task.mjs'

const FIXTURE = [
  '# Что доделать — бэклог',
  '',
  '## ⏳ Ждёт действий пользователя (ключи / внешние сервисы)',
  '',
  '### Ключи и секреты',
  '',
  '- **ENV-01:** `server/.env` — реальные ключи (`refuseMockPayment`, `server/src/routes/premium.js`).',
  '- **ENV-04:** ключ VAPID скомпрометирован — решение владельца, `server/src/push.js`.',
  '',
  '## 🟡 P2 — nice-to-have',
  '',
  '### CI-01: подтвердить зелёный прогон (проверено 21.10.2026)',
  '',
  'Остаток: подтверждение за владельцем, детали `docs/backlog-p0-p1.md`.',
  '',
  '### COV-03: серверное покрытие — остаток (закрыт Stage 162, 22.10.2026)',
  '',
  '### DEPS-02: moderate в prod-зависимостях — риск принят (проверено 20.10.2026)',
  '',
  'Факт: 2 moderate (`server/package.json`).',
  '',
  '### TEST-06: живой Redis (проверено 20.10.2026, сужено)',
  '',
  'Остаток — admin-роут поверх живого Redis (`server/src/routes/admin/queues.js`).',
  '',
  '## 🟢 P3 — бэклог',
  '',
  '### Гигиена HEAD (проверено 26.10.2026)',
  '',
  '- **QA-01: предупреждения ESLint (проверено 26.10.2026).** Правило стоит в `eslint.config.js:58`, худший файл — `src/pages/chats.tsx` (14), ещё `src/test/hangouts.test.tsx` (10).',
  '- **ADV-01: пункт без цитаты кода.** Просто текст без путей и строк.',
  '- **TEST-06: тот же пункт, но с точной строкой (проверено 20.10.2026).** `server/src/routes/admin/queues.js:12`.',
  '',
  '## ✅ Принятые решения (не пересматривать)',
  '',
  '- **DEPS-02 — оставить `bull@4.16.5`:** решение зафиксировано, `server/package.json`.',
  '',
  '## ❌ Не брать (снято факт-чеком)',
  '',
  '- **OLD-01: не делать.** `src/legacy.ts` удалён.',
  '',
  '## Очередь этапов (кандидаты, порядок — как в этом файле)',
  '',
  '1. **Живое доказательство (зависит от владельца):** ENV-01..04, AND-01/02, CI-01.',
  '2. **Покрытие ядра — продолжение (COV-02).** Остаток — `server/src/index.js` и `server/src/seed.js`.',
  '3. **Юридические тексты — решение владельца (LEGAL-01).** Текст в `src/pages/legal-privacy.tsx`.',
  '',
  '## Правила работы с журналами и бэклогом',
  '',
  '- Правило, не пункт: `README.md`.',
].join('\n')

const byId = (items, id) => items.find((item) => item.id === id)

describe('classifySection', () => {
  it('различает приоритеты, очередь и блокеры', () => {
    expect(classifySection('🟡 P2 — nice-to-have')).toEqual({ skip: false, priority: 2 })
    expect(classifySection('🟢 P3 — бэклог, брать после P0–P2')).toEqual({ skip: false, priority: 3 })
    expect(classifySection('Очередь этапов (кандидаты)')).toEqual({ skip: false, queue: true, priority: 4 })
    expect(classifySection('⏳ Ждёт действий пользователя (ключи / внешние сервисы)')).toEqual({ skip: false, blocked: true, priority: 9 })
  })

  it('не путает P3-диапазон в заголовке с приоритетом P0', () => {
    expect(classifySection('P3 — хвост после P0–P2').priority).toBe(3)
  })

  it('пропускает разделы, которые не являются задачами', () => {
    expect(classifySection('✅ Принятые решения (дозапись 20.10.2026)').skip).toBe(true)
    expect(classifySection('❌ Не брать (консенсус аудитов)').skip).toBe(true)
    expect(classifySection('Правила работы с журналами и бэклогом').skip).toBe(true)
  })
})

describe('extractFiles', () => {
  it('собирает пути и номера строк, дедуплицирует', () => {
    const files = extractFiles('Правило `eslint.config.js:58`, файл `src/pages/chats.tsx` и снова `src/pages/chats.tsx` (14)')
    expect(files).toEqual([
      { path: 'eslint.config.js', lines: '58' },
      { path: 'src/pages/chats.tsx', lines: '' },
    ])
  })

  it('предпочитает вхождение со строкой', () => {
    const files = extractFiles('`server/src/push.js` и `server/src/push.js:41`')
    expect(files).toEqual([{ path: 'server/src/push.js', lines: '41' }])
  })

  it('не считает путём упоминание без расширения', () => {
    expect(extractFiles('Просто `server` без файла')).toEqual([])
  })
})

describe('resolveBarePaths', () => {
  const inventory = [
    'server/src/__tests__/admin-queues.test.js',
    'server/src/queues.js',
    'scripts/queues.js',
    'src/pages/chats.tsx',
  ]

  it('достраивает путь по уникальному имени файла', () => {
    expect(resolveBarePaths([{ path: 'admin-queues.test.js', lines: '12' }], inventory)).toEqual([
      { path: 'server/src/__tests__/admin-queues.test.js', lines: '12', resolved: true },
    ])
  })

  it('не трогает путь, у которого уже есть каталог', () => {
    const file = { path: 'src/pages/chats.tsx', lines: '41' }
    expect(resolveBarePaths([file], inventory)).toEqual([file])
  })

  it('оставляет имя как есть, если совпадений нет или их несколько', () => {
    expect(resolveBarePaths([{ path: 'queues.js', lines: '' }], inventory)).toEqual([{ path: 'queues.js', lines: '' }])
    expect(resolveBarePaths([{ path: 'missing.ts', lines: '' }], inventory)).toEqual([{ path: 'missing.ts', lines: '' }])
  })
})

describe('walkInventory', () => {
  it('обходит репозиторий и пропускает зеркала, сборку и node_modules', () => {
    const inventory = walkInventory(process.cwd())
    expect(inventory).toContain('package.json')
    expect(inventory.some((file) => file.startsWith('node_modules/'))).toBe(false)
    expect(inventory.some((file) => file.startsWith('test/'))).toBe(false)
    expect(inventory.some((file) => file.startsWith('scripts/'))).toBe(true)
  })
})

describe('parseBacklog', () => {
  const items = parseBacklog(FIXTURE)

  it('находит пункты-списки и пункты-заголовки', () => {
    const ids = items.map((item) => item.id)
    expect(ids).toContain('QA-01')
    expect(ids).toContain('CI-01')
    expect(ids).toContain('ENV-01')
    expect(ids).toContain('COV-02')
    expect(ids).toContain('LEGAL-01')
    expect(ids).toContain('ADV-01')
  })

  it('не берёт пункты из разделов «Принятые решения» и «Не брать»', () => {
    const ids = items.map((item) => item.id)
    expect(ids).not.toContain('OLD-01')
    expect(items.filter((item) => item.id === 'DEPS-02')).toHaveLength(1)
  })

  it('сохраняет номер строки, дату проверки и цитату кода', () => {
    const qa = byId(items, 'QA-01')
    expect(qa.line).toBe(30)
    expect(qa.verified).toBe('26.10.2026')
    expect(qa.evidence).toBe('file:line')
    expect(qa.files.map((file) => file.path)).toContain('src/pages/chats.tsx')
    expect(qa.priority).toBe(3)
  })

  it('наследует приоритет раздела, если подзаголовок без метки P', () => {
    const env = byId(items, 'ENV-01')
    expect(env.priority).toBe(9)
    expect(env.status).toBe('blocked')
  })

  it('ставит статусы blocked / closed / decision / no-evidence / ready', () => {
    expect(byId(items, 'ENV-04').status).toBe('blocked')
    expect(byId(items, 'CI-01').status).toBe('blocked')
    expect(byId(items, 'LEGAL-01').status).toBe('blocked')
    expect(byId(items, 'COV-03').status).toBe('closed')
    expect(byId(items, 'DEPS-02').status).toBe('decision')
    expect(byId(items, 'ADV-01').status).toBe('no-evidence')
    expect(byId(items, 'QA-01').status).toBe('ready')
    expect(byId(items, 'COV-02').status).toBe('ready')
  })

  it('дедуплицирует ID, оставляя вхождение с цитатой file:line', () => {
    const test06 = items.filter((item) => item.id === 'TEST-06')
    expect(test06).toHaveLength(1)
    expect(test06[0].line).toBe(32)
    expect(test06[0].evidence).toBe('file:line')
  })

  it('пункт без путей остаётся, но без цитаты кода', () => {
    const adv = byId(items, 'ADV-01')
    expect(adv.evidence).toBe('none')
    expect(adv.files).toEqual([])
  })
})

describe('табличный бэклог', () => {
  const TABLE = [
    '# Бэклог',
    '',
    '## 🟡 Открытые (P1)',
    '',
    '| ID | Проблема | Факт | Решение | Статус |',
    '|---|----------|------|---------|--------|',
    '| P1-08 | **Secrets** | `server/src/email.js:13` | env | ⏳ (проверено 23.10.2026) |',
    '| P1-09 | **Settings** | - | - | ⏳ (проверено 09.10.2026) |',
    '| E2E-02 | **Закрытая** | `e2e/a.spec.ts:5` | - | ✅ 09.10.2026 |',
    '',
    '### BU-01 — Заголовочный пункт',
    'Факт: `README.md:1`',
    'Статус: ⏳ (проверено 30.10.2026)',
  ].join('\n')

  const items = parseBacklog(TABLE)

  it('читает строки таблицы с ID-колонкой вместе с заголовками', () => {
    expect(items.map((item) => item.id)).toEqual(['P1-08', 'P1-09', 'E2E-02', 'BU-01'])
  })

  it('берёт заголовок из второй колонки и цитату из остальных', () => {
    const p108 = byId(items, 'P1-08')
    expect(p108.title).toBe('Secrets')
    expect(p108.evidence).toBe('file:line')
    expect(p108.files[0].path).toBe('server/src/email.js')
    expect(p108.files[0].lines).toBe('13')
    expect(p108.priority).toBe(1)
    expect(p108.status).toBe('ready')
  })

  it('пустая колонка «Факт» даёт no-evidence, а ✅-дата — closed', () => {
    expect(byId(items, 'P1-09').evidence).toBe('none')
    expect(byId(items, 'P1-09').status).toBe('no-evidence')
    expect(byId(items, 'E2E-02').status).toBe('closed')
  })

  it('не принимает шапку и разделитель таблицы за пункты', () => {
    expect(items.some((item) => /^ID$/u.test(item.id))).toBe(false)
    expect(items.every((item) => /^[A-Z][A-Z0-9]{1,7}-\d{2}$/u.test(item.id))).toBe(true)
  })
})

describe('pickTask', () => {
  const items = parseBacklog(FIXTURE)

  it('по умолчанию отдаёт приоритетный готовый пункт с цитатой кода', () => {
    expect(pickTask(items).id).toBe('QA-01')
  })

  it('не отдаёт блокеры без явного флага', () => {
    expect(pickTask(items, { id: 'ENV-01' })).toBe(null)
    expect(pickTask(items, { id: 'ENV-01', includeBlocked: true }).id).toBe('ENV-01')
  })

  it('исключает пункты без цитаты кода, пока не разрешено', () => {
    expect(pickTask(items, { id: 'ADV-01' })).toBe(null)
    expect(pickTask(items, { id: 'ADV-01', allowNoEvidence: true }).id).toBe('ADV-01')
  })

  it('никогда не отдаёт закрытые пункты и принятые решения', () => {
    expect(pickTask(items, { id: 'COV-03', includeBlocked: true })).toBe(null)
    expect(pickTask(items, { id: 'DEPS-02', includeBlocked: true })).toBe(null)
    expect(pickTask(items, { includeBlocked: true }).id).toBe('QA-01')
  })

  it('фильтрует по разделу очереди и по ID', () => {
    expect(pickTask(items, { queueOnly: true }).id).toBe('COV-02')
    expect(pickTask(items, { id: 'cov-02', includeBlocked: true }).id).toBe('COV-02')
    expect(pickTask(items, { id: 'NOPE-01' })).toBe(null)
  })

  it('--local берёт готовый пункт с ограниченным числом файлов', () => {
    const picked = pickTask(items, { local: true })
    expect(picked.id).toBe('QA-01')
    expect(picked.files.length).toBeLessThanOrEqual(3)
    expect(picked.status).toBe('ready')
  })

  it('--local не берёт пункт из семи файлов: это бюджет облака (RUN-06)', () => {
    const sevenFiles = Array.from({ length: 7 }, (_, index) => ({ path: `src/file${index}.ts` }))
    const seven = {
      ...byId(items, 'QA-01'),
      title: 'Проверить ESLint',
      body: 'Проверить ESLint',
      files: sevenFiles,
    }
    expect(pickTask([seven], { local: true })).toBe(null)
    expect(routeFor(seven).reason).toBe('too-many-files')
  })

  it('детерминирован: два вызова дают один результат', () => {
    const first = pickTask(parseBacklog(FIXTURE))
    const second = pickTask(parseBacklog(FIXTURE))
    expect(first.id).toBe(second.id)
    expect(first.line).toBe(second.line)
  })
})

describe('gatesFor', () => {
  const items = parseBacklog(FIXTURE)

  it('для фронтового файла требует eslint, typecheck и тест', () => {
    const gates = gatesFor(byId(items, 'QA-01'))
    expect(gates).toContain('npx.cmd eslint <изменённые файлы>')
    expect(gates).toContain('npm.cmd run typecheck')
    expect(gates).toContain('npm.cmd test -- <тест затронутого файла>')
    expect(gates).toContain('npm.cmd run retent:check')
  })

  it('для серверного файла добавляет N+1, для docs — check:docs', () => {
    expect(gatesFor(byId(items, 'COV-02'))).toContain('npm.cmd run check:n-plus-one')
    expect(gatesFor(byId(items, 'CI-01'))).toContain('npm.cmd run check:docs')
  })
})

describe('gatesFor с реальным package.json', () => {
  const items = parseBacklog(FIXTURE)
  const kit = {
    root: '.',
    scripts: { test: 'vitest run', 'check:backlog': 'node scripts/backlog.mjs check' },
    deps: { vitest: '^3.2.6' },
  }

  it('не предлагает гейты, которых нет в package.json', () => {
    const gates = gatesFor(byId(items, 'QA-01'), kit)
    expect(gates).not.toContain('npx.cmd eslint <изменённые файлы>')
    expect(gates).not.toContain('npm.cmd run typecheck')
    expect(gates).toContain('npm.cmd test -- <тест затронутого файла>')
  })

  it('добавляет гейты комплекта и не дублирует тест', () => {
    const gates = gatesFor(byId(items, 'CI-01'), kit)
    expect(gates).toContain('npm.cmd test')
    expect(gates).toContain('node test/build-pack.mjs --check')
    expect(gates).toContain('npm.cmd run check:backlog')
    expect(gates).not.toContain('npm.cmd run retent:check')
    expect(gates.filter((gate) => gate.startsWith('npm.cmd test')).length).toBe(1)
  })

  it('включает retent:check, когда скрипт объявлен', () => {
    const project = { ...kit, scripts: { ...kit.scripts, 'retent:check': 'node scripts/retention-gate.mjs' } }
    expect(gatesFor(byId(items, 'CI-01'), project)).toContain('npm.cmd run retent:check')
  })

  it('без проекта ведёт себя как раньше: фильтра нет', () => {
    expect(gatesFor(byId(items, 'QA-01'))).toContain('npx.cmd eslint <изменённые файлы>')
  })

  it('промпт называет проект карточки, а не чужой путь', () => {
    const card = buildCard(byId(items, 'QA-01'), { ...kit, root: 'D:/project' })
    expect(card).toContain('Работаем с проектом project в D:/project')
    expect(card).not.toContain('SwiftMatch')
  })

  it('--root: гейты берутся из package.json проекта, а не комплекта', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'next-task-root-'))
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' }, devDependencies: { eslint: '^9.0.0' } }),
    )
    const project = projectCommands(dir)
    expect(project.scripts.lint).toBe('eslint .')
    const card = buildCard(byId(items, 'QA-01'), project)
    expect(card).toContain('npx.cmd eslint <изменённые файлы>')
    expect(card).not.toContain('test/build-pack.mjs')
    expect(card).not.toContain('check:backlog')
  })
})

describe('buildCard', () => {
  const items = parseBacklog(FIXTURE)

  it('содержит ID, источник, статус, срез и готовый промпт', () => {
    const card = buildCard(byId(items, 'QA-01'))
    expect(card).toContain('ЗАДАЧА: QA-01')
    expect(card).toContain('Источник: Что доделать.txt:30')
    expect(card).toContain('Статус: готова')
    expect(card).toContain('СРЕЗ ДЛЯ ОДНОГО ПОДХОДА')
    expect(card).toContain('ПРОМПТ ДЛЯ АГЕНТА')
    expect(card).toContain('никакого any')
  })

  it('для принятого решения честно пишет, что это не задача', () => {
    expect(buildCard(byId(items, 'DEPS-02'))).toContain('Статус: принятое решение, не задача')
  })

  it('печатает маршрут рядом с числом файлов', () => {
    const card = buildCard(byId(items, 'QA-01'))
    expect(card).toContain('Маршрут: 3060 по одному файлу, подходов: 3')
  })
})

describe('routeFor', () => {
  const items = parseBacklog(FIXTURE)
  const withText = (id, text, files) => ({
    ...byId(items, id),
    title: text,
    body: text,
    files: files || byId(items, id).files,
  })

  it('один файл с цитатой — на 3060 одним подходом', () => {
    expect(routeFor({ ...byId(items, 'QA-01'), files: [{ path: 'a.ts' }] })).toEqual({
      target: 'local',
      reason: 'single-file',
      text: '3060: один файл, один подход',
    })
  })

  it('несколько файлов — 3060 по одному подходу, с указанием на /next-cloud', () => {
    const route = routeFor(byId(items, 'QA-01'))
    expect(route.target).toBe('local')
    expect(route.reason).toBe('stepwise')
    expect(route.text).toContain('подходов: 3')
    expect(route.text).toContain('/next-cloud')
  })

  it('без цитаты file:line маршрут — облако', () => {
    const route = routeFor({ ...byId(items, 'QA-01'), evidence: 'file' })
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('no-citation')
    expect(route.text).toContain('нет цитаты file:line')
  })

  it('больше 6 файлов — облако, даже если цитаты есть', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ path: `src/f${index}.ts`, lines: '1' }))
    const route = routeFor({ ...byId(items, 'QA-01'), files: many })
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('too-many-files')
    expect(route.text).toContain('7 файлов')

    const six = many.slice(0, 6)
    expect(routeFor({ ...byId(items, 'QA-01'), files: six }).target).toBe('local')
  })

  it('платежи и деньги уходят в облако даже на одном файле', () => {
    const route = routeFor(withText('QA-01', 'Проверить возврат средств и подписку Stripe', [{ path: 'server/src/routes/premium.js' }]))
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('money')
    expect(route.text).toContain('платежи и деньги')
  })

  it('доступ и секреты уходят в облако', () => {
    const route = routeFor(withText('QA-01', 'Сверить CSRF и JWT в adminAuth', [{ path: 'server/src/middleware.js' }]))
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('access')
  })

  it('схема БД и миграции уходят в облако', () => {
    const route = routeFor(withText('QA-01', 'Добавить миграцию под новый ENUM', [{ path: 'database/migrations/042_x.sql' }]))
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('schema')
  })

  it('деплой и инфраструктура уходят в облако', () => {
    const route = routeFor(withText('QA-01', 'Поправить health-gate в deploy.yml', [{ path: '.github/workflows/deploy.yml' }]))
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('infra')
  })

  it('ключевое слово в пути файла тоже считается', () => {
    const route = routeFor({ ...byId(items, 'QA-01'), title: 'Мелкая правка', body: 'Мелкая правка', files: [{ path: 'src/lib/auth-refresh.ts' }] })
    expect(route.target).toBe('cloud')
    expect(route.reason).toBe('access')
  })

  it('облачный маршрут честно говорит, что это ключевые слова, а не оценка сложности', () => {
    const route = routeFor(withText('QA-01', 'Stripe checkout'))
    expect(route.text).toContain('сложность он не оценивает')
  })
})

describe('phasesFor', () => {
  const items = parseBacklog(FIXTURE)
  const one = { ...byId(items, 'QA-01'), files: [{ path: 'src/a.ts' }] }
  const seven = { ...one, files: Array.from({ length: 7 }, (_, index) => ({ path: `src/f${index}.ts` })) }
  const money = {
    ...one,
    title: 'Вернуть деньги за подписку Stripe',
    body: 'Вернуть деньги за подписку Stripe',
  }

  it('один файл без риска: все фазы локальные', () => {
    expect(phasesFor(one).map((phase) => [phase.name, phase.target])).toEqual([
      ['ПЛАН', 'local'],
      ['ШАГ', 'local'],
      ['ПРОВЕРКА', 'local'],
    ])
  })

  it('несколько файлов: план пишет облако, шаги исполняет 3060', () => {
    const phases = phasesFor(byId(items, 'QA-01'))
    expect(phases[0]).toMatchObject({ name: 'ПЛАН', target: 'cloud' })
    expect(phases[0].text).toContain('implementation_plan.md')
    expect(phases[1]).toMatchObject({ name: 'ШАГ', target: 'local' })
  })

  it('семь файлов больше не уводят правку в облако: облако пишет только план', () => {
    const phases = phasesFor(seven)
    expect(phases[0].target).toBe('cloud')
    expect(phases[0].text).toContain('7 файл')
    expect(phases[1].target).toBe('local')
  })

  it('правка в риск-домене переносит шаг в облако', () => {
    const phases = phasesFor(money)
    expect(phases[1]).toMatchObject({ name: 'ШАГ', target: 'cloud' })
    expect(phases[1].text).toContain('платежи и деньги')
  })

  it('без цитаты file:line остаётся одна фаза — факты в облаке', () => {
    const phases = phasesFor({ ...one, evidence: 'file' })
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({ name: 'ФАКТЫ', target: 'cloud' })
  })

  it('phasesText собирает фазы в одну строку карточки', () => {
    const text = phasesText(byId(items, 'QA-01'))
    expect(text).toContain('ПЛАН: облако')
    expect(text).toContain('ШАГ: 3060')
    expect(text).toContain('ПРОВЕРКА: гейты')
  })

  it('карточка печатает строку «Фазы» рядом с маршрутом', () => {
    expect(buildCard(byId(items, 'QA-01'))).toContain('Фазы: ПЛАН: облако')
  })
})

describe('pickTask --local', () => {
  const items = parseBacklog(FIXTURE)

  it('оставляет только пункты, которые скрипт отправляет на 3060', () => {
    const payment = {
      ...byId(items, 'QA-01'),
      id: 'PAY-01',
      title: 'Stripe',
      body: 'Stripe',
      files: [{ path: 'server/src/routes/premium.js' }],
    }
    const picked = pickTask([payment], { local: true })
    expect(picked).toBeNull()
  })

  it('безопасный однофайловый пункт остаётся локальным', () => {
    const safe = { ...byId(items, 'QA-01'), id: 'SAFE-01', title: 'Убрать warning', body: 'Убрать warning', files: [{ path: 'src/pages/a.tsx' }] }
    expect(pickTask([safe], { local: true }).id).toBe('SAFE-01')
  })
})

describe('listRows', () => {
  it('отдаёт по строке на каждый пункт с флагами', () => {
    const rows = listRows(parseBacklog(FIXTURE))
    const qa = rows.find((row) => row.id === 'QA-01')
    expect(qa.status).toBe('ready')
    expect(qa.evidence).toBe('file:line')
    expect(qa.files).toBe(3)
    expect(rows.find((row) => row.id === 'ENV-01').status).toBe('blocked')
    expect(rows.find((row) => row.id === 'COV-02').queue).toBe(true)
  })
})

describe('readBacklogFile', () => {
  const failWith = (code) => () => {
    const error = new Error(`boom: ${code}`)
    error.code = code
    throw error
  }

  it('возвращает текст, когда файл читается', () => {
    const result = readBacklogFile(() => '# бэклог', 'backlog.txt')
    expect(result).toEqual({ ok: true, text: '# бэклог' })
  })

  it('EBUSY считает блокировкой (файл открыт в другой программе)', () => {
    const result = readBacklogFile(failWith('EBUSY'), 'backlog.txt')
    expect(result.ok).toBe(false)
    expect(result.locked).toBe(true)
  })

  it('EPERM и EACCES тоже считает блокировкой', () => {
    expect(readBacklogFile(failWith('EPERM'), 'b.txt').locked).toBe(true)
    expect(readBacklogFile(failWith('EACCES'), 'b.txt').locked).toBe(true)
  })

  it('прочие ошибки не выдаёт за блокировку и сохраняет исходную ошибку', () => {
    const result = readBacklogFile(failWith('ENOSPC'), 'b.txt')
    expect(result.locked).toBe(false)
    expect(result.error.code).toBe('ENOSPC')
  })

  it('ошибка без code не ломает проверку', () => {
    const result = readBacklogFile(() => { throw new Error('нет кода') }, 'b.txt')
    expect(result.locked).toBe(false)
    expect(result.error.message).toBe('нет кода')
  })
})

describe('watch-пункты', () => {
  const TEXT = [
    '# Что доделать — бэклог',
    '',
    '## 🟡 Агентные проверки (P2)',
    '',
    '### AGT-11 — Отложенная правка',
    'Факт: `scripts/next-task.mjs` не знает про watch.',
    '',
    'Статус: ⏳ (проверено 31.10.2026) (watch: после AGT-02)',
    '',
    '### AGT-12 — Готовая правка',
    'Факт: `scripts/next-task.mjs` ждёт правки.',
    '',
    'Статус: ⏳ (проверено 31.10.2026)',
    '',
  ].join('\n')

  it('помечает пункт со статусом watch, а не ready', () => {
    const items = parseBacklog(TEXT)
    const byId = (id) => items.find((item) => item.id === id)
    expect(byId('AGT-11').status).toBe('watch')
    expect(byId('AGT-12').status).toBe('ready')
  })

  it('не отдаёт watch-пункт по умолчанию, но отдаёт с --include-blocked', () => {
    const items = parseBacklog(TEXT)
    expect(pickTask(items).id).toBe('AGT-12')
    expect(pickTask(items, { id: 'AGT-11' })).toBe(null)
    expect(pickTask(items, { id: 'AGT-11', includeBlocked: true }).id).toBe('AGT-11')
  })

  it('не отдаёт watch-пункт и в локальный маршрут', () => {
    const items = parseBacklog(TEXT)
    expect(pickTask(items, { local: true, id: 'AGT-11' })).toBe(null)
    expect(pickTask(items, { local: true, id: 'AGT-11', includeBlocked: true })).toBe(null)
  })
})

describe('явные маркеры статуса', () => {
  const TEXT = [
    '# Что доделать — бэклог',
    '',
    '## 🟡 Агентные проверки (P2)',
    '',
    '### BLK-06 — Ждёт сборки',
    'Факт: `scripts/next-task.mjs` не разбирает маркер.',
    '',
    'Статус: ⏳ (проверено 31.10.2026) (blocked: проверка после BLK-01)',
    '',
    '### RUN-06 — Выбор владельца',
    'Факт: `scripts/next-task.mjs` не разбирает решение.',
    '',
    'Статус: ⏳ (проверено 31.10.2026) (decision)',
    '',
    '### AGT-20 — Упоминание в цитате',
    'Факт: в тексте есть `решение владельца` как пример, но это не блокер — `scripts/next-task.mjs:12`.',
    '',
    'Статус: ⏳ (проверено 31.10.2026)',
    '',
  ].join('\n')

  it('маркер (blocked: …) даёт blocked, а не no-evidence', () => {
    const item = parseBacklog(TEXT).find((row) => row.id === 'BLK-06')
    expect(item.status).toBe('blocked')
  })

  it('маркер (decision) даёт decision, а не ready', () => {
    const item = parseBacklog(TEXT).find((row) => row.id === 'RUN-06')
    expect(item.status).toBe('decision')
  })

  it('фраза в обратных кавычках не делает пункт blocked', () => {
    const item = parseBacklog(TEXT).find((row) => row.id === 'AGT-20')
    expect(item.status).toBe('ready')
  })
})

describe('цитаты документов и имена без расширения', () => {
  it('принимает .txt, .prisma, .toml и .ini как file:line', () => {
    const files = extractFiles(
      '`08-Куда-писать-команды.txt:262`, `server/prisma/schema.prisma:63`, `pyproject.toml:4`, `setup.ini:2`',
    )
    expect(files).toEqual([
      { path: '08-Куда-писать-команды.txt', lines: '262' },
      { path: 'server/prisma/schema.prisma', lines: '63' },
      { path: 'pyproject.toml', lines: '4' },
      { path: 'setup.ini', lines: '2' },
    ])
  })

  it('принимает имя без расширения, если файл есть в инвентаре', () => {
    const inventory = ['models/Modelfile-14b-q4', '.clinerules', 'scripts/next-task.mjs']
    expect(extractFiles('`models/Modelfile-14b-q4`', inventory)).toEqual([
      { path: 'models/Modelfile-14b-q4', lines: '' },
    ])
    expect(extractFiles('`.clinerules:5`', inventory)).toEqual([
      { path: '.clinerules', lines: '5' },
    ])
  })

  it('не принимает имя без расширения, которого нет в инвентаре', () => {
    expect(extractFiles('`models/Modelfile-14b-q4`')).toEqual([])
    expect(extractFiles('`models/Modelfile-14b-q4`', ['scripts/next-task.mjs'])).toEqual([])
  })
})
