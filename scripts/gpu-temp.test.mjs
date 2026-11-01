import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TARGET,
  advice,
  applyLimit,
  parseArgs,
  parseStatus,
  pickLimit,
  powerArgs,
  readStatus,
  renderStatus,
} from './gpu-temp.mjs'

const CSV = 'NVIDIA GeForce RTX 3060, 80, 165.34, 170.00, 100.00, 170.00, 1855'

describe('parseStatus', () => {
  it('читает строку nvidia-smi без заголовка', () => {
    expect(parseStatus(CSV)).toEqual({
      name: 'NVIDIA GeForce RTX 3060',
      temperature: 80,
      draw: 165.34,
      limit: 170,
      minLimit: 100,
      defaultLimit: 170,
      clock: 1855,
    })
  })

  it('берёт первую непустую строку', () => {
    expect(parseStatus(`\n\n${CSV}\n`).temperature).toBe(80)
  })

  it('N/A превращает в null, а не в NaN', () => {
    const status = parseStatus('RTX 3060, 44, [N/A], 170.00, 100.00, 170.00, 210')
    expect(status.draw).toBeNull()
  })

  it('пустой вывод и короткая строка — ошибка', () => {
    expect(() => parseStatus('')).toThrow(/не вернул строку/u)
    expect(() => parseStatus('RTX 3060, 44, 17')).toThrow(/ожидалось 7 полей/u)
  })

  it('нечисловое поле — ошибка, а не тихий ноль', () => {
    expect(() => parseStatus('RTX 3060, много, 17, 170, 100, 170, 210')).toThrow(/не число/u)
  })
})

describe('pickLimit', () => {
  const status = parseStatus(CSV)

  it('по умолчанию ставит 130 W', () => {
    expect(DEFAULT_TARGET).toBe(130)
    expect(pickLimit(status)).toEqual({ watts: 130, clamped: null, asked: 130 })
  })

  it('ниже минимума карты не опускает', () => {
    expect(pickLimit(status, 60)).toEqual({ watts: 100, clamped: 'min', asked: 60 })
  })

  it('выше заводского лимита не поднимает', () => {
    expect(pickLimit(status, 220)).toEqual({ watts: 170, clamped: 'max', asked: 220 })
  })

  it('без заводского лимита — понятная ошибка', () => {
    expect(() => pickLimit({ minLimit: 100, defaultLimit: null, limit: null }, 130)).toThrow(
      /заводской лимит/u,
    )
  })
})

describe('powerArgs и renderStatus', () => {
  it('собирает аргументы nvidia-smi', () => {
    expect(powerArgs(130)).toEqual(['-pl', '130'])
  })

  it('печатает температуру, потребление и границы', () => {
    const text = renderStatus(parseStatus(CSV))
    expect(text).toContain('GPU: NVIDIA GeForce RTX 3060')
    expect(text).toContain('температура: 80 °C')
    expect(text).toContain('165.34 W из 170 W')
    expect(text).toContain('минимум 100 W, заводской 170 W')
    expect(text).toContain('1855 MHz')
  })

  it('прочерки вместо null', () => {
    const text = renderStatus({ name: 'X', temperature: null, draw: null, limit: null, minLimit: null, defaultLimit: null, clock: null })
    expect(text).toContain('температура: —')
    expect(text).toContain('мощность:    — из —')
  })
})

describe('advice', () => {
  it('на 80 °C советует лимит мощности и даёт команду', () => {
    const { picked, text } = advice(parseStatus(CSV))
    expect(picked.watts).toBe(130)
    expect(text).toContain('80 °C и выше')
    expect(text).toContain('Команда: nvidia-smi -pl 130')
  })

  it('на простое не пугает', () => {
    const text = advice(parseStatus('RTX 3060, 44, 17, 170.00, 100.00, 170.00, 210')).text
    expect(text).not.toContain('80 °C и выше')
    expect(text).toContain('Команда: nvidia-smi -pl 130')
  })

  it('объясняет, если запрошено вне диапазона карты', () => {
    expect(advice(parseStatus(CSV), 60).text).toContain('не умеет ниже 100 W')
    expect(advice(parseStatus(CSV), 220).text).toContain('выше заводского 170 W не ставлю')
  })
})

describe('parseArgs', () => {
  it('по умолчанию только статус', () => {
    expect(parseArgs([])).toEqual({ mode: 'status', target: 130, json: false, help: false })
  })

  it('понимает --set, --set= и --reset', () => {
    expect(parseArgs(['--set', '125']).mode).toBe('set')
    expect(parseArgs(['--set=125']).target).toBe(125)
    expect(parseArgs(['--reset']).mode).toBe('reset')
    expect(parseArgs(['--json']).json).toBe(true)
  })

  it('ругается на плохие аргументы', () => {
    expect(() => parseArgs(['--set', '0'])).toThrow(/целое число ватт/u)
    expect(() => parseArgs(['--set'])).toThrow(/целое число ватт/u)
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестный аргумент/u)
  })
})

describe('readStatus и applyLimit с подменённым nvidia-smi', () => {
  it('readStatus спрашивает ровно те поля и без заголовка', () => {
    const calls = []
    const run = (args) => {
      calls.push(args)
      return CSV
    }
    const status = readStatus(run)
    expect(status.temperature).toBe(80)
    expect(calls[0]).toContain('--format=csv,noheader,nounits')
    expect(calls[0][0]).toContain('--query-gpu=name,temperature.gpu,power.draw')
  })

  it('applyLimit ставит лимит и перечитывает статус', () => {
    const calls = []
    const run = (args) => {
      calls.push(args.join(' '))
      if (args[0] === '-pl') return ''
      return 'RTX 3060, 62, 120, 130.00, 100.00, 170.00, 1500'
    }
    const after = applyLimit(130, run)
    expect(calls[0]).toBe('-pl 130')
    expect(after.temperature).toBe(62)
    expect(after.limit).toBe(130)
  })

  it('на отказе доступа подсказывает про администратора', () => {
    const run = () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'Insufficient Permissions' })
    }
    expect(() => applyLimit(130, run)).toThrow(/права администратора/u)
  })

  it('на прочей ошибке не врёт про права', () => {
    const run = () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'not supported' })
    }
    expect(() => applyLimit(130, run)).toThrow(/не удалось изменить лимит/iu)
    expect(() => applyLimit(130, run)).not.toThrow(/права администратора/u)
  })
})
