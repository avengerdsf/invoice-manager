import { useEffect, useMemo, useState } from 'react'
import CustomSelect from '../../components/CustomSelect'
import { copyTableTemplate, createTableTemplate } from '../../domain/table-templates'
import type { Project, ProjectSession } from '../../shared/models'
import type { TableTemplate } from '../../shared/table-templates'
import { SettingsSection } from '../components/SettingsSection'
import type { GlobalSettingsDraft, PageProps, ProjectSettingsDraft } from '../settings-types'
import { ProjectTablePage } from './ProjectTablePage'
import './TemplateManagementPage.css'

type NameAction = { mode: 'new' | 'copy' | 'rename'; sourceId?: string; name: string }

/** The shared table editor receives only template data and an expense-empty project. */
export function createTemplateEditingContext(template: TableTemplate): { draft: ProjectSettingsDraft; session: ProjectSession } {
  const config = structuredClone(template.config)
  const categories = (config.columns.find((column) => column.id === 'category')?.options ?? [])
    .map((option, order) => ({ id: option.id, name: option.name, color: option.color, order }))
  const project: Project = {
    schemaVersion: 1,
    appVersion: '1',
    id: `template-preview-${template.id}`,
    name: template.name,
    revision: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    categories,
    expenses: [],
    attachments: [],
    invoiceAllocations: [],
    paymentAllocations: [],
    otherAllocations: [],
    tableConfig: config,
  }
  return {
    draft: { name: template.name, categories: structuredClone(categories), tableConfig: config },
    session: { project, rootPath: '', readOnly: false },
  }
}

