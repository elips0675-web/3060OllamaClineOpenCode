import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = HERE;

const DATE = '31.10.2026';
const CHECK = process.argv.includes('--check');

const CORE_CODE = ['scripts/next-task.mjs', 'scripts/agent-live.mjs', 'scripts/backlog.mjs'];
const MORE_CODE = [
  'scripts/ai-profile.mjs',
  'scripts/project-brief.mjs',
  'scripts/agent-eval.mjs',
  'scripts/init-project.mjs',
];
const RULES = [
  '.clinerules',
  'switch-ai.bat',
  'package.json',
  'models/Modelfile-14b-q4',
  'models/Modelfile-14b-q6',
  'models/Modelfile-7b-q5',
  'models/Modelfile-7b-q8',
  'models/Modelfile-tiny',
  'templates/agent-protocol.md',
  'templates/few-shot.md',
  'templates/verify-checklist.md',
  'templates/analysis-card.md',
  'templates/analysis-rules.md',
  'templates/rules/00-project.md',
  'templates/cline_docs/projectBrief.md',
  'templates/cline_docs/activeContext.md',
  'templates/cline_docs/systemPatterns.md',
  'templates/cline_docs/techContext.md',
  'templates/cline_docs/progress.md',
  'templates/workflows/brief.md',
  'templates/workflows/fix.md',
  'templates/workflows/test.md',
  'templates/workflows/review.md',
  'templates/workflows/refactor.md',
  'templates/workflows/deep-planning.md',
  'templates/workflows/eval.md',
];
const DOCS_MAIN = [
  'README.md',
  '00-ЧИТАЙ-ПЕРВЫМ.txt',
  '01-Как-всё-работает.txt',
  '02-Установить-локально.bat',
  '03-Замер-скорости.bat',
  '04-Оффлайн-подготовка.txt',
  '05-Облако-и-DeepSeek.txt',
  '06-Continue-автодополнение.yaml',
  '07-Автовыбор-задач.txt',
  '08-Куда-писать-команды.txt',
];
const DOCS_DETAIL = [
  '09-Памятка.txt',
  '10-Приложения.txt',
  '11-Правки-по-оценке.txt',
  '12-Переключение-моделей.txt',
  '13-Анализ-проекта.txt',
  'docs/README.md',
  'docs/AGENTS-cline-setup.md',
  'docs/AGENTS-workflow.md',
  'docs/AGENTS-kaggle-runbook.md',
  'docs/AGENTS-openclose-experiment.md',
  'docs/AGENTS-remote-eval.md',
  'evals/README.md',
  'evals/manual-run.md',
  'evals/tasks.json',
];
const TESTS = [
  'scripts/next-task.test.mjs',
  'scripts/agent-live.test.mjs',
  'scripts/backlog.test.mjs',
  'scripts/ai-profile.test.mjs',
  'scripts/project-brief.test.mjs',
  'scripts/agent-eval.test.mjs',
  'scripts/init-project.test.mjs',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

function rule(width = 80) {
  return '='.repeat(width);
}

function build({ file, title, purpose, note, files }) {
  const parts = [
    title,
    `Дата снимка: ${DATE}. Комплект: 3060 Ollama · Cline · OpenCode.`,
    '',
    `Что это: ${purpose}`,
    note ? `Как читать: ${note}` : '',
    '',
    `Состав (${files.length} файлов, порядок = порядок в файле):`,
    ...files.map((rel, index) => {
      const text = read(rel);
      const bytes = Buffer.byteLength(text, 'utf8');
      const lines = text.split('\n').length;
      return `  ${String(index + 1).padStart(2, ' ')}. ${rel} — ${bytes} байт, ${lines} строк`;
    }),
    '',
    'Ничего не переписано: ниже дословное содержимое перечисленных файлов,',
    'разделители добавлены генератором test/build-pack.mjs.',
    rule(),
    '',
  ];

  for (const rel of files) {
    const text = read(rel);
    const bytes = Buffer.byteLength(text, 'utf8');
    const lines = text.split('\n').length;
    parts.push(rule());
    parts.push(`ФАЙЛ: ${rel}  (${bytes} байт, ${lines} строк)`);
    parts.push(rule());
    parts.push('');
    parts.push(text.replace(/\n+$/u, ''));
    parts.push('');
  }

  const body = parts.join('\n');
  const target = path.join(OUT, file);
  const size = { file, bytes: Buffer.byteLength(body, 'utf8'), lines: body.split('\n').length };

  if (CHECK) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === null) return { ...size, state: 'нет файла' };
    if (current !== body) return { ...size, state: 'РАСХОДИТСЯ' };
    return { ...size, state: 'совпадает' };
  }

  fs.writeFileSync(target, body, 'utf8');
  return { ...size, state: 'записан' };
}

const results = [];

