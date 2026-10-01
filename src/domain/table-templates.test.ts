import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/models'
import type { TableColumn } from '../shared/table-config'
import { getVisibleTableColumns } from './table-config'
import {
  copyTableTemplate, createTableTemplate, getDefaultTableTemplateId, getTableTemplates,
  prepareTemplateConfig, validateTableTemplates,
} from './table-templates'

function project(): Project {
  return {
    schemaVersion: 1, appVersion: '1', id: 'p', name: 'P', revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    categories: [{ id: 'local-food', name: 'Food', color: '#abc', order: 0 }],
    expenses: [{ id: 'e', categoryId: 'local-food', date: '2026-01-01', name: 'Lunch',
      priceCents: 100, taxCents: 0, actualPayer: 'Alice', note: '', reimbursed: false,
      customValues: { 'custom-used': 'local-option', 'custom-retained': 'note' } }],
    attachments: [], invoiceAllocations: [], paymentAllocations: [], otherAllocations: [],
  }
}

function option(id: string, name: string) { return { id, name, color: '#abc' } }
function col(id: string, kind: TableColumn['kind'], extra: Partial<TableColumn> = {}): TableColumn {
  return { id, name: id, kind, ...extra }
}

describe('global table templates', () => {
  it('synthesizes an editable default with the original 14 leaves and clones it on every read', () => {
    const settings = {}
    const first = getTableTemplates(settings)
    expect(first).toHaveLength(1)
    expect(first[0].id).toBe('template-default')
    expect(first[0].name).toBe('默认模板')
    expect(getDefaultTableTemplateId(settings)).toBe('template-default')
    expect(getVisibleTableColumns(first[0].config)).toHaveLength(14)
    expect(first[0].config.columns.find((item) => item.id === 'category')?.options).toHaveLength(7)
    first[0].config.columns[0].name = 'Changed'
    expect(getTableTemplates(settings)[0].config.columns[0].name).toBe('类别')
  })

  it('creates from audited defaults and copies nested config independently', () => {
    const created = createTableTemplate('Travel', undefined, 'template-travel')
    expect(getVisibleTableColumns(created.config)).toHaveLength(14)
    const copied = copyTableTemplate(created, 'Copy', 'template-copy')
    copied.config.columns.find((item) => item.id === 'category')!.options![0].name = 'Changed'
    expect(created.config.columns.find((item) => item.id === 'category')!.options![0].name).not.toBe('Changed')
  })

  it('requires one valid template and a default that belongs to the set', () => {
    const a = createTableTemplate('A', undefined, 'template-a')
    expect(validateTableTemplates([], 'template-a').length).toBeGreaterThan(0)
    expect(validateTableTemplates([a], 'template-missing').length).toBeGreaterThan(0)
    expect(validateTableTemplates([a, { ...a }], 'template-a').length).toBeGreaterThan(0)
    expect(validateTableTemplates([a], 'template-a')).toEqual([])
  })

  it('rejects duplicate normalized names and a template without a category choice', () => {
    const first = createTableTemplate('Travel', undefined, 'template-travel')
    const second = createTableTemplate(' travel ', undefined, 'template-second')
    expect(validateTableTemplates([first, second], first.id)).toContain('重复模板名称: travel')
    const emptyCategory = createTableTemplate('Empty', undefined, 'template-empty')
    emptyCategory.config.columns.find((item) => item.id === 'category')!.options = []
    expect(validateTableTemplates([emptyCategory], emptyCategory.id)).toContain('Empty: 至少保留一个类别选项')
  })

  it('retains used local category/payer identities on name collision and remaps defaults', () => {
    const local = project()
    local.expenses[0].customValues = {}
    const template = createTableTemplate('Shared', undefined, 'template-shared')
    const category = template.config.columns.find((item) => item.id === 'category')!
    category.options = [option('template-food', 'Food')]
    category.defaultValue = 'template-food'
    const payer = template.config.columns.find((item) => item.id === 'actualPayer')!
    payer.options = [option('template-alice', 'Alice')]
    payer.defaultValue = 'template-alice'
    const merged = prepareTemplateConfig(local, template)
    expect(merged.columns.find((item) => item.id === 'category')?.options).toEqual([option('local-food', 'Food')])
    expect(merged.columns.find((item) => item.id === 'category')?.defaultValue).toBe('local-food')
    const localPayer = merged.columns.find((item) => item.id === 'actualPayer')!
    expect(localPayer.options).toHaveLength(1)
    expect(localPayer.options![0].name).toBe('Alice')
    expect(localPayer.options![0].id).not.toBe('template-alice')
    expect(localPayer.defaultValue).toBe(localPayer.options![0].id)
    expect(template.config.columns.find((item) => item.id === 'category')?.options?.[0].id).toBe('template-food')
  })

  it('preserves data-bearing custom columns, used option IDs, and repairs missing parent links', () => {
    const local = project()
    const localConfig = createTableTemplate('Local').config
    localConfig.columns.find((item) => item.id === 'category')!.options = [option('local-food', 'Food')]
    localConfig.columns.push(col('group-local', 'group'))
    localConfig.columns.push(col('custom-used', 'select', { options: [option('local-option', 'Rail')], parentId: 'group-local' }))
    localConfig.columns.push(col('custom-retained', 'input', { inputType: 'text', parentId: 'group-local' }))
    local.tableConfig = localConfig
    const template = createTableTemplate('Shared')
    template.config.columns.push(col('custom-used', 'select', { options: [option('template-option', 'Rail')], defaultValue: 'template-option' }))
    const merged = prepareTemplateConfig(local, template)
    const selection = merged.columns.find((item) => item.id === 'custom-used')!
    expect(selection.options).toEqual([option('local-option', 'Rail')])
    expect(selection.defaultValue).toBe('local-option')
    expect(merged.columns.find((item) => item.id === 'custom-retained')?.parentId).toBeUndefined()
    expect(local.tableConfig.columns.find((item) => item.id === 'custom-retained')?.parentId).toBe('group-local')
  })

  it('refuses template application when a stored custom value has no column definition', () => {
    const local = project()
    const template = createTableTemplate('Shared')
    expect(() => prepareTemplateConfig(local, template)).toThrow('有数据的自定义列定义缺失: custom-used')
  })
})
