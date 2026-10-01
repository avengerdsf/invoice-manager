import type { TableColumn } from '../shared/table-config'

export function formatTableNumber(value: number, column: Pick<TableColumn, 'format' | 'precision' | 'unit'>): string {
  const precision = column.precision ?? 2
  const shown = column.format === 'percent' ? value * 100 : value
  const number = shown.toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision })
  return `${column.format === 'currency' ? '¥ ' : ''}${number}${column.format === 'percent' ? '%' : ''}${column.unit ? ` ${column.unit}` : ''}`
}