results.push(
  build({
    file: '02-Код-ядро.txt',
    title: 'КОД: ЯДРО КОМПЛЕКТА (три скрипта, от которых зависит всё остальное)',
    purpose:
      'полный исходный код селектора задач, живого прогона и механизма бэклога. Это то, что реально исполняется, а не описание.',
    note:
      'сначала прочитайте «01-Что-как-работает», разделы 4–6; здесь только код. Тесты этих скриптов — в файле 06.',
    files: CORE_CODE,
  }),
);

results.push(
  build({
    file: '03-Код-вспомогательное.txt',
    title: 'КОД: ПЕРЕКЛЮЧАТЕЛЬ ПРОФИЛЕЙ, БРИФ, ЭВАЛЫ, УСТАНОВЩИК',
    purpose:
      'остальные четыре скрипта: смена модели в Cline и OpenCode, сборщик фактов о проекте, измеритель агента, установщик правил в чужой проект.',
    note: 'эти скрипты не участвуют в выборе задачи, но их поведение описано в 01, разделы 4 и 8.',
    files: MORE_CODE,
  }),
);

results.push(
  build({
    file: '04-Правила-шаблоны-конфиги.txt',
    title: 'ПРАВИЛА, ШАБЛОНЫ, КОНФИГИ: .clinerules, workflows, Memory Bank, Modelfile',
    purpose:
      'то, что задаёт поведение агента текстом: правила Cline, семь процедур, пять файлов памяти, примеры правильного ответа, сборки моделей, package.json.',
    note:
      'это «промптовая» часть комплекта. Если вопрос «почему агент ведёт себя так» — ответ здесь, а не в коде.',
    files: RULES,
  }),
);

results.push(
  build({
    file: '05-Документация-входная.txt',
    title: 'ДОКУМЕНТАЦИЯ: вход комплекта — README, файлы 00–08',
    purpose:
      'документы, которые читает человек при старте: README, «читай первым», схема работы, установка, замер, офлайн-подготовка, облако, автодополнение, автовыбор задач, куда писать команды.',
    note:
      'документы описывают замысел; код в файлах 02–03 описывает факт. При расхождении верьте коду и «08-Что-доделать».',
    files: DOCS_MAIN,
  }),
);

results.push(
  build({
    file: '06-Документация-подробная.txt',
    title: 'ДОКУМЕНТАЦИЯ: памятка, приложения, профили, разбор проекта, docs/, эвалы',
    purpose:
      'подробные документы: памятка на страницу, Modelfile и контракт скрипта, правки по внешним ревью, профили моделей, разбор проекта по фактам, настройка Cline, механика журналов, Kaggle-прогон, эксперимент с OpenClose, 10 задач эвалов.',
    note:
      'здесь же — единственное место с проверенным фактом про отсутствие нативных tool_calls у локальных моделей (docs/AGENTS-openclose-experiment.md).',
    files: DOCS_DETAIL,
  }),
);

results.push(
  build({
    file: '07-Тесты.txt',
    title: 'ТЕСТЫ: семь файлов vitest, 207 проверок',
    purpose:
      'доказательство поведения: что именно проверяется и чего тесты не проверяют.',
    note:
      'тесты — это спецификация в исполняемом виде. Если утверждение в документации не покрыто тестом, считайте его заявлением, а не фактом.',
    files: TESTS,
  }),
);

results.push(
  build({
    file: '08-Что-доделать.txt',
    title: 'ЧТО ДОДЕЛАТЬ: открытые пункты бэклога комплекта (снимок)',
    purpose:
      'актуальная очередь: 18 открытых пунктов с ID, фактами и статусами, плюс правила ведения бэклога и определение готовности.',
    note:
      'статусы: ⏳ (проверено ДД.ММ.ГГГГ) — открыто; (blocked: …) — ждёт внешнего; (watch: …) — отложено осознанно; ✅ — закрыто.',
    files: ['Что доделать.txt'],
  }),
);

results.push(
  build({
    file: '09-Журнал-что-сделано.txt',
    title: 'ЖУРНАЛ: что уже сделано, с причинами и проверками (снимок)',
    purpose:
      'хроника закрытий: что менялось, почему, какими проверками подтверждено. Новые записи сверху.',
    note:
      'журнал объясняет «почему так», бэклог — «что осталось». Вместе они дают историю решений.',
    files: ['Что сделано.txt'],
  }),
);

console.log('файл'.padEnd(34), 'байт'.padStart(8), 'строк'.padStart(7), ' ', CHECK ? 'состояние' : '');for (const r of results) {
  console.log(
    r.file.padEnd(34),
    String(r.bytes).padStart(8),
    String(r.lines).padStart(7),
    ' ',
    r.state,
  );
}
const total = results.reduce((sum, r) => sum + r.bytes, 0);
console.log('итого'.padEnd(34), String(total).padStart(8));

if (CHECK) {
  const broken = results.filter((r) => r.state !== 'совпадает');
  if (broken.length > 0) {
    console.log('');
    console.log('Снимки устарели — пересоберите: node test/build-pack.mjs');
    process.exit(1);
  }
  console.log('Снимки совпадают с источниками ✓');
}
