import type { ExpenseItem, Project } from '../shared/models'
import { TableConfigSchema } from '../shared/table-config'
import type { CustomValue, FormulaToken, TableColumn, TableConfig } from '../shared/table-config'

const BUILTIN_IDS = [
  'category', 'date', 'name', 'price', 'tax', 'total', 'actualPayment', 'actualPayer',
  'reimbursed', 'invoice', 'payment', 'other', 'note', 'actions',
] as const
const BUILTIN_SET = new Set<string>(BUILTIN_IDS)
const NUMERIC_BUILTINS = new Set(['price', 'tax', 'total', 'actualPayment'])

const DEFAULT_COLUMNS: TableColumn[] = [
  { id: 'category', name: '类别', kind: 'builtin', builtin: 'category', width: 120 },
  { id: 'date', name: '日期', kind: 'builtin', builtin: 'date', width: 140 },
  { id: 'name', name: '详细名称', kind: 'builtin', builtin: 'name', width: 220 },
  { id: 'amount', name: '金额', kind: 'group' },
  { id: 'price', name: '价格', kind: 'builtin', builtin: 'price', parentId: 'amount', width: 110 },
  { id: 'tax', name: '税费', kind: 'builtin', builtin: 'tax', parentId: 'amount', width: 110 },
  { id: 'total', name: '总价', kind: 'builtin', builtin: 'total', parentId: 'amount', width: 100 },
  { id: 'actualPayment', name: '实际付款', kind: 'builtin', builtin: 'actualPayment', width: 100 },
  { id: 'actualPayer', name: '实际付款人', kind: 'builtin', builtin: 'actualPayer', width: 130 },
  { id: 'reimbursed', name: '已报销', kind: 'builtin', builtin: 'reimbursed', width: 80 },
  { id: 'attachments', name: '附件', kind: 'group' },
  { id: 'invoice', name: '发票', kind: 'builtin', builtin: 'invoice', parentId: 'attachments', width: 100 },
  { id: 'payment', name: '支付截图', kind: 'builtin', builtin: 'payment', parentId: 'attachments', width: 100 },
  { id: 'other', name: '其他附件', kind: 'builtin', builtin: 'other', parentId: 'attachments', width: 100 },
  { id: 'note', name: '备注', kind: 'builtin', builtin: 'note', width: 220 },
  { id: 'actions', name: '操作', kind: 'builtin', builtin: 'actions', width: 54 },
]

function cloneConfig(config: TableConfig): TableConfig {
  return { columns: config.columns.map((column) => ({
    ...column, options: column.options?.map((option) => ({ ...option })),
    formula: column.formula?.map((token) => ({ ...token })),
    defaultValue: Array.isArray(column.defaultValue) ? [...column.defaultValue] : column.defaultValue,
  })) }
}

function stablePayerId(name: string): string {
  return `payer-${Array.from(name).map((char) => char.codePointAt(0)!.toString(16)).join('-')}`
}

function usedPayerNames(project: Project): string[] {
  return [...new Set(project.expenses.map((expense) => expense.actualPayer.trim()).filter(Boolean))]
}

export function getProjectPayerNames(project: Project): string[] {
  const saved = TableConfigSchema.safeParse(project.tableConfig)
  const configured = saved.success
    ? saved.data.columns.find((column) => column.id === 'actualPayer')?.options?.map((option) => option.name) ?? []
    : []
  return [...new Set([...configured, ...usedPayerNames(project)])]
}

