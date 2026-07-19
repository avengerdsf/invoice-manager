const MONEY_TOKEN_PATTERN = /[¥￥]?(-?\d{1,12}(?:[,，]\d{3})*(?:[.。]\d{1,2}))/g

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
  return value.normalize('NFKC').replace(/\s+/g, '').replace(/，/g, ',').replace(/。/g, '.')
}

function parseCents(value: string): number | null {
  const normalized = value.replace(/[,，]/g, '').replace(/。/g, '.')
  const [integerPart, decimalPart = ''] = normalized.split('.')
  const cents = Number(integerPart) * 100 + Number(decimalPart.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
}

function moneyTokens(value: string): Array<{ cents: number; hasCurrency: boolean }> {
  const normalized = normalize(value)
  return [...normalized.matchAll(MONEY_TOKEN_PATTERN)].flatMap((match) => {
    const cents = parseCents(match[1])
    return cents === null ? [] : [{ cents, hasCurrency: /^[¥￥]/.test(match[0]) }]
  })
}

function centerX(line: OcrTextLine): number {
  return (line.left + line.right) / 2
}

function centerY(line: OcrTextLine): number {
  return (line.top + line.bottom) / 2
}

function containsAny(value: string, markers: readonly string[]): boolean {
  const normalized = normalize(value)
  return markers.some((marker) => normalized.includes(marker))
}

interface MoneyCandidate {
  cents: number
  hasCurrency: boolean
  lineY: number
  distance: number
}

function findHeader(lines: readonly OcrTextLine[], markers: readonly string[]): OcrTextLine | null {
  return lines.find((line) => containsAny(line.text, markers)) ?? null
}

function uniqueCandidates(candidates: readonly MoneyCandidate[]): MoneyCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.cents}:${Math.round(candidate.lineY)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractColumnCandidates(
  lines: readonly OcrTextLine[],
  headerMarkers: readonly string[],
  cutoffY: number,
): MoneyCandidate[] {
  const headerLine = findHeader(lines, headerMarkers)
  if (!headerLine) return []
  const headerX = centerX(headerLine)
  const headerY = centerY(headerLine)
  const pageWidth = Math.max(...lines.map((line) => line.right), 0)
  // OCR boxes for long values are centred away from a narrow header box. A
  // wider tolerance is needed for invoices with many rows and large amounts.
  const maxDistance = Math.max(pageWidth * 0.18, headerLine.right - headerLine.left)
  const candidates = lines.flatMap((line) => {
    const lineY = centerY(line)
    const distance = Math.abs(centerX(line) - headerX)
    if (lineY <= headerY || lineY >= cutoffY || distance > maxDistance) return []
    return moneyTokens(line.text).map((token) => ({ ...token, lineY, distance }))
  })
  candidates.sort((left, right) => (
    Number(right.hasCurrency) - Number(left.hasCurrency)
    || right.lineY - left.lineY
    || left.distance - right.distance
  ))
  return uniqueCandidates(candidates)
}

function extractRightmostMoneyColumns(
  lines: readonly OcrTextLine[],
  cutoffY: number,
): { amountCandidates: MoneyCandidate[]; taxCandidates: MoneyCandidate[] } | null {
  const pageLeft = Math.min(...lines.map((line) => line.left), 0)
  const pageRight = Math.max(...lines.map((line) => line.right), 0)
  const pageWidth = pageRight - pageLeft
  if (pageWidth <= 0) return null

  const entries = lines.flatMap((line) => {
    const lineY = centerY(line)
    const lineX = centerX(line)
    if (lineY >= cutoffY || lineX < pageLeft + pageWidth * 0.4 || totalMarkers(line.text)) return []
    return moneyTokens(line.text).map((token) => ({
      ...token,
      lineY,
      distance: 0,
      lineX,
    }))
  })
  if (entries.length < 2) return null

  const tolerance = pageWidth * 0.055
  const columns: Array<{ x: number; candidates: MoneyCandidate[] }> = []
  for (const entry of entries.sort((left, right) => left.lineX - right.lineX)) {
    const column = columns.find((item) => Math.abs(item.x - entry.lineX) <= tolerance)
    if (column) {
      column.x = (column.x * column.candidates.length + entry.lineX) / (column.candidates.length + 1)
      column.candidates.push(entry)
    } else {
      columns.push({ x: entry.lineX, candidates: [entry] })
    }
  }
  columns.sort((left, right) => left.x - right.x)
  if (columns.length < 2) return null

  const amountColumn = columns[columns.length - 2]
  const taxColumn = columns[columns.length - 1]
  const sortCandidates = (candidates: MoneyCandidate[]): MoneyCandidate[] => uniqueCandidates(candidates.sort((left, right) => (
    Number(right.hasCurrency) - Number(left.hasCurrency) || right.lineY - left.lineY
  )))
  return {
    amountCandidates: sortCandidates(amountColumn.candidates),
    taxCandidates: sortCandidates(taxColumn.candidates),
  }
}

function totalMarkers(value: string): boolean {
  return containsAny(value, ['小写', '价税合计', '价税合計'])
}

export function extractInvoiceTotalCents(parts: readonly string[]): number | null {
  // Prefer a value printed in the same OCR box as the marker. This prevents a
  // standalone “价税合计” label from accidentally consuming the preceding
  // detail-row tax value.
  for (const part of parts) {
    if (!totalMarkers(part)) continue
    const tokens = moneyTokens(part)
    if (tokens.length > 0) return tokens[tokens.length - 1].cents
  }

  // OCR/PDF text extraction may split “价税合计（小写）” and its value into
  // several neighbouring boxes. Search both sides of every recognised marker.
  for (let index = 0; index < parts.length; index += 1) {
    if (!totalMarkers(parts[index])) continue
    const nearby = parts.slice(Math.max(0, index - 2), index + 5)
    const tokens = moneyTokens(nearby.join(''))
    for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
      if (tokens[tokenIndex].hasCurrency) return tokens[tokenIndex].cents
    }
    if (containsAny(parts[index], ['小写']) && tokens.length > 0) {
      return tokens[tokens.length - 1].cents
    }
  }
  return null
}

