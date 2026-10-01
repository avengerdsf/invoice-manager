import type { AppSettings } from '../src/shared/models'
import { getDefaultTableTemplateId, getTableTemplates, validateTableTemplates } from '../src/domain/table-templates'

/** Resolve and validate before opening/creating any project directory. */
export function resolveProjectTemplate(settings: AppSettings, requestedId?: string) {
  const templates = getTableTemplates(settings)
  const defaultId = getDefaultTableTemplateId(settings)
  const template = templates.find((item) => item.id === (requestedId ?? defaultId))
  if (!template) throw new Error('所选模板已不存在，请重新选择')
  const errors = validateTableTemplates(templates, defaultId)
  if (errors.length) throw new Error(errors[0])
  return template
}
