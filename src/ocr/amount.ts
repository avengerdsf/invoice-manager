const TOTAL_PATTERN = /小写[^\d]{0,12}(\d{1,12}(?:,\d{3})*\.\d{2})/
const MONEY_PATTERN = /^[¥￥]?(-?\d[\d,]*\.\d{1,2})$/

export interface OcrTextLine {
  text: string
  left: number
  top: number
  right: number
  bottom: number
}

export interface InvoiceAmounts {
  amountCents: number
  taxCents: number
  totalCents: number
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '')
}

function parseCents(value: string): number | null {
  const normalized = value.replace(/,/g, '')
  const [integerPart, decimalPart = ''] = normalized.split('.')
  const cents = Number(integerPart) * 100 + Number(decimalPart.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
}

function centerX(line: OcrTextLine): number {
  return (line.left + line.right) / 2
}

function centerY(line: OcrTextLine): number {
  return (line.top + line.bottom) / 2
}

function extractColumnTotal(lines: readonly OcrTextLine[], header: string, cutoffY: number): number | null {
  const headerLine = lines.find((line) => normalize(line.text) === header)
  if (!headerLine) return null
  const headerX = centerX(headerLine)
  const headerY = centerY(headerLine)
  const pageWidth = Math.max(...lines.map((line) => line.right), 0)
  const maxDistance = pageWidth * 0.12
  const candidates = lines.flatMap((line) => {
    const normalized = normalize(line.text)
    const match = normalized.match(MONEY_PATTERN)
    if (!match) return []
    const lineY = centerY(line)
    const distance = Math.abs(centerX(line) - headerX)
    const cents = parseCents(match[1])
    if (cents === null || lineY <= headerY || lineY >= cutoffY || distance > maxDistance) return []
    return [{ cents, hasCurrency: /^[¥￥]/.test(normalized), lineY, distance }]
  })
  candidates.sort((left, right) => (
    Number(right.hasCurrency) - Number(left.hasCurrency)
    || right.lineY - left.lineY
    || left.distance - right.distance
  ))
  return candidates[0]?.cents ?? null
}

export function extractInvoiceTotalCents(parts: readonly string[]): number | null {
  for (let index = 0; index < parts.length; index += 1) {
    if (!normalize(parts[index]).includes('小写')) continue
    const nearbyText = normalize(parts.slice(index, index + 4).join(''))
    const match = nearbyText.match(TOTAL_PATTERN)
    if (match) return parseCents(match[1])
  }
  return null
}

export function extractInvoiceAmounts(lines: readonly OcrTextLine[]): InvoiceAmounts | null {
  const cutoffY = Math.min(
    ...lines.filter((line) => normalize(line.text).includes('价税合计')).map(centerY),
    Number.POSITIVE_INFINITY,
  )
  const totalCents = extractInvoiceTotalCents(lines.map((line) => line.text))
  const amountCents = extractColumnTotal(lines, '金额', cutoffY)
  const taxCents = extractColumnTotal(lines, '税额', cutoffY)
  if (amountCents === null || taxCents === null || totalCents === null) return null
  if (amountCents + taxCents !== totalCents) return null
  return { amountCents, taxCents, totalCents }
}
