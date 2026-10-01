import { describe, expect, it } from 'vitest'
import { ProjectSchema } from '../shared/models'
import type { Project } from '../shared/models'
import type { TableColumn, TableConfig } from '../shared/table-config'
import {
  applyTableConfig, createExpenseCustomValues, evaluateFormula, getProjectPayerNames,
  getProjectTableConfig, getTableCellValue, getTableHeaderGroups, getVisibleTableColumns,
  moveTableColumn, validateTableConfig,
} from './table-config'

function project(): Project {
  return {
    schemaVersion: 1, appVersion: '1', id: 'p', name: 'P', revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    categories: [{ id: 'food', name: 'Food', color: '#abc', order: 0 }],
    expenses: [{ id: 'e', categoryId: 'food', date: '2026-01-01', name: 'Lunch', priceCents: 1200,
      taxCents: 100, actualPayer: 'Alice', note: '', reimbursed: false }],
    attachments: [], invoiceAllocations: [], paymentAllocations: [], otherAllocations: [],
  }
}

function column(id: string, kind: TableColumn['kind'], extra: Partial<TableColumn> = {}): TableColumn {
  return { id, name: id, kind, ...extra }
}

describe('project table configuration', () => {
  it('starts with the 14 original leaves, two groups, and existing widths', () => {
    const config = getProjectTableConfig(project())
    expect(getVisibleTableColumns(config).map((item) => [item.id, item.width])).toEqual([
      ['category', 120], ['date', 140], ['name', 220], ['price', 110], ['tax', 110], ['total', 100],
      ['actualPayment', 100], ['actualPayer', 130], ['reimbursed', 80], ['invoice', 100],
      ['payment', 100], ['other', 100], ['note', 220], ['actions', 54],
    ])
    expect(getTableHeaderGroups(config).filter((item) => item.children.length).map((item) => item.column.id)).toEqual(['amount', 'attachments'])
    expect(config.columns.filter((item) => item.kind === 'group')).toHaveLength(2)
  })

  it('derives legacy payer options only from this project and keeps stable IDs when reopened', () => {
    const legacy = project()
    legacy.expenses.push({ ...legacy.expenses[0], id: 'e2', actualPayer: 'Bob' })
    expect(getProjectPayerNames(legacy)).toEqual(['Alice', 'Bob'])
    const configured = getProjectTableConfig(legacy)
    const payer = configured.columns.find((item) => item.id === 'actualPayer')!
    expect(payer.options?.map((item) => item.name)).toEqual(['Alice', 'Bob'])
    const saved = ProjectSchema.parse({ ...legacy, tableConfig: configured })
    expect(getProjectTableConfig(saved).columns.find((item) => item.id === 'actualPayer')?.options).toEqual(payer.options)
  })

  it('moves a leaf into a group in visible order and rejects deeper or self nesting', () => {
    const config = getProjectTableConfig(project())
    const moved = moveTableColumn(config, 'date', 'amount', 'tax')
    expect(getVisibleTableColumns(moved).slice(0, 6).map((item) => item.id)).toEqual(['category', 'name', 'price', 'date', 'tax', 'total'])
    expect(() => moveTableColumn(moved, 'amount', 'attachments')).toThrow()
    expect(() => moveTableColumn(moved, 'amount', 'amount')).toThrow()
    expect(config.columns.find((item) => item.id === 'date')?.parentId).toBeUndefined()
  })

  it('applies category and payer renames atomically, preserving record references', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.find((item) => item.id === 'category')!.options![0].name = 'Meals'
    config.columns.find((item) => item.id === 'actualPayer')!.options![0].name = 'Alicia'
    const saved = applyTableConfig(original, config)
    expect(saved.categories[0].name).toBe('Meals')
    expect(saved.expenses[0].categoryId).toBe('food')
    expect(saved.expenses[0].actualPayer).toBe('Alicia')
    expect(original.expenses[0].actualPayer).toBe('Alice')
    const invalid = getProjectTableConfig(original)
    invalid.columns.find((item) => item.id === 'actualPayer')!.options = []
    expect(() => applyTableConfig(original, invalid)).toThrow()
    expect(original.expenses[0].actualPayer).toBe('Alice')
  })

  it('retains select IDs and values through schema roundtrip and removes only deleted custom values', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.push(column('custom-choice', 'select', { options: [{ id: 'o1', name: 'Blue', color: '#abc' }], defaultValue: 'o1' }))
    config.columns.push(column('custom-count', 'input', { inputType: 'number', defaultValue: 0 }))
    expect(createExpenseCustomValues(config)).toEqual({ 'custom-choice': 'o1', 'custom-count': 0 })
    original.expenses[0].customValues = { 'custom-choice': 'o1', 'custom-gone': 'old' }
    const saved = ProjectSchema.parse(applyTableConfig(original, config))
    expect(saved.expenses[0].customValues).toEqual({ 'custom-choice': 'o1' })
    expect(getTableCellValue(config.columns.at(-2)!, saved.expenses[0], saved)).toBe('Blue')
    expect(getProjectTableConfig(saved).columns.find((item) => item.id === 'custom-choice')?.options?.[0].id).toBe('o1')
  })

  it('distinguishes empty, zero, division by zero and malformed formulas', () => {
    const original = project()
    const number = column('custom-number', 'input', { inputType: 'number' })
    const formula = column('custom-result', 'formula', { formula: [
      { type: 'operator', value: '(' }, { type: 'field', value: 'custom-number' },
      { type: 'operator', value: '+' }, { type: 'number', value: '2' },
      { type: 'operator', value: ')' }, { type: 'operator', value: '*' },
      { type: 'field', value: 'price' },
    ] })
    original.tableConfig = { columns: [...getProjectTableConfig(original).columns, number, formula] }
    expect(evaluateFormula(formula, original.expenses[0], original).status).toBe('empty')
    original.expenses[0].customValues = { 'custom-number': 0 }
    expect(evaluateFormula(formula, original.expenses[0], original)).toEqual({ status: 'ok', value: 24 })
    const divide = column('custom-divide', 'formula', { formula: [
      { type: 'field', value: 'price' }, { type: 'operator', value: '/' },
      { type: 'field', value: 'custom-number' },
    ] })
    expect(evaluateFormula(divide, original.expenses[0], original).status).toBe('error')
    expect(validateTableConfig({ columns: [...original.tableConfig.columns, column('custom-bad', 'formula', {
      formula: [{ type: 'field', value: 'unknown' }],
    })] }, original)).not.toEqual([])
  })

  it('accepts syntactically valid division while reporting zero denominators at evaluation', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    const formula = column('custom-ratio', 'formula', { formula: [
      { type: 'field', value: 'price' }, { type: 'operator', value: '/' },
      { type: 'operator', value: '(' }, { type: 'field', value: 'tax' },
      { type: 'operator', value: '-' }, { type: 'field', value: 'price' },
      { type: 'operator', value: ')' },
    ] })
    config.columns.push(formula)
    expect(validateTableConfig(config, original)).toEqual([])
    original.tableConfig = config
    expect(evaluateFormula(formula, original.expenses[0], original)).toEqual({ status: 'ok', value: -12 / 11 })
  })

  it('rejects duplicate IDs, modified built-in identities, used category removal, and nonfinite defaults', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.push(column('category', 'input'))
    expect(validateTableConfig(config, original).length).toBeGreaterThan(0)
    config.columns.pop()
    config.columns.find((item) => item.id === 'category')!.builtin = 'name'
    expect(validateTableConfig(config, original).length).toBeGreaterThan(0)
    config.columns.find((item) => item.id === 'category')!.builtin = 'category'
    config.columns.find((item) => item.id === 'category')!.options = []
    expect(validateTableConfig(config, original).length).toBeGreaterThan(0)
    config.columns.find((item) => item.id === 'category')!.options = [{ id: 'food', name: 'Food', color: '#abc' }]
    config.columns.push(column('custom-n', 'input', { inputType: 'number', defaultValue: Infinity }))
    expect(validateTableConfig(config, original).length).toBeGreaterThan(0)
  })

  it('rejects nonfinite values already stored in expenses before applying config', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.push(column('custom-n', 'input', { inputType: 'number' }))
    original.expenses[0].customValues = { 'custom-n': Infinity }
    expect(validateTableConfig(config, original)).toContain('无效数字数据: custom-n')
    expect(() => applyTableConfig(original, config)).toThrow()
  })

  it('omits empty and hidden groups from headers and rejects orphaned children', () => {
    const config: TableConfig = { columns: [
      column('group-empty', 'group'), column('group-hidden', 'group', { visible: false }),
      column('custom-a', 'input', { parentId: 'group-hidden' }),
      column('custom-b', 'input'),
    ] }
    expect(getTableHeaderGroups(config).map((item) => item.column.id)).toEqual(['custom-b'])
    const full = getProjectTableConfig(project())
    full.columns.push(column('custom-orphan', 'input', { parentId: 'missing' }))
    expect(validateTableConfig(full)).toContain('无效分组关系: custom-orphan')
  })

  it('recovers a corrupt stored layout without mutating the project', () => {
    const original = project()
    const corrupt = getProjectTableConfig(original)
    corrupt.columns.find((item) => item.id === 'category')!.parentId = 'missing'
    original.tableConfig = corrupt
    expect(getVisibleTableColumns(getProjectTableConfig(original))[0].id).toBe('category')
    expect(original.tableConfig.columns.find((item) => item.id === 'category')?.parentId).toBe('missing')
  })

  it('rejects a category name that the persisted project schema cannot save', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.find((item) => item.id === 'category')!.options![0].name = 'x'.repeat(41)
    expect(validateTableConfig(config, original)).toContain('类别名称过长: food')
  })

  it('returns numeric custom inputs as numbers for workbook cells', () => {
    const original = project()
    const numeric = column('custom-cost', 'input', { inputType: 'number' })
    original.expenses[0].customValues = { 'custom-cost': '12.5' }
    expect(getTableCellValue(numeric, original.expenses[0], original)).toBe(12.5)
    original.expenses[0].customValues = { 'custom-cost': '' }
    expect(getTableCellValue(numeric, original.expenses[0], original)).toBeNull()
  })

  it('rejects nonfinite built-in money in validation and formula evaluation', () => {
    const original = project()
    original.expenses[0].priceCents = Infinity
    const config = getProjectTableConfig(original)
    const formula = column('custom-price', 'formula', { formula: [{ type: 'field', value: 'price' }] })
    config.columns.push(formula)
    expect(validateTableConfig(config, original)).toContain('无效金额数据: e')
    expect(evaluateFormula(formula, original.expenses[0], original).status).toBe('error')
  })

  it('converts retained numeric inputs to text and numeric text back to numbers', () => {
    const original = project()
    const before = getProjectTableConfig(original)
    before.columns.push(column('custom-data', 'input', { inputType: 'number' }))
    original.tableConfig = before
    original.expenses[0].customValues = { 'custom-data': 12.5 }
    const asText = getProjectTableConfig(original)
    asText.columns.find((item) => item.id === 'custom-data')!.inputType = 'text'
    const textProject = applyTableConfig(original, asText)
    expect(textProject.expenses[0].customValues?.['custom-data']).toBe('12.5')
    const asNumber = getProjectTableConfig(textProject)
    asNumber.columns.find((item) => item.id === 'custom-data')!.inputType = 'number'
    const numericProject = applyTableConfig(textProject, asNumber)
    expect(numericProject.expenses[0].customValues?.['custom-data']).toBe(12.5)
    expect(original.expenses[0].customValues?.['custom-data']).toBe(12.5)
  })

  it('rejects nonnumeric text when changing an input to number', () => {
    const original = project()
    const before = getProjectTableConfig(original)
    before.columns.push(column('custom-data', 'input', { inputType: 'text' }))
    original.tableConfig = before
    original.expenses[0].customValues = { 'custom-data': 'twelve' }
    const after = getProjectTableConfig(original)
    after.columns.find((item) => item.id === 'custom-data')!.inputType = 'number'
    expect(validateTableConfig(after, original)).toContain('无效数字数据: custom-data')
    expect(() => applyTableConfig(original, after)).toThrow()
  })

  it('converts a select between single and multi while preserving the selected option ID', () => {
    const original = project()
    const before = getProjectTableConfig(original)
    before.columns.push(column('custom-choice', 'select', { options: [{ id: 'train', name: 'Train', color: '#abc' }], multi: false }))
    original.tableConfig = before
    original.expenses[0].customValues = { 'custom-choice': 'train' }
    const multi = getProjectTableConfig(original)
    multi.columns.find((item) => item.id === 'custom-choice')!.multi = true
    const multiProject = applyTableConfig(original, multi)
    expect(multiProject.expenses[0].customValues?.['custom-choice']).toEqual(['train'])
    const single = getProjectTableConfig(multiProject)
    single.columns.find((item) => item.id === 'custom-choice')!.multi = false
    expect(applyTableConfig(multiProject, single).expenses[0].customValues?.['custom-choice']).toBe('train')
  })

  it('rejects multi-to-single when a record has multiple choices', () => {
    const original = project()
    const before = getProjectTableConfig(original)
    before.columns.push(column('custom-choice', 'select', { options: [
      { id: 'train', name: 'Train', color: '#abc' }, { id: 'bus', name: 'Bus', color: '#abc' },
    ], multi: true }))
    original.tableConfig = before
    original.expenses[0].customValues = { 'custom-choice': ['train', 'bus'] }
    const single = getProjectTableConfig(original)
    single.columns.find((item) => item.id === 'custom-choice')!.multi = false
    expect(validateTableConfig(single, original)).toContain('多选值无法转为单选: custom-choice')
    expect(() => applyTableConfig(original, single)).toThrow()
  })

  it('rejects incompatible defaults and imported custom value shapes', () => {
    const original = project()
    const config = getProjectTableConfig(original)
    config.columns.push(column('custom-choice', 'select', { options: [{ id: 'a', name: 'A', color: '#abc' }], multi: true, defaultValue: 'a' }))
    config.columns.push(column('custom-number', 'input', { inputType: 'number', defaultValue: ['a'] }))
    expect(validateTableConfig(config, original)).toContain('多选默认值无效: custom-choice')
    expect(validateTableConfig(config, original)).toContain('无效数字默认值: custom-number')
    config.columns.at(-2)!.defaultValue = ['a']
    config.columns.at(-1)!.defaultValue = null
    original.expenses[0].customValues = { 'custom-choice': 12, 'custom-number': ['12'] }
    expect(validateTableConfig(config, original)).toContain('无效选项数据: custom-choice')
    expect(validateTableConfig(config, original)).toContain('无效数字数据: custom-number')
  })

  it('retains valid custom columns when one stored formula is invalid and repairs only an orphan parent', () => {
    const original = project()
    const stored = getProjectTableConfig(original)
    stored.columns.push(column('custom-kept', 'input', { inputType: 'text' }))
    stored.columns.push(column('custom-bad', 'formula', { formula: [{ type: 'field', value: 'missing' }] }))
    stored.columns.find((item) => item.id === 'custom-kept')!.parentId = 'missing'
    original.tableConfig = stored
    const recovered = getProjectTableConfig(original)
    expect(recovered.columns.find((item) => item.id === 'custom-kept')?.parentId).toBeUndefined()
    expect(recovered.columns.find((item) => item.id === 'custom-bad')?.kind).toBe('formula')
    expect(validateTableConfig(recovered)).toContain('公式引用无效: custom-bad')
    expect(original.tableConfig.columns.find((item) => item.id === 'custom-kept')?.parentId).toBe('missing')
  })

  it('reports a structurally corrupt stored config instead of replacing it with defaults', () => {
    const original = project()
    const stored = getProjectTableConfig(original)
    stored.columns.push(column('custom-kept', 'input', { inputType: 'text' }))
    stored.columns.find((item) => item.id === 'custom-kept')!.width = Infinity
    original.tableConfig = stored
    expect(() => getProjectTableConfig(original)).toThrow('表格配置格式无效')
    expect(original.tableConfig.columns.some((item) => item.id === 'custom-kept')).toBe(true)
  })
})
