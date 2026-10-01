import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildWorkbook } from './exporter'
import type { Project } from '../src/shared/models'

function savedConfig() {
  return { columns: [
    { id: 'category', name: '类别', kind: 'builtin', builtin: 'category' },
    { id: 'date', name: '日期', kind: 'builtin', builtin: 'date' },
    { id: 'name', name: '详细名称', kind: 'builtin', builtin: 'name' },
    { id: 'amount', name: '金额', kind: 'group' },
    { id: 'price', name: '价格', kind: 'builtin', builtin: 'price', parentId: 'amount' },
    { id: 'tax', name: '税费', kind: 'builtin', builtin: 'tax', parentId: 'amount' },
    { id: 'total', name: '总价', kind: 'builtin', builtin: 'total', parentId: 'amount' },
    { id: 'actualPayment', name: '实际付款', kind: 'builtin', builtin: 'actualPayment' },
    { id: 'actualPayer', name: '实际付款人', kind: 'builtin', builtin: 'actualPayer' },
    { id: 'reimbursed', name: '已报销', kind: 'builtin', builtin: 'reimbursed' },
    { id: 'attachments', name: '附件', kind: 'group' },
    { id: 'invoice', name: '发票', kind: 'builtin', builtin: 'invoice', parentId: 'attachments' },
    { id: 'payment', name: '支付截图', kind: 'builtin', builtin: 'payment', parentId: 'attachments' },
    { id: 'other', name: '其他附件', kind: 'builtin', builtin: 'other', parentId: 'attachments' },
    { id: 'note', name: '备注', kind: 'builtin', builtin: 'note' },
    { id: 'actions', name: '操作', kind: 'builtin', builtin: 'actions' },
  ] }
}

function projectFixture(): Project {
  return {
    schemaVersion: 1,
    appVersion: '1.5.1',
    id: 'project-1',
    name: '测试项目',
    revision: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    categories: [{ id: 'travel', name: '差旅费', color: '#123456', order: 0 }],
    expenses: [{
      id: 'expense-1', categoryId: 'travel', date: '2026-10-01', name: '火车票',
      priceCents: 10025, taxCents: 25, actualPayer: '张三', note: '出差', reimbursed: true,
    }],
    attachments: [],
    invoiceAllocations: [],
    paymentAllocations: [],
    otherAllocations: [],
  }
}

async function workbookFor(project: Project): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await buildWorkbook(project))
  return workbook
}