export function getProjectTableConfig(project: Project): TableConfig {
  const saved = TableConfigSchema.safeParse(project.tableConfig)
  if (project.tableConfig !== undefined && !saved.success) throw new Error('表格配置格式无效')
  const config = saved.success ? cloneConfig(saved.data) : cloneConfig({ columns: DEFAULT_COLUMNS })
  const existing = new Set(config.columns.map((column) => column.id))
  for (const builtin of DEFAULT_COLUMNS.filter((column) => column.kind === 'builtin')) {
    if (!existing.has(builtin.id)) config.columns.push({ ...builtin })
  }
  const category = config.columns.find((column) => column.id === 'category')!
  if (!saved.success || !category.options) {
    category.options = project.categories.slice().sort((a, b) => a.order - b.order)
      .map(({ id, name, color }) => ({ id, name, color }))
  }
  const payer = config.columns.find((column) => column.id === 'actualPayer')!
  payer.options ??= []
  const configuredNames = new Set(payer.options.map((option) => option.name))
  for (const name of usedPayerNames(project)) {
    if (!configuredNames.has(name)) payer.options.push({ id: stablePayerId(name), name, color: '#64748b' })
  }
  const byId = new Map(config.columns.map((column) => [column.id, column]))
  for (const column of config.columns) {
    if (!column.parentId) continue
    const parent = byId.get(column.parentId)
    if (parent?.kind !== 'group' || parent.parentId || parent.id === column.id || column.kind === 'group') {
      delete column.parentId
    }
  }
  return config
}

export function getTableHeaderGroups(config: TableConfig): Array<{ column: TableColumn; children: TableColumn[] }> {
  return config.columns.filter((column) => !column.parentId && column.visible !== false).flatMap((column) => {
    if (column.kind !== 'group') return [{ column, children: [] }]
    const children = config.columns.filter((child) => child.parentId === column.id && child.visible !== false && child.kind !== 'group')
    return children.length ? [{ column, children }] : []
  })
}

export function getVisibleTableColumns(config: TableConfig): TableColumn[] {
  return getTableHeaderGroups(config).flatMap(({ column, children }) => children.length ? children : [column])
}

export function moveTableColumn(config: TableConfig, id: string, parentId?: string, beforeId?: string): TableConfig {
  const result = cloneConfig(config)
  const source = result.columns.find((column) => column.id === id)
  if (!source) throw new Error(`Unknown column: ${id}`)
  if (parentId === id) throw new Error('A group cannot contain itself')
  const parent = parentId ? result.columns.find((column) => column.id === parentId) : undefined
  if (parentId && (!parent || parent.kind !== 'group' || parent.parentId || source.kind === 'group')) {
    throw new Error('Only leaf columns may be moved into a root group')
  }
  if (beforeId === id) return result
  const before = beforeId ? result.columns.find((column) => column.id === beforeId) : undefined
  if (beforeId && (!before || before.parentId !== parentId)) throw new Error('Target must be a sibling')
  result.columns.splice(result.columns.indexOf(source), 1)
  if (parentId) source.parentId = parentId
  else delete source.parentId
  if (before) result.columns.splice(result.columns.indexOf(before), 0, source)
  else {
    const siblings = result.columns.filter((column) => column.parentId === parentId)
    const last = siblings.at(-1)
    result.columns.splice(last ? result.columns.indexOf(last) + 1 : result.columns.length, 0, source)
  }
  return result
}

export function isNumericTableColumn(column: TableColumn): boolean {
  return (column.kind === 'builtin' && NUMERIC_BUILTINS.has(column.builtin ?? column.id))
    || (column.kind === 'input' && column.inputType === 'number')
}

function numericValue(column: TableColumn, expense: ExpenseItem): number | null | 'invalid' {
  if (column.kind === 'builtin') {
    if (!Number.isFinite(expense.priceCents) || !Number.isFinite(expense.taxCents)) return 'invalid'
    switch (column.builtin ?? column.id) {
      case 'price': return expense.priceCents / 100
      case 'tax': return expense.taxCents / 100
      case 'total':
      case 'actualPayment': return (expense.priceCents + expense.taxCents) / 100
    }
  }
  const value = expense.customValues?.[column.id]
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'invalid'
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return 'invalid'
}

class FormulaError extends Error {}

