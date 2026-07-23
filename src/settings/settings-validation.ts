import type { GlobalSettingsDraft, ProjectSettingsDraft } from './settings-types'
import type { AppSettings, Project, Category } from '../shared/models'
import type { ViewMode } from '../shared/models'

/**
 * 规范化全局设置草稿
 */
export function normalizeGlobalDraft(draft: GlobalSettingsDraft): GlobalSettingsDraft {
  return {
    ...draft,
    payerNames: draft.payerNames.map((name) => name.trim()).filter((name) => name.length > 0),
    lastImportDirectories: {
      invoice: draft.lastImportDirectories.invoice?.trim() || null,
      payment: draft.lastImportDirectories.payment?.trim() || null,
      other: draft.lastImportDirectories.other?.trim() || null,
    },
  }
}

/**
 * 规范化项目设置草稿
 */
export function normalizeProjectDraft(draft: ProjectSettingsDraft): ProjectSettingsDraft {
  return {
    name: draft.name.trim(),
    categories: draft.categories
      .map((cat, index) => ({ ...cat, name: cat.name.trim(), order: index }))
      .filter((cat) => cat.name.length > 0),
  }
}

/**
 * 比较全局设置是否有变化
 */
export function isGlobalDirty(draft: GlobalSettingsDraft, settings: AppSettings): boolean {
  const normalized = normalizeGlobalDraft(draft)

  // 比较付款人
  const sortedPayers = [...normalized.payerNames].sort()
  const sortedSettingsPayers = [...settings.payerNames].sort()
  if (JSON.stringify(sortedPayers) !== JSON.stringify(sortedSettingsPayers)) return true

  // 比较视图模式
  if (normalized.defaultViewMode !== settings.defaultViewMode) return true

  // 比较导出默认项
  if (normalized.defaultIncludePayments !== settings.defaultIncludePayments) return true
  if (normalized.defaultIncludeOtherAttachments !== settings.defaultIncludeOtherAttachments) return true

  // 比较启动选项
  if (normalized.showProjectHistoryOnStartup !== settings.showProjectHistoryOnStartup) return true
  if (normalized.autoOpenLastProject !== settings.autoOpenLastProject) return true
  if (normalized.showSuccessMessages !== settings.showSuccessMessages) return true

  // 比较目录（null 和 undefined 视为相同）
  const normalizePath = (path: string | null | undefined): string | null => path || null

  if (normalizePath(normalized.lastProjectParentDirectory) !== normalizePath(settings.lastProjectParentDirectory)) return true
  if (normalizePath(normalized.lastOpenProjectDirectory) !== normalizePath(settings.lastOpenProjectDirectory)) return true
  if (normalizePath(normalized.lastExportDirectory) !== normalizePath(settings.lastExportDirectory)) return true

  // 比较导入目录
  if (normalizePath(normalized.lastImportDirectories.invoice) !== normalizePath(settings.lastImportDirectories.invoice)) return true
  if (normalizePath(normalized.lastImportDirectories.payment) !== normalizePath(settings.lastImportDirectories.payment)) return true
  if (normalizePath(normalized.lastImportDirectories.other) !== normalizePath(settings.lastImportDirectories.other)) return true

  return false
}

/**
 * 比较项目设置是否有变化
 */
export function isProjectDirty(draft: ProjectSettingsDraft, project: Project): boolean {
  const normalized = normalizeProjectDraft(draft)

  // 比较项目名称
  if (normalized.name !== project.name) return true

  // 比较类别
  if (normalized.categories.length !== project.categories.length) return true

  const sortedDraft = [...normalized.categories].sort((a, b) => a.order - b.order)
  const sortedProject = [...project.categories].sort((a, b) => a.order - b.order)

  for (let i = 0; i < sortedDraft.length; i++) {
    const draftCat = sortedDraft[i]
    const projectCat = sortedProject[i]
    if (draftCat.id !== projectCat.id) return true
    if (draftCat.name !== projectCat.name) return true
    if (draftCat.color !== projectCat.color) return true
  }

  return false
}

/**
 * 验证类别名称唯一性
 */
export function validateCategoryName(name: string, categories: Category[], excludeId?: string): boolean {
  const trimmedName = name.trim()
  if (trimmedName.length === 0 || trimmedName.length > 40) return false
  return !categories.some((cat) => cat.name === trimmedName && cat.id !== excludeId)
}

/**
 * 检查类别是否被使用
 */
export function isCategoryUsed(categoryId: string, project: Project): boolean {
  return project.expenses.some((expense) => expense.categoryId === categoryId)
}

/**
 * 获取类别使用统计
 */
export function getCategoryUsageCount(categoryId: string, project: Project): number {
  return project.expenses.filter((expense) => expense.categoryId === categoryId).length
}

/**
 * 验证颜色格式
 */
export function isValidColorHex(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color)
}

/**
 * 预设颜色列表
 */
export const PRESET_COLORS = [
  '#2563eb', '#0ea5e9', '#14b8a6', '#22c55e',
  '#84cc16', '#f59e0b', '#f97316', '#ef4444',
  '#ec4899', '#8b5cf6', '#64748b', '#334155',
]

/**
 * 获取默认全局草稿
 */
export function createDefaultGlobalDraft(settings: AppSettings): GlobalSettingsDraft {
  return {
    payerNames: [...settings.payerNames],
    defaultViewMode: settings.defaultViewMode,
    defaultIncludePayments: settings.defaultIncludePayments,
    defaultIncludeOtherAttachments: settings.defaultIncludeOtherAttachments,
    showProjectHistoryOnStartup: settings.showProjectHistoryOnStartup,
    autoOpenLastProject: settings.autoOpenLastProject,
    showSuccessMessages: settings.showSuccessMessages,
    lastProjectParentDirectory: settings.lastProjectParentDirectory || null,
    lastOpenProjectDirectory: settings.lastOpenProjectDirectory || null,
    lastExportDirectory: settings.lastExportDirectory || null,
    lastImportDirectories: {
      invoice: settings.lastImportDirectories.invoice || null,
      payment: settings.lastImportDirectories.payment || null,
      other: settings.lastImportDirectories.other || null,
    },
  }
}

/**
 * 获取默认项目草稿
 */
export function createDefaultProjectDraft(project: Project): ProjectSettingsDraft {
  return {
    name: project.name,
    categories: project.categories.map((category) => ({ ...category })),
  }
}
