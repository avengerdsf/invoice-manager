import { describe, expect, it } from 'vitest'
import { extractInvoiceAmounts, type OcrTextLine } from './amount'

function line(text: string, x: number, y: number): OcrTextLine {
  return { text, left: x, top: y, right: x + 80, bottom: y + 10 }
}

const headers = [
  line('金额', 100, 10),
  line('税额', 220, 10),
  line('价税合计', 20, 100),
]

describe('extractInvoiceAmounts', () => {
  it('selects the valid subtotal pair among multiple item values', () => {
    const result = extractInvoiceAmounts([
      ...headers,
      line('100.00', 100, 30),
      line('13.00', 220, 30),
      line('300.00', 100, 60),
      line('39.00', 220, 60),
      line('999.00', 100, 80),
      line('1.00', 220, 80),
      line('价税合计（小写）￥339.00', 20, 110),
    ])

    expect(result).toEqual({ amountCents: 30000, taxCents: 3900, totalCents: 33900 })
  })

  it('sums detail rows when a separate subtotal row is unavailable', () => {
    const result = extractInvoiceAmounts([
      ...headers,
      line('100.00', 100, 30),
      line('13.00', 220, 30),
      line('200.00', 100, 60),
      line('26.00', 220, 60),
      line('价税合计（小写）￥339.00', 20, 110),
    ])

    expect(result).toEqual({ amountCents: 30000, taxCents: 3900, totalCents: 33900 })
  })

  it('accepts descriptive headers and a total split across OCR boxes', () => {
    const result = extractInvoiceAmounts([
      line('金额（不含税）', 100, 10),
      line('税额(元)', 220, 10),
      line('100.00元', 100, 30),
      line('13.00元', 220, 30),
      line('200.00元', 100, 60),
      line('26.00元', 220, 60),
      line('价税合计', 20, 100),
      line('（小写）', 100, 110),
      line('￥339.00', 220, 110),
    ])

    expect(result).toEqual({ amountCents: 30000, taxCents: 3900, totalCents: 33900 })
  })

  it('derives a missed tax subtotal from the recognised amount subtotal', () => {
    const result = extractInvoiceAmounts([
      ...headers,
      line('100.00', 100, 30),
      line('13.00', 220, 30),
      line('￥300.00', 100, 80),
      line('价税合计（小写）￥339.00', 20, 110),
    ])

    expect(result).toEqual({ amountCents: 30000, taxCents: 3900, totalCents: 33900 })
  })

  it('uses the two rightmost money columns when both headers are misread', () => {
    const result = extractInvoiceAmounts([
      line('数里', 20, 10),
      line('金颔', 100, 10),
      line('税颔', 220, 10),
      line('2.00', 20, 30),
      line('100.00', 100, 30),
      line('13.00', 220, 30),
      line('1.00', 20, 60),
      line('200.00', 100, 60),
      line('26.00', 220, 60),
      line('价税合计（小写）￥339.00', 20, 110),
    ])

    expect(result).toEqual({ amountCents: 30000, taxCents: 3900, totalCents: 33900 })
  })
})
