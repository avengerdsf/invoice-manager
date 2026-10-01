import { describe, expect, it } from 'vitest'
import { createTableTemplate } from '../../domain/table-templates'
import { createTemplateEditingContext } from './TemplateManagementPage'

describe('template editing context', () => {
  it('edits a detached config in an expense-empty synthetic session', () => {
    const template = createTableTemplate('Blank', undefined, 'template-blank')
    const context = createTemplateEditingContext(template)
    expect(context.session.project.expenses).toEqual([])
    expect(context.session.project.attachments).toEqual([])
    expect(context.session.project.id).toBe('template-preview-template-blank')
    context.draft.tableConfig.columns.find((column) => column.id === 'name')!.name = 'Edited'
    expect(template.config.columns.find((column) => column.id === 'name')!.name).not.toBe('Edited')
  })
})
