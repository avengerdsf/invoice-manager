import { describe, expect, it } from 'vitest'
import { resolveProjectTemplate } from './project-template'
import { AppSettingsSchema } from '../src/shared/models'
import { createTableTemplate } from '../src/domain/table-templates'
describe('new project template selection', () => {
  it('uses the global default unless an explicit valid template is chosen', () => {
    const a=createTableTemplate('A',undefined,'template-a'),b=createTableTemplate('B',undefined,'template-b')
    const settings=AppSettingsSchema.parse({tableTemplates:[a,b],defaultTableTemplateId:b.id})
    expect(resolveProjectTemplate(settings).id).toBe(b.id)
    const selected=resolveProjectTemplate(settings,a.id)
    selected.config.columns[0].name='local'
    expect(settings.tableTemplates?.[0].config.columns[0].name).not.toBe('local')
    expect(()=>resolveProjectTemplate(settings,'template-missing')).toThrow('已不存在')
  })
  it('validates a selected template before project-directory creation can begin', () => {
    const template=createTableTemplate('A',undefined,'template-a')
    template.config.columns.find(c=>c.builtin==='category')!.options=[]
    const settings=AppSettingsSchema.parse({tableTemplates:[template],defaultTableTemplateId:template.id})
    expect(()=>resolveProjectTemplate(settings)).toThrow()
    expect(resolveProjectTemplate(AppSettingsSchema.parse({})).config.columns.filter(c=>c.kind!=='group')).toHaveLength(14)
  })
})