function parseFormula(
  tokens: FormulaToken[], resolve: (id: string) => number | null | 'invalid', syntaxOnly = false,
): number | null {
  let index = 0
  const peek = () => tokens[index]
  const take = () => tokens[index++]
  const primary = (): number | null => {
    const token = take()
    if (!token) throw new FormulaError('公式不完整')
    if (token.type === 'operator' && token.value === '(') {
      const value = expression()
      const closing = take()
      if (closing?.type !== 'operator' || closing.value !== ')') throw new FormulaError('括号不匹配')
      return value
    }
    if (token.type === 'number') {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token.value)) throw new FormulaError('无效数字')
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new FormulaError('无效数字')
      return value
    }
    if (token.type === 'field') {
      const value = resolve(token.value)
      if (value === 'invalid') throw new FormulaError('无效数值或字段')
      return value
    }
    throw new FormulaError('无效公式符号')
  }
  const unary = (): number | null => {
    if (peek()?.type === 'operator' && ['+', '-'].includes(peek().value)) {
      const op = take().value
      const value = unary()
      return value === null ? null : op === '-' ? -value : value
    }
    return primary()
  }
  const term = (): number | null => {
    let left = unary()
    while (peek()?.type === 'operator' && ['*', '/'].includes(peek().value)) {
      const op = take().value
      const right = unary()
      if (op === '/' && right === 0 && !syntaxOnly) throw new FormulaError('不能除以零')
      left = left === null || right === null ? null : op === '*' ? left * right : right === 0 ? 0 : left / right
      if (left !== null && !Number.isFinite(left) && !syntaxOnly) throw new FormulaError('计算结果无效')
    }
    return left
  }
  const expression = (): number | null => {
    let left = term()
    while (peek()?.type === 'operator' && ['+', '-'].includes(peek().value)) {
      const op = take().value
      const right = term()
      left = left === null || right === null ? null : op === '+' ? left + right : left - right
      if (left !== null && !Number.isFinite(left) && !syntaxOnly) throw new FormulaError('计算结果无效')
    }
    return left
  }
  if (!tokens.length) throw new FormulaError('公式为空')
  const value = expression()
  if (index !== tokens.length) throw new FormulaError('无效公式符号')
  if (value !== null && !Number.isFinite(value)) throw new FormulaError('计算结果无效')
  return value
}

export function evaluateFormula(column: TableColumn, expense: ExpenseItem, project: Project): {
  status: 'ok' | 'empty' | 'error'; value?: number; message?: string
} {
  try {
    if (column.kind !== 'formula') throw new FormulaError('不是公式列')
    const columns = getProjectTableConfig(project).columns
    const value = parseFormula(column.formula ?? [], (id) => {
      const reference = columns.find((item) => item.id === id)
      return reference && isNumericTableColumn(reference) ? numericValue(reference, expense) : 'invalid'
    })
    return value === null ? { status: 'empty', message: '缺少数值' } : { status: 'ok', value }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : '公式错误' }
  }
}

function optionLabels(column: TableColumn, value: CustomValue | undefined): string | string[] | null {
  if (value === undefined || value === null || value === '') return null
  const label = (id: string) => column.options?.find((option) => option.id === id)?.name ?? id
  return Array.isArray(value) ? value.map(label) : label(String(value))
}

export function getTableCellValue(
  column: TableColumn, expense: ExpenseItem, project: Project,
): string | number | boolean | string[] | null {
  if (column.kind === 'formula') {
    const result = evaluateFormula(column, expense, project)
    return result.status === 'ok' ? result.value! : result.message ?? ''
  }
  if (column.kind === 'input') {
    if (column.inputType === 'number') {
      const value = numericValue(column, expense)
      return value === 'invalid' ? '无效数值' : value
    }
    return expense.customValues?.[column.id] ?? null
  }
  if (column.kind === 'select') return optionLabels(column, expense.customValues?.[column.id])
  switch (column.builtin ?? column.id) {
    case 'category': return project.categories.find((item) => item.id === expense.categoryId)?.name ?? expense.categoryId
    case 'date': return expense.date
    case 'name': return expense.name
    case 'price': return expense.priceCents / 100
    case 'tax': return expense.taxCents / 100
    case 'total':
    case 'actualPayment': return (expense.priceCents + expense.taxCents) / 100
    case 'actualPayer': return expense.actualPayer
    case 'reimbursed': return expense.reimbursed
    case 'invoice': return project.invoiceAllocations.filter((item) => item.expenseId === expense.id).length
    case 'payment': return project.paymentAllocations.filter((item) => item.expenseId === expense.id).length
    case 'other': return project.otherAllocations.filter((item) => item.expenseId === expense.id).length
    case 'note': return expense.note
    default: return null
  }
}

