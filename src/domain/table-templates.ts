import type { AppSettings, Project } from '../shared/models'
import { TableConfigSchema } from '../shared/table-config'
import type { TableColumn, TableConfig } from '../shared/table-config'
import { TableTemplateSchema } from '../shared/table-templates'
import type { TableTemplate } from '../shared/table-templates'
import { DEFAULT_CATEGORIES } from './project'
import { getProjectTableConfig, validateTableConfig } from './table-config'

type TemplateSettings = Pick<AppSettings, 'tableTemplates' | 'defaultTableTemplateId'>

const DEFAULT_TEMPLATE_ID = 'template-default'
const DEFAULT_TEMPLATE_NAME = '默认模板'

function cloneConfig(config: TableConfig): TableConfig {
  return TableConfigSchema.parse(config)
}

function cloneTemplate(template: TableTemplate): TableTemplate {
  return { id: template.id, name: template.name, config: cloneConfig(template.config) }
}

function initialConfig(): TableConfig {
  return getProjectTableConfig({
    schemaVersion: 1, appVersion: '1', id: 'template-source', name: DEFAULT_TEMPLATE_NAME,
    revision: 0, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    categories: DEFAULT_CATEGORIES, expenses: [], attachments: [], invoiceAllocations: [],
    paymentAllocations: [], otherAllocations: [],
  })
}

export function getTableTemplates(settings: TemplateSettings): TableTemplate[] {
  return settings.tableTemplates?.map(cloneTemplate)
    ?? [{ id: DEFAULT_TEMPLATE_ID, name: DEFAULT_TEMPLATE_NAME, config: initialConfig() }]
}

export function getDefaultTableTemplateId(settings: TemplateSettings): string {
  const templates = getTableTemplates(settings)
  return templates.some((template) => template.id === settings.defaultTableTemplateId)
    ? settings.defaultTableTemplateId!
    : templates[0]?.id ?? DEFAULT_TEMPLATE_ID
}

export function createTableTemplate(name: string, config?: TableConfig, id?: string): TableTemplate {
  const template = TableTemplateSchema.parse({
    id: id ?? `template-${globalThis.crypto.randomUUID()}`,
    name,
    config: config ? cloneConfig(config) : initialConfig(),
  })
  const errors = validateTableConfig(template.config)
  if (errors.length) throw new Error(errors.join('；'))
  return template
}

export function copyTableTemplate(template: TableTemplate, name: string, id?: string): TableTemplate {
  return createTableTemplate(name, template.config, id)
}

export function validateTableTemplates(templates: TableTemplate[], defaultId: string): string[] {
  const errors: string[] = []
  if (!Array.isArray(templates) || templates.length === 0) return ['至少保留一个有效模板']
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const template of templates) {
    const parsed = TableTemplateSchema.safeParse(template)
    if (!parsed.success) {
      errors.push(`模板格式无效: ${template?.id ?? '未知'}`)
      continue
    }
    if (ids.has(template.id)) errors.push(`重复模板 ID: ${template.id}`)
    ids.add(template.id)
    const normalizedName = template.name.trim().normalize('NFKC').toLocaleLowerCase()
    if (names.has(normalizedName)) errors.push(`重复模板名称: ${normalizedName}`)
    names.add(normalizedName)
    errors.push(...validateTableConfig(template.config).map((error) => `${template.name}: ${error}`))
    if (!template.config.columns.find((column) => column.id === 'category')?.options?.length) {
      errors.push(`${template.name}: 至少保留一个类别选项`)
    }
  }
  if (!ids.has(defaultId)) errors.push('默认模板不存在')
  return [...new Set(errors)]
}

function valuesInUse(project: Project, column: TableColumn): string[] {
  if (column.id === 'category') return [...new Set(project.expenses.map((expense) => expense.categoryId))]
  if (column.id === 'actualPayer') {
    const names = new Set(project.expenses.map((expense) => expense.actualPayer.trim()).filter(Boolean))
    return (column.options ?? []).filter((option) => names.has(option.name)).map((option) => option.id)
  }
  return [...new Set(project.expenses.flatMap((expense) => {
    const value = expense.customValues?.[column.id]
    return Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
  }))]
}

function hasCustomData(project: Project, id: string): boolean {
  return project.expenses.some((expense) => {
    const value = expense.customValues?.[id]
    return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
  })
}

function mergeUsedOptions(target: TableColumn, local: TableColumn, usedIds: string[]): void {
  const options = target.options?.map((option) => ({ ...option })) ?? []
  const localOptions = new Map(local.options?.map((option) => [option.id, option]))
  const remapped = new Map<string, string>()
  for (const id of usedIds) {
    const retained = localOptions.get(id)
    if (!retained) throw new Error(`已使用选项定义缺失: ${local.id}/${id}`)
    const conflicting = options.filter((option) => option.id === id || option.name === retained.name)
    for (const option of conflicting) {
      if (option.id !== id) remapped.set(option.id, id)
      options.splice(options.indexOf(option), 1)
    }
    options.push({ ...retained })
  }
  target.options = options
  if (typeof target.defaultValue === 'string') target.defaultValue = remapped.get(target.defaultValue) ?? target.defaultValue
  else if (Array.isArray(target.defaultValue)) target.defaultValue = target.defaultValue.map((id) => remapped.get(id) ?? id)
}

export function prepareTemplateConfig(project: Project, template: TableTemplate): TableConfig {
  const templateErrors = validateTableTemplates([template], template.id)
  if (templateErrors.length) throw new Error(templateErrors.join('；'))
  const local = getProjectTableConfig(project)
  const target = cloneConfig(template.config)
  const localById = new Map(local.columns.map((column) => [column.id, column]))
  for (const expense of project.expenses) {
    for (const [id, value] of Object.entries(expense.customValues ?? {})) {
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue
      const source = localById.get(id)
      if (!source || !['input', 'select'].includes(source.kind)) throw new Error(`有数据的自定义列定义缺失: ${id}`)
    }
  }
  const targetById = new Map(target.columns.map((column) => [column.id, column]))

  for (const source of local.columns) {
    const current = targetById.get(source.id)
    if (source.kind === 'builtin' && current && (source.id === 'category' || source.id === 'actualPayer')) {
      mergeUsedOptions(current, source, valuesInUse(project, source))
      continue
    }
    if (!['input', 'select'].includes(source.kind) || !hasCustomData(project, source.id)) continue
    if (!current) {
      const retained = cloneConfig({ columns: [source] }).columns[0]
      target.columns.push(retained)
      targetById.set(retained.id, retained)
    } else if (source.kind !== current.kind) {
      const index = target.columns.indexOf(current)
      const retained = cloneConfig({ columns: [source] }).columns[0]
      target.columns[index] = retained
      targetById.set(retained.id, retained)
    } else if (source.kind === 'select') {
      mergeUsedOptions(current, source, valuesInUse(project, source))
    }
  }

  for (const column of target.columns) {
    if (!column.parentId) continue
    const parent = targetById.get(column.parentId)
    if (!parent || parent.kind !== 'group' || parent.parentId || column.kind === 'group') delete column.parentId
  }
  const errors = validateTableConfig(target, project)
  if (errors.length) throw new Error(errors.join('；'))
  return target
}
