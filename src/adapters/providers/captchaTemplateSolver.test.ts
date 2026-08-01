import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { solveByTemplate } from './captchaTemplateSolver.js'

describe('captchaTemplateSolver', () => {
  // 真实生产图像：2026-08-01 从生产环境收集的 14 张 zimuku 验证码
  // 标注通过归一化后 ASCII art 肉眼确认（2026-08-01 三次复核）
  const fixtures: Array<{ file: string; expected: string }> = [
    { file: 'cap-00.bmp', expected: '02998' },
    { file: 'cap-01.bmp', expected: '43319' },
    { file: 'cap-02.bmp', expected: '95280' },
    { file: 'cap-03.bmp', expected: '23516' },
    { file: 'cap-04.bmp', expected: '91491' },
    { file: 'cap-05.bmp', expected: '99180' },
    { file: 'cap-06.bmp', expected: '88811' },
    { file: 'cap-07.bmp', expected: '26010' },
    { file: 'cap-08.bmp', expected: '99846' },
    { file: 'cap-09.bmp', expected: '20255' },
    { file: 'cap-10.bmp', expected: '75177' },
    { file: 'cap-11.bmp', expected: '69020' },
    { file: 'cap-12.bmp', expected: '54446' },
    { file: 'cap-13.bmp', expected: '78363' },
  ]

  test.each(fixtures)('识别 $file → $expected', ({ file, expected }) => {
    const bytes = readFileSync(`/tmp/zimuku-captcha-fixtures/${file}`)
    const result = solveByTemplate(new Uint8Array(bytes))
    expect(result).toBe(expected)
  })

  test('模板覆盖率：每个数字 0-9 至少出现一次', () => {
    const allDigits = new Set<string>()
    for (const { expected } of fixtures) {
      for (const ch of expected) {
        allDigits.add(ch)
      }
    }
    expect(allDigits.size).toBe(10)
    expect([...allDigits].sort().join('')).toBe('0123456789')
  })
})