export function TemplateManagementPage({ draft, updateDraft, appSettings, onEditorStateChange }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft
  const templates = globalDraft.tableTemplates
  const [editingId, setEditingId] = useState<string | null>(null)
  const [columnEditorOpen, setColumnEditorOpen] = useState(false)
  const [nameAction, setNameAction] = useState<NameAction | null>(null)
  const [nameError, setNameError] = useState('')
  const selected = templates.find((template) => template.id === editingId)
  const context = useMemo(() => selected ? createTemplateEditingContext(selected) : null, [selected])

  useEffect(() => { if (!selected) setColumnEditorOpen(false) }, [selected])

  useEffect(() => {
    onEditorStateChange?.(columnEditorOpen || Boolean(nameAction))
  }, [columnEditorOpen, nameAction, onEditorStateChange])

  useEffect(() => () => onEditorStateChange?.(false), [onEditorStateChange])

  const startNameAction = (action: NameAction) => {
    setNameAction(action)
    setNameError('')
  }

  const commitName = () => {
    if (!nameAction) return
    const name = nameAction.name.trim()
    if (!name || name.length > 80) { setNameError('模板名称需为 1–80 个字符'); return }
    if (templates.some((template) => (nameAction.mode !== 'rename' || template.id !== nameAction.sourceId) && template.name === name)) {
      setNameError('模板名称已存在')
      return
    }
    try {
      if (nameAction.mode === 'rename') {
        updateDraft({ tableTemplates: templates.map((template) => template.id === nameAction.sourceId ? { ...template, name } : template) } as Partial<GlobalSettingsDraft>)
      } else if (nameAction.mode === 'copy') {
        const source = templates.find((template) => template.id === nameAction.sourceId)
        if (!source) { setNameError('原模板已不存在'); return }
        const created = copyTableTemplate(source, name)
        updateDraft({ tableTemplates: [...templates, created] } as Partial<GlobalSettingsDraft>)
        setEditingId(created.id)
      } else {
        const created = createTableTemplate(name)
        updateDraft({ tableTemplates: [...templates, created] } as Partial<GlobalSettingsDraft>)
        setEditingId(created.id)
      }
    } catch (error) {
      setNameError(error instanceof Error ? error.message : '模板无法创建')
      return
    }
    setNameAction(null)
    setNameError('')
  }

  const updateTemplateDraft = (patch: Partial<GlobalSettingsDraft | ProjectSettingsDraft>) => {
    if (!selected || !('tableConfig' in patch) || !patch.tableConfig) return
    updateDraft({ tableTemplates: templates.map((template) => template.id === selected.id
      ? { ...template, config: structuredClone(patch.tableConfig!) } : template) } as Partial<GlobalSettingsDraft>)
  }

  if (selected && context) {
    return <div className="settings-page template-management-page template-editing-page">
      <div className="template-editor-breadcrumb">
        {!columnEditorOpen && <button type="button" className="settings-button settings-button-secondary" onClick={() => setEditingId(null)}>返回模板列表</button>}
        <span>{selected.name}</span>
      </div>
      <ProjectTablePage
        draft={context.draft}
        updateDraft={updateTemplateDraft}
        appSettings={appSettings}
        session={context.session}
        onEditorStateChange={setColumnEditorOpen}
        tableContext="template"
      />
    </div>
  }

  return <div className="settings-page template-management-page">
    <SettingsSection title="模板管理">
      <p className="settings-description template-intro">新项目可从表格模板创建。修改模板不会改变已打开或已保存的项目。</p>
      <div className="template-toolbar">
        <div className="template-default-control"><span className="settings-label">默认模板</span><CustomSelect className="settings-select" value={globalDraft.defaultTableTemplateId}
          options={templates.map((template) => ({ value: template.id, label: template.name }))}
          onChange={(id) => updateDraft({ defaultTableTemplateId: id } as Partial<GlobalSettingsDraft>)} /></div>
        <button type="button" className="settings-button settings-button-primary" onClick={() => startNameAction({ mode: 'new', name: '新模板' })}>新建模板</button>
      </div>

      {nameAction && <div className="template-name-form">
        <label className="settings-label" htmlFor="template-name-input">{nameAction.mode === 'new' ? '新建模板' : nameAction.mode === 'copy' ? '复制模板' : '重命名模板'}</label>
        <input id="template-name-input" className="settings-input" maxLength={80} value={nameAction.name} autoFocus
          onChange={(event) => { setNameAction({ ...nameAction, name: event.target.value }); setNameError('') }}
          onKeyDown={(event) => { if (event.key === 'Enter') commitName(); if (event.key === 'Escape') setNameAction(null) }} />
        <button type="button" className="settings-button settings-button-primary" onClick={commitName}>完成</button>
        <button type="button" className="settings-button settings-button-secondary" onClick={() => setNameAction(null)}>取消</button>
        {nameError && <span className="settings-inline-error" role="alert">{nameError}</span>}
      </div>}

      <div className="template-list">
        {templates.map((template) => <div className="template-row" key={template.id}>
          <div className="template-row-info"><strong>{template.name}</strong>{template.id === globalDraft.defaultTableTemplateId && <span className="template-default-label">默认</span>}
            <small>{template.config.columns.filter((column) => column.kind !== 'group').length} 列</small></div>
          <div className="template-row-actions">
            <button type="button" className="settings-button settings-button-secondary" onClick={() => setEditingId(template.id)}>编辑</button>
            <button type="button" className="settings-button settings-button-secondary" onClick={() => startNameAction({ mode: 'rename', sourceId: template.id, name: template.name })}>重命名</button>
            <button type="button" className="settings-button settings-button-secondary" onClick={() => startNameAction({ mode: 'copy', sourceId: template.id, name: `${template.name} 副本` })}>复制</button>
            <button type="button" className="settings-button settings-button-secondary" disabled={templates.length <= 1 || template.id === globalDraft.defaultTableTemplateId}
              title={template.id === globalDraft.defaultTableTemplateId ? '先选择其他默认模板' : templates.length <= 1 ? '至少保留一个模板' : '删除模板'}
              onClick={() => updateDraft({ tableTemplates: templates.filter((item) => item.id !== template.id) } as Partial<GlobalSettingsDraft>)}>删除</button>
          </div>
        </div>)}
      </div>
    </SettingsSection>
  </div>
}