export function createExpenseCustomValues(config: TableConfig): Record<string, CustomValue> {
  const values: Record<string, CustomValue> = {}
  for (const column of config.columns) {
    if (['input', 'select'].includes(column.kind) && column.defaultValue !== undefined && column.defaultValue !== null) {
      values[column.id] = Array.isArray(column.defaultValue) ? [...column.defaultValue] : column.defaultValue
    }
  }
  return values
}

function convertedCustomValue(column: TableColumn, value: CustomValue): CustomValue {
  if (value === null || value === '') return value
  if (column.kind === 'input') {
    if (column.inputType === 'number') return typeof value === 'number' ? value : Number(value)
    return typeof value === 'number' ? String(value) : value
  }
  if (column.kind === 'select') {
    if (column.multi) return Array.isArray(value) ? [...value] : [String(value)]
    return Array.isArray(value) ? value[0] ?? null : value
  }
  return value
}

export function validateTableConfig(config: TableConfig, project?: Project): string[] {
  const errors: string[] = []
  const parsed = TableConfigSchema.safeParse(config)
  if (!parsed.success) return ['表格配置格式无效']
  const ids = new Set<string>()
  const columns = new Map<string, TableColumn>()
  for (const column of config.columns) {
    if (ids.has(column.id)) errors.push(`重复列 ID: ${column.id}`)
    ids.add(column.id)
    columns.set(column.id, column)
  }
  for (const id of BUILTIN_IDS) {
    const column = columns.get(id)
    if (!column || column.kind !== 'builtin' || column.builtin !== id) errors.push(`内置列不可删除或更改身份: ${id}`)
  }
  for (const column of config.columns) {
    if (column.kind === 'builtin' && (!BUILTIN_SET.has(column.id) || column.builtin !== column.id)) errors.push(`无效内置列: ${column.id}`)
    if (column.kind === 'group' && !['amount', 'attachments'].includes(column.id) && !column.id.startsWith('group-')) errors.push(`无效分组 ID: ${column.id}`)
    if (['input', 'select', 'formula'].includes(column.kind) && !column.id.startsWith('custom-')) errors.push(`自定义列 ID 必须以 custom- 开头: ${column.id}`)
    if (column.parentId) {
      const parent = columns.get(column.parentId)
      if (column.parentId === column.id || parent?.kind !== 'group' || parent.parentId || column.kind === 'group') errors.push(`无效分组关系: ${column.id}`)
    }
    if (column.kind === 'input' && column.defaultValue !== undefined && column.defaultValue !== null) {
      if (column.inputType === 'number' ? typeof column.defaultValue !== 'number' || !Number.isFinite(column.defaultValue)
        : typeof column.defaultValue !== 'string') errors.push(`无效${column.inputType === 'number' ? '数字' : '文本'}默认值: ${column.id}`)
    }
    if (column.kind === 'select' || column.id === 'category' || column.id === 'actualPayer') {
      const optionIds = new Set<string>()
      const optionNames = new Set<string>()
      for (const option of column.options ?? []) {
        if (column.id === 'category' && option.name.length > 40) errors.push(`类别名称过长: ${option.id}`)
        if (optionIds.has(option.id) || optionNames.has(option.name)) errors.push(`重复选项: ${column.id}`)
        optionIds.add(option.id)
        optionNames.add(option.name)
      }
      if ((column.id === 'category' || column.id === 'actualPayer') && column.multi) errors.push(`内置选项仅支持单选: ${column.id}`)
      if (column.defaultValue !== undefined && column.defaultValue !== null) {
        if (column.multi && !Array.isArray(column.defaultValue)) errors.push(`多选默认值无效: ${column.id}`)
        if (!column.multi && typeof column.defaultValue !== 'string') errors.push(`单选默认值无效: ${column.id}`)
      }
      const defaults = Array.isArray(column.defaultValue) ? column.defaultValue : column.defaultValue === undefined || column.defaultValue === null ? [] : [String(column.defaultValue)]
      if (defaults.some((id) => !optionIds.has(id))) errors.push(`默认选项不存在: ${column.id}`)
    }
    if (column.kind === 'formula') {
      for (const token of column.formula ?? []) {
        if (token.type === 'field' && !isNumericTableColumn(columns.get(token.value) ?? { id: '', name: '', kind: 'group' })) errors.push(`公式引用无效: ${column.id}`)
      }
      try { parseFormula(column.formula ?? [], () => 1, true) } catch { errors.push(`公式语法无效: ${column.id}`) }
    }
  }
  if (project) {
    const category = columns.get('category')
    const categoryIds = new Set(category?.options?.map((option) => option.id))
    const payer = columns.get('actualPayer')
    const oldPayer = getProjectTableConfig(project).columns.find((item) => item.id === 'actualPayer')
    const oldByName = new Map(oldPayer?.options?.map((option) => [option.name, option.id]))
    const newPayerIds = new Set(payer?.options?.map((option) => option.id))
    for (const expense of project.expenses) {
      if (!Number.isFinite(expense.priceCents) || !Number.isFinite(expense.taxCents)) errors.push(`无效金额数据: ${expense.id}`)
      for (const column of config.columns.filter((item) => item.kind === 'input' && item.inputType === 'number')) {
        if (numericValue(column, expense) === 'invalid') errors.push(`无效数字数据: ${column.id}`)
      }
      for (const column of config.columns.filter((item) => item.kind === 'input' && item.inputType !== 'number')) {
        const value = expense.customValues?.[column.id]
        if (value !== undefined && value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`无效文本数据: ${column.id}`)
      }
      if (!categoryIds.has(expense.categoryId)) errors.push(`已使用类别不可删除: ${expense.categoryId}`)
      if (expense.actualPayer.trim() && !newPayerIds.has(oldByName.get(expense.actualPayer.trim()) ?? '')) errors.push(`已使用付款人不可删除: ${expense.actualPayer}`)
      for (const column of config.columns.filter((item) => item.kind === 'select')) {
        const selected = expense.customValues?.[column.id]
        if (selected !== undefined && selected !== null && typeof selected !== 'string' && !Array.isArray(selected)) errors.push(`无效选项数据: ${column.id}`)
        if (Array.isArray(selected) && selected.some((id) => typeof id !== 'string')) errors.push(`无效选项数据: ${column.id}`)
        if (!column.multi && Array.isArray(selected) && selected.length > 1) errors.push(`多选值无法转为单选: ${column.id}`)
        const selectedIds = Array.isArray(selected) ? selected : selected == null || selected === '' ? [] : [String(selected)]
        const allowed = new Set(column.options?.map((option) => option.id))
        if (selectedIds.some((id) => !allowed.has(id))) errors.push(`已使用选项不可删除: ${column.id}`)
      }
    }
  }
  return [...new Set(errors)]
}