describe('project Excel workbook', () => {
  it('exports all thirteen default data leaves in two header rows and keeps accounting summaries', async () => {
    const workbook = await workbookFor(projectFixture())
    const sheet = workbook.getWorksheet('报销明细表')!
    const headers = sheet.getRow(3).values as string[]
    expect(headers.slice(1)).toEqual([
      '类别', '日期', '详细名称', '价格', '税费', '总价', '实际付款',
      '实际付款人', '已报销', '发票', '支付截图', '其他附件', '备注',
    ])
    expect(sheet.getCell('D4').value).toBe(100.25)
    expect(sheet.getCell('F4').value).toBe(100.5)
    expect(sheet.getCell('G4').value).toBe(100.5)
    expect(sheet.getCell('J4').value).toBe(0)
    expect(workbook.getWorksheet('核算汇总')!.getCell('B4').value).toBe(100.5)
  })

  it('uses saved group order, displayed select labels, and numeric custom and formula values', async () => {
    const project = projectFixture()
    const config = savedConfig()
    config.columns = [
      { id: 'group-trip', name: '行程', kind: 'group' },
      { id: 'custom-distance', name: '里程', kind: 'input', inputType: 'number', parentId: 'group-trip' },
      { id: 'custom-double', name: '双倍', kind: 'formula', parentId: 'group-trip', formula: [
        { type: 'field', value: 'custom-distance' }, { type: 'operator', value: '*' }, { type: 'number', value: '2' },
      ] },
      { id: 'custom-mode', name: '交通方式', kind: 'select', options: [
        { id: 'rail', name: '高铁', color: '#123456' }, { id: 'air', name: '飞机', color: '#654321' },
      ] },
      ...config.columns.filter((column) => column.id !== 'actions'),
      config.columns.find((column) => column.id === 'actions')!,
    ]
    project.tableConfig = config
    project.expenses[0].customValues = { 'custom-distance': '12.5', 'custom-mode': 'rail' }
    const workbook = await workbookFor(project)
    const sheet = workbook.getWorksheet('报销明细表')!
    expect(sheet.getCell('A2').value).toBe('行程')
    expect(sheet.getCell('A3').value).toBe('里程')
    expect(sheet.getCell('B3').value).toBe('双倍')
    expect(sheet.getCell('C3').value).toBe('交通方式')
    expect(sheet.getCell('A4').value).toBe(12.5)
    expect(sheet.getCell('B4').value).toBe(25)
    expect(sheet.getCell('C4').value).toBe('高铁')
    expect(sheet.getCell('B4').type).toBe(ExcelJS.ValueType.Number)
  })

  it('preserves empty and formula error statuses as text and never creates spreadsheet formulas', async () => {
    const project = projectFixture()
    const config = savedConfig()
    config.columns.unshift(
      { id: 'custom-number', name: '待填数值', kind: 'input', inputType: 'number' },
      { id: 'custom-ratio', name: '比例', kind: 'formula', formula: [
        { type: 'number', value: '1' }, { type: 'operator', value: '/' },
        { type: 'field', value: 'custom-number' },
      ] },
      { id: 'custom-text', name: '说明', kind: 'input', inputType: 'text' },
    )
    project.tableConfig = config
    project.expenses[0].customValues = { 'custom-text': '=HYPERLINK("https://example.com")' }
    project.expenses.push({
      ...structuredClone(project.expenses[0]), id: 'expense-2',
      customValues: { 'custom-number': 0 },
    })
    const workbook = await workbookFor(project)
    const sheet = workbook.getWorksheet('报销明细表')!
    expect(sheet.getCell('A4').value).toBe('')
    expect(typeof sheet.getCell('B4').value).toBe('string')
    expect(String(sheet.getCell('B4').value).length).toBeGreaterThan(0)
    expect(sheet.getCell('C4').value).toBe('=HYPERLINK("https://example.com")')
    expect(sheet.getCell('C4').type).toBe(ExcelJS.ValueType.String)
    expect(typeof sheet.getCell('B5').value).toBe('string')
    expect(String(sheet.getCell('B5').value)).toContain('零')
  })

  it('exports attachment counts without changing invoice and payer accounting totals', async () => {
    const project = projectFixture()
    const createdAt = '2026-10-01T00:00:00.000Z'
    project.attachments = (['invoice', 'payment', 'other'] as const).map((kind, index) => ({
      id: `attachment-${index}`, kind, sha256: String(index + 1).repeat(64),
      originalName: `${kind}.pdf`, storedPath: `assets/${kind}.pdf`,
      mimeType: 'application/pdf', size: 1, createdAt,
    }))
    project.invoiceAllocations = [{ id: 'allocation-i', expenseId: 'expense-1', attachmentId: 'attachment-0', allocatedCents: 10050 }]
    project.paymentAllocations = [{ id: 'allocation-p', expenseId: 'expense-1', attachmentId: 'attachment-1', allocatedCents: 10050 }]
    project.otherAllocations = [{ id: 'allocation-o', expenseId: 'expense-1', attachmentId: 'attachment-2', allocatedCents: 10050 }]
    const workbook = await workbookFor(project)
    const detail = workbook.getWorksheet('报销明细表')!
    expect([detail.getCell('J4').value, detail.getCell('K4').value, detail.getCell('L4').value]).toEqual([1, 1, 1])
    const summary = workbook.getWorksheet('核算汇总')!
    expect([summary.getCell('B4').value, summary.getCell('C4').value, summary.getCell('D4').value, summary.getCell('E4').value])
      .toEqual([100.5, 100.5, 100.5, 0])
    expect(summary.getCell('G3').value).toBe('张三')
    expect(summary.getCell('H3').value).toBe(100.5)
  })
})
