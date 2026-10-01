import { describe, expect, it } from 'vitest'
import { AppSettingsSchema } from '../shared/models'
import type { Project } from '../shared/models'
import { createDefaultGlobalDraft, createDefaultProjectDraft, isGlobalDirty, isProjectDirty, normalizeGlobalDraft, normalizeProjectDraft } from './settings-validation'
import { getProjectTableConfig } from '../domain/table-config'
import { copyTableTemplate } from '../domain/table-templates'

const project = (): Project => ({
  schemaVersion: 1, appVersion: '1', id: 'p', name: 'Project', revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  categories: [{ id: 'food', name: 'Food', color: '#2563eb', order: 0 }],
  expenses: [{ id: 'e', categoryId: 'food', date: '2026-01-01', name: 'Lunch', priceCents: 1200,
    taxCents: 100, actualPayer: 'Alice', note: '', reimbursed: false }],
  attachments: [], invoiceAllocations: [], paymentAllocations: [], otherAllocations: [],
})

describe('project settings table draft', () => {
  it('starts from a separate normalized project config and tracks edits', () => {
    const source = project()
    const draft = createDefaultProjectDraft(source)
    expect(isProjectDirty(draft, source)).toBe(false)
    draft.tableConfig.columns.find((column) => column.id === 'name')!.name = 'Expense'
    expect(isProjectDirty(draft, source)).toBe(true)
    expect(source.tableConfig).toBeUndefined()
  })

  it('normalizes category and option labels together for outer save', () => {
    const draft = createDefaultProjectDraft(project())
    draft.categories[0].name = ' Meals '
    draft.tableConfig.columns.find((column) => column.id === 'category')!.options![0].name = ' Meals '
    const normalized = normalizeProjectDraft(draft)
    expect(normalized.categories[0].name).toBe('Meals')
    expect(normalized.tableConfig.columns.find((column) => column.id === 'category')!.options![0].name).toBe('Meals')
  })

  it('recreates canceled nested edits from the same saved project object', () => {
    const source = project()
    source.tableConfig = getProjectTableConfig(source)
    const canceled = createDefaultProjectDraft(source)
    canceled.name = 'Unsaved'
    canceled.categories[0].name = 'Unsaved category'
    canceled.tableConfig.columns.find((column) => column.id === 'category')!.options![0].name = 'Unsaved option'

    const reopened = createDefaultProjectDraft(source)
    expect(reopened.name).toBe('Project')
    expect(reopened.categories[0].name).toBe('Food')
    expect(reopened.tableConfig.columns.find((column) => column.id === 'category')!.options![0].name).toBe('Food')
    expect(isProjectDirty(reopened, source)).toBe(false)
  })
})

describe('global table template draft', () => {
  it('synthesizes an editable legacy default and tracks staged template changes', () => {
    const settings = AppSettingsSchema.parse({})
    const draft = createDefaultGlobalDraft(settings)
    expect(draft.tableTemplates).toHaveLength(1)
    expect(draft.defaultTableTemplateId).toBe(draft.tableTemplates[0].id)
    expect(isGlobalDirty(draft, settings)).toBe(false)

    const copied = copyTableTemplate(draft.tableTemplates[0], 'Copy', 'template-copy')
    draft.tableTemplates.push(copied)
    draft.defaultTableTemplateId = copied.id
    copied.config.columns.find((column) => column.id === 'name')!.name = 'Copied name'
    expect(draft.tableTemplates[0].config.columns.find((column) => column.id === 'name')!.name).not.toBe('Copied name')
    expect(isGlobalDirty(draft, settings)).toBe(true)
  })

  it('normalizes template and option labels before outer save without changing the source draft', () => {
    const draft = createDefaultGlobalDraft(AppSettingsSchema.parse({}))
    draft.tableTemplates[0].name = ' Renamed '
    const option = draft.tableTemplates[0].config.columns.find((column) => column.id === 'category')!.options![0]
    option.name = ' Label '
    const normalized = normalizeGlobalDraft(draft)
    expect(normalized.tableTemplates[0].name).toBe('Renamed')
    expect(normalized.tableTemplates[0].config.columns.find((column) => column.id === 'category')!.options![0].name).toBe('Label')
    expect(draft.tableTemplates[0].name).toBe(' Renamed ')
    expect(option.name).toBe(' Label ')
  })
})