export function applyTableConfig(project: Project, config: TableConfig): Project {
  const errors = validateTableConfig(config, project)
  if (errors.length) throw new Error(errors.join('；'))
  const oldPayer = getProjectTableConfig(project).columns.find((column) => column.id === 'actualPayer')!
  const newPayer = config.columns.find((column) => column.id === 'actualPayer')!
  const oldNameToId = new Map(oldPayer.options?.map((option) => [option.name, option.id]))
  const newIdToName = new Map(newPayer.options?.map((option) => [option.id, option.name]))
  const categoryOptions = config.columns.find((column) => column.id === 'category')!.options ?? []
  const customColumns = new Map(config.columns.filter((column) => column.kind === 'input' || column.kind === 'select').map((column) => [column.id, column]))
  return {
    ...project,
    categories: categoryOptions.map((option, order) => ({ id: option.id, name: option.name, color: option.color, order })),
    expenses: project.expenses.map((expense) => ({
      ...expense,
      actualPayer: newIdToName.get(oldNameToId.get(expense.actualPayer.trim()) ?? '') ?? expense.actualPayer,
      customValues: expense.customValues ? Object.fromEntries(Object.entries(expense.customValues)
        .filter(([id]) => customColumns.has(id)).map(([id, value]) => [id, convertedCustomValue(customColumns.get(id)!, value)])) : undefined,
    })),
    tableConfig: cloneConfig(config),
  }
}