function sumCandidates(candidates: readonly MoneyCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.cents, 0)
}

function exactPair(
  amountCandidates: readonly MoneyCandidate[],
  taxCandidates: readonly MoneyCandidate[],
  totalCents: number,
): InvoiceAmounts | null {
  for (const amount of amountCandidates) {
    for (const tax of taxCandidates) {
      if (amount.cents + tax.cents === totalCents) {
        return { amountCents: amount.cents, taxCents: tax.cents, totalCents }
      }
    }
  }
  return null
}

export function extractInvoiceAmounts(lines: readonly OcrTextLine[]): InvoiceAmounts | null {
  const totalLines = lines.filter((line) => totalMarkers(line.text))
  const cutoffY = Math.min(...totalLines.map(centerY), Number.POSITIVE_INFINITY)
  const totalCents = extractInvoiceTotalCents(lines.map((line) => line.text))
  if (totalCents === null) return null

  let amountCandidates = extractColumnCandidates(lines, ['金额', '金額'], cutoffY)
  let taxCandidates = extractColumnCandidates(lines, ['税额', '稅額'], cutoffY)
  if (amountCandidates.length === 0 || taxCandidates.length === 0) {
    const positionalColumns = extractRightmostMoneyColumns(lines, cutoffY)
    if (positionalColumns) {
      if (amountCandidates.length === 0) amountCandidates = positionalColumns.amountCandidates
      if (taxCandidates.length === 0) taxCandidates = positionalColumns.taxCandidates
    }
  }

  // A multi-item invoice contains many values in both columns. The subtotal
  // pair, when recognised, is the safest source because it satisfies the
  // invoice's printed arithmetic invariant.
  const pair = exactPair(amountCandidates, taxCandidates, totalCents)
  if (pair) return pair

  // Some layouts omit a separate subtotal row, or OCR misses it. Sum the
  // recognised detail rows in each column.
  if (amountCandidates.length > 1 && taxCandidates.length > 1) {
    const amountCents = sumCandidates(amountCandidates)
    const taxCents = sumCandidates(taxCandidates)
    if (amountCents + taxCents === totalCents) {
      return { amountCents, taxCents, totalCents }
    }
  }

  // It is common for OCR to miss exactly one subtotal while recognising the
  // other. Only derive the missing value from a currency-marked or bottom-most
  // subtotal candidate; the invariant remains exact.
  const bestAmount = amountCandidates[0]
  const bestTax = taxCandidates[0]
  const amountLooksLikeSubtotal = bestAmount && (bestAmount.hasCurrency || amountCandidates.length === 1)
  const taxLooksLikeSubtotal = bestTax && (bestTax.hasCurrency || taxCandidates.length === 1)
  if (amountLooksLikeSubtotal && (!taxLooksLikeSubtotal || bestAmount.lineY >= bestTax.lineY)) {
    const taxCents = totalCents - bestAmount.cents
    if (taxCents >= 0) return { amountCents: bestAmount.cents, taxCents, totalCents }
  }
  if (taxLooksLikeSubtotal) {
    const amountCents = totalCents - bestTax.cents
    if (amountCents >= 0) return { amountCents, taxCents: bestTax.cents, totalCents }
  }

  return null
}
