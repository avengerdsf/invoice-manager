import { describe, expect, it } from 'vitest'
import { formatTableNumber } from './table-value-format'
describe('custom number presentation', () => {
  it('formats percent, currency and units without altering the raw stored value', () => {
    expect(formatTableNumber(0.125, {format:'percent',precision:1})).toBe('12.5%')
    expect(formatTableNumber(12.345, {format:'currency',precision:2})).toBe('¥ 12.35')
    expect(formatTableNumber(0, {precision:0,unit:'件'})).toBe('0 件')
    expect(formatTableNumber(12.345, {precision:3})).toBe('12.345')
  })
})
