import { useEffect, useMemo, useState } from 'react'
import CustomSelect from '../../components/CustomSelect'
import type { Category } from '../../shared/models'
import type { FormulaToken, TableColumn, TableOption } from '../../shared/table-config'
import { evaluateFormula, getProjectTableConfig, isNumericTableColumn, moveTableColumn, validateTableConfig } from '../../domain/table-config'
import { getTableTemplates, prepareTemplateConfig } from '../../domain/table-templates'
import { CategoryColorPicker } from '../components/CategoryColorPicker'
import { SegmentedBooleanControl, SettingsSection } from '../components/SettingsSection'
import type { PageProps, ProjectSettingsDraft } from '../settings-types'
import './ProjectTablePage.css'

type DropTarget = { parentId?: string; beforeId?: string }
const optionColor = '#2563eb'
const copyColumn = (column: TableColumn): TableColumn => ({
  ...column,
  options: column.options?.map((option) => ({ ...option })),
  formula: column.formula?.map((token) => ({ ...token })),
  defaultValue: Array.isArray(column.defaultValue) ? [...column.defaultValue] : column.defaultValue,
})
const newId = (prefix: 'custom-' | 'group-' | 'option-') => `${prefix}${crypto.randomUUID()}`

function optionIsUsed(column: TableColumn, option: TableOption, project: NonNullable<PageProps['session']>['project']): boolean {
  if (column.builtin === 'category') return project.expenses.some((expense) => expense.categoryId === option.id)
  if (column.builtin === 'actualPayer') {
    const originalName = getProjectTableConfig(project).columns.find((item) => item.id === 'actualPayer')?.options?.find((item) => item.id === option.id)?.name ?? option.name
    return project.expenses.some((expense) => expense.actualPayer === originalName)
  }
  return project.expenses.some((expense) => {
    const value = expense.customValues?.[column.id]
    return value === option.id || (Array.isArray(value) && value.includes(option.id))
  })
}

export function ProjectTablePage({ draft, updateDraft, session, appSettings, tableContext = 'project', onEditorStateChange }: PageProps) {
  const projectDraft = draft as ProjectSettingsDraft
  const [editing, setEditing] = useState<TableColumn | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')
  const [constant, setConstant] = useState('')
  const [previewExpenseId, setPreviewExpenseId] = useState('')
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [hoverGroupId, setHoverGroupId] = useState<string | null>(null)
  const [pendingGroup, setPendingGroup] = useState<TableColumn | null>(null)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [templateId, setTemplateId] = useState('')

  useEffect(() => {
    setEditing(null)
    setDraggedId(null)
    setDropTarget(null)
    setHoverGroupId(null)
  }, [session?.project.id])

  useEffect(() => { onEditorStateChange?.(Boolean(editing)) }, [editing, onEditorStateChange])

  const columns = projectDraft.tableConfig.columns
  const groups = useMemo(() => [...columns.filter((column) => column.kind === 'group'), ...(pendingGroup ? [pendingGroup] : [])], [columns, pendingGroup])
  const roots = columns.filter((column) => !column.parentId)
  const readOnly = Boolean(session?.readOnly)

  if (!session) return <div className="settings-page">没有打开的项目</div>

  const startEdit = (column: TableColumn, creating = false) => {
    setPendingGroup(null)
    setNewGroupOpen(false)
    setNewGroupName('')
    setEditing(copyColumn(column))
    setFieldSearch('')
    setConstant('')
    setShowCreateMenu(false)
    setIsCreating(creating)
    setEditorError('')
  }

  const createColumn = (kind: 'group' | 'input' | 'select' | 'formula', parentId?: string) => {
    if (readOnly) return
    const id = newId(kind === 'group' ? 'group-' : 'custom-')
    startEdit({ id, name: '', kind, parentId, visible: true,
      ...(kind === 'input' ? { inputType: 'text' as const } : {}),
      ...(kind === 'select' ? { options: [], multi: false } : {}),
      ...(kind === 'formula' ? { formula: [], format: 'number' as const, precision: 2 } : {}),
    }, true)
  }

  const commit = () => {
    if (!editing || readOnly) return
    const name = editing.name.trim()
    if (!name || name.length > 40) { setEditorError('列名需为 1–40 个字符'); return }
    const next = { ...editing, name }
    if (next.kind === 'formula') {
      if (!next.formula?.length) { setEditorError('请添加数值字段和运算符'); return }
    }
    if (next.kind === 'select' || next.builtin === 'category' || next.builtin === 'actualPayer') {
      const options = (next.options ?? []).map((option) => ({ ...option, name: option.name.trim() }))
      if (options.some((option) => !option.name)) { setEditorError('选项名称不能为空'); return }
      if (new Set(options.map((option) => option.name)).size !== options.length) { setEditorError('选项名称不能重复'); return }
      next.options = options
      if (next.builtin === 'category' && options.length === 0) { setEditorError('至少保留一个类别'); return }
      if (next.kind === 'select' && options.length === 0) { setEditorError('至少添加一个选项'); return }
    }
    const baseColumns = pendingGroup && next.parentId === pendingGroup.id ? [...columns, pendingGroup] : columns
    const nextColumns = isCreating ? [...baseColumns, next] : baseColumns.map((column) => column.id === next.id ? next : column)
    const nextCategories: Category[] = next.builtin === 'category'
      ? (next.options ?? []).map((option, order) => ({ id: option.id, name: option.name, color: option.color, order }))
      : projectDraft.categories
    const errors = validateTableConfig({ columns: nextColumns }, session.project)
    if (errors.length) { setEditorError(errors[0]); return }
    updateDraft({ tableConfig: { columns: nextColumns }, categories: nextCategories } as Partial<ProjectSettingsDraft>)
    setEditing(null)
    setPendingGroup(null)
    setEditorError('')
  }

  const move = (id: string, target: DropTarget) => {
    if (readOnly) return
    const column = columns.find((item) => item.id === id)
    if (!column || id === target.beforeId || id === target.parentId) return
    if (column.kind === 'group' && target.parentId) return
    try {
      updateDraft({ tableConfig: moveTableColumn(projectDraft.tableConfig, id, target.parentId, target.beforeId) } as Partial<ProjectSettingsDraft>)
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : '无法移动到此位置')
    }
  }

  const drop = (target: DropTarget) => {
    if (draggedId) move(draggedId, target)
    setDraggedId(null)
    setDropTarget(null)
    setHoverGroupId(null)
  }

  const dropZone = (target: DropTarget, label: string) => (
    <div
      className={`table-config-drop-zone ${dropTarget?.parentId === target.parentId && dropTarget?.beforeId === target.beforeId ? 'active' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDropTarget(target) }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(event) => { event.preventDefault(); drop(target) }}
      aria-label={label}
    />
  )

  const renderRow = (column: TableColumn, depth: number) => (
    <div key={column.id}>
      {dropZone({ parentId: column.parentId, beforeId: column.id }, `放在${column.name}前`)}
      <div className={`table-config-row ${draggedId === column.id ? 'dragging' : ''} ${hoverGroupId === column.id ? 'group-drop-active' : ''}`}
        style={{ paddingLeft: depth ? 28 : 10 }}
        onDragOver={(event) => {
          if (readOnly || column.kind !== 'group' || !draggedId || columns.find((item) => item.id === draggedId)?.kind === 'group') return
          event.preventDefault()
          setDropTarget(null)
          setHoverGroupId(column.id)
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          if (hoverGroupId === column.id) setHoverGroupId(null)
        }}
        onDrop={(event) => {
          if (readOnly || column.kind !== 'group' || !draggedId || columns.find((item) => item.id === draggedId)?.kind === 'group') return
          event.preventDefault()
          event.stopPropagation()
          drop({ parentId: column.id })
          setExpanded((previous) => ({ ...previous, [column.id]: true }))
        }}>
        <span className="table-config-handle" draggable={!readOnly} title="拖动排序" aria-label={`拖动${column.name}`}
          onDragStart={(event) => { setDraggedId(column.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', column.id) }}
          onDragEnd={() => { setDraggedId(null); setDropTarget(null); setHoverGroupId(null) }}>⋮⋮</span>
        {column.kind === 'group' ? (
          <button type="button" className="table-config-expand" onClick={() => setExpanded((prev) => ({ ...prev, [column.id]: prev[column.id] === false }))}
            aria-expanded={expanded[column.id] !== false} aria-label={`${expanded[column.id] === false ? '展开' : '收起'}${column.name}`}>
            {expanded[column.id] === false ? '▸' : '▾'}
          </button>
        ) : <span className="table-config-expand-placeholder" />}
        <span className="table-config-row-name">{column.name || '未命名'}{column.kind === 'group' && <small>分组</small>}</span>
        <SegmentedBooleanControl checked={column.visible !== false} disabled={readOnly}
          onChange={(visible) => updateDraft({ tableConfig: { columns: columns.map((item) => item.id === column.id ? { ...item, visible } : item) } } as Partial<ProjectSettingsDraft>)} />
        <button type="button" className="settings-button settings-button-secondary table-config-row-edit" disabled={readOnly} onClick={() => startEdit(column)}>编辑</button>
      </div>
      {column.kind === 'group' && expanded[column.id] !== false && (
        <div className="table-config-group-children">
          {columns.filter((child) => child.parentId === column.id).map((child) => renderRow(child, depth + 1))}
          {dropZone({ parentId: column.id }, `放入${column.name}末尾`)}
        </div>
      )}
    </div>
  )

  const patchEditing = (patch: Partial<TableColumn>) => setEditing((current) => current ? { ...current, ...patch } : current)
  const appendToken = (token: FormulaToken) => patchEditing({ formula: [...(editing?.formula ?? []), token] })
  const options = editing?.options ?? []
  const policy = editing?.builtin === 'category' ? 'category' : editing?.builtin === 'actualPayer' ? 'payer' : 'custom'
  const canManageOptions = editing && (editing.kind === 'select' || policy !== 'custom')
  const numericColumns = columns.filter((column) => column.id !== editing?.id && column.kind !== 'formula' && isNumericTableColumn(column))
  const previewExpense = session.project.expenses.find((expense) => expense.id === previewExpenseId) ?? session.project.expenses[0]
  const preview = editing?.kind === 'formula' && previewExpense
    ? evaluateFormula(editing, previewExpense, { ...session.project,
      tableConfig: { columns: isCreating ? [...columns, editing] : columns.map((column) => column.id === editing.id ? editing : column) } })
    : null

  return (
    <div className={`settings-page project-table-page ${editing ? 'editor-mode' : ''}`}>
      {!editing && <SettingsSection title="表格设置">
        <p className="settings-description table-config-intro">调整列顺序、分组与显示方式。编辑列可设置输入、选项和公式。</p>
        <div className="table-config-create">
          <div className="table-config-create-menu-wrap">
            <button type="button" className="settings-button settings-button-primary" disabled={readOnly} onClick={() => setShowCreateMenu((open) => !open)} aria-expanded={showCreateMenu}>添加列 ▾</button>
            {showCreateMenu && <div className="table-config-create-menu">
              <button type="button" className="settings-button settings-button-secondary" onClick={() => createColumn('input')}>手动填写</button>
              <button type="button" className="settings-button settings-button-secondary" onClick={() => createColumn('select')}>下拉选择</button>
              <button type="button" className="settings-button settings-button-secondary" onClick={() => createColumn('formula')}>公式计算</button>
            </div>}
          </div>
          {tableContext === 'project' && <div className="table-config-template-apply">
            <CustomSelect value={templateId} onChange={setTemplateId} disabled={readOnly} placeholder="选择模板" ariaLabel="选择表格模板"
              options={getTableTemplates(appSettings).map((template) => ({ value: template.id, label: template.name }))} />
            <button type="button" className="settings-button settings-button-secondary" disabled={readOnly || !templateId} onClick={() => {
              const template = getTableTemplates(appSettings).find((item) => item.id === templateId)
              if (!template || !window.confirm('应用模板将替换当前表格草稿；已有数据及被使用的字段和选项会保留。继续？')) return
              try {
                const config = prepareTemplateConfig(session.project, template)
                const errors = validateTableConfig(config, session.project)
                if (errors.length) throw new Error(errors[0])
                const categories = (config.columns.find((column) => column.builtin === 'category')?.options ?? []).map((option, order) => ({ ...option, order }))
                updateDraft({ tableConfig: config, categories } as Partial<ProjectSettingsDraft>)
                setEditorError('')
              } catch (error) { setEditorError(error instanceof Error ? error.message : '无法应用模板') }
            }}>应用模板</button>
          </div>}
        </div>
        <div className="table-config-list">
          {roots.map((column) => renderRow(column, 0))}
          {dropZone({}, '放在表格末尾')}
        </div>
        {readOnly && <p className="settings-description table-config-intro">项目以只读模式打开，无法修改表格设置。</p>}
        {editorError && <p className="settings-inline-error" role="alert">{editorError}</p>}
      </SettingsSection>}

      {editing && <section className="table-config-editor" aria-label={isCreating ? '新建列' : `编辑${editing.name}`}>
          <div className="table-config-editor-header"><button type="button" className="settings-button settings-button-secondary" onClick={() => setEditing(null)}>返回列表</button><h2>{isCreating ? '新建' : '编辑'}{editing.kind === 'group' ? '分组' : '列'}</h2></div>
          <div className="table-config-editor-body">
            <label className="table-config-field"><span>名称</span><input className="settings-input" value={editing.name} maxLength={40} disabled={readOnly} onChange={(event) => patchEditing({ name: event.target.value })} /></label>
            {editing.kind !== 'group' && <label className="table-config-field"><span>所属分组</span><CustomSelect className="settings-select" value={editing.parentId ?? ''} disabled={readOnly}
              options={[{ value: '', label: '无' }, ...groups.map((group) => ({ value: group.id, label: group.name })), { value: '__new_group__', label: '＋ 新建分组' }]}
              onChange={(value) => { if (value === '__new_group__') { setNewGroupOpen(true); setNewGroupName(''); return } patchEditing({ parentId: value || undefined }); setNewGroupOpen(false) }} /></label>}
            {newGroupOpen && <div className="table-config-inline-group">
              <input className="settings-input" aria-label="新分组名称" placeholder="输入新分组名称" maxLength={40} value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} disabled={readOnly} />
              <button type="button" className="settings-button settings-button-primary" disabled={readOnly || !newGroupName.trim()} onClick={() => {
                const name = newGroupName.trim()
                if (groups.some((group) => group.name === name)) { setEditorError('分组名称已存在'); return }
                const group: TableColumn = { id: newId('group-'), name, kind: 'group', visible: true }
                setPendingGroup(group); patchEditing({ parentId: group.id }); setNewGroupOpen(false); setEditorError('')
              }}>创建并使用</button>
              <button type="button" className="settings-button settings-button-secondary" onClick={() => setNewGroupOpen(false)}>取消</button>
            </div>}
            {editing.kind === 'input' && <>
              <label className="table-config-field"><span>填写类型</span><CustomSelect className="settings-select" value={editing.inputType ?? 'text'} disabled={readOnly}
                options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }]}
                onChange={(value) => patchEditing({ inputType: value as 'text' | 'number', defaultValue: null })} /></label>
              <label className="table-config-field"><span>默认值</span><input className="settings-input" type={editing.inputType === 'number' ? 'number' : 'text'} value={editing.defaultValue == null ? '' : String(editing.defaultValue)} disabled={readOnly}
                onChange={(event) => patchEditing({ defaultValue: event.target.value === '' ? null : editing.inputType === 'number' ? Number(event.target.value) : event.target.value })} /></label>
              {editing.inputType === 'number' && <NumericFormat editing={editing} onChange={patchEditing} readOnly={readOnly} />}
              <div className="table-config-preview">效果预览：{editing.defaultValue == null || editing.defaultValue === '' ? '待填写' : editing.inputType === 'number' ? formatNumericPreview(Number(editing.defaultValue), editing) : String(editing.defaultValue)}</div>
            </>}
            {canManageOptions && <>
              <div className="table-config-options-heading"><span>选项</span><button type="button" className="settings-button settings-button-secondary" disabled={readOnly} onClick={() => patchEditing({ options: [...options, { id: newId('option-'), name: '', color: optionColor }] })}>添加选项</button></div>
              <div className="table-config-options">
                {options.map((option, index) => {
                  const used = optionIsUsed(editing, option, session.project)
                  return <div className="table-config-option" key={option.id} draggable={!readOnly}
                    onDragStart={(event) => event.dataTransfer.setData('application/x-option-index', String(index))}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); if (readOnly) return; const from = Number(event.dataTransfer.getData('application/x-option-index')); if (!Number.isInteger(from) || from < 0 || from >= options.length || from === index) return; const ordered = [...options]; const [item] = ordered.splice(from, 1); ordered.splice(index, 0, item); patchEditing({ options: ordered }) }}>
                    <span className="table-config-option-handle" title="拖动排序">⋮⋮</span>
                    <CategoryColorPicker value={option.color} disabled={readOnly} onChange={(color) => patchEditing({ options: options.map((item) => item.id === option.id ? { ...item, color } : item) })} />
                    <input className="settings-input" value={option.name} disabled={readOnly} maxLength={40} aria-label={`选项 ${index + 1} 名称`}
                      onChange={(event) => patchEditing({ options: options.map((item) => item.id === option.id ? { ...item, name: event.target.value } : item) })} />
                    <button type="button" className="settings-button settings-button-secondary" disabled={readOnly || used} title={used ? '该选项已被明细使用' : '删除选项'}
                      onClick={() => patchEditing({ options: options.filter((item) => item.id !== option.id),
                        defaultValue: Array.isArray(editing.defaultValue) ? editing.defaultValue.filter((id) => id !== option.id)
                          : editing.defaultValue === option.id ? null : editing.defaultValue })}>删除</button>
                  </div>
                })}
              </div>
              <label className="table-config-field"><span>多选</span><SegmentedBooleanControl checked={Boolean(editing.multi)} disabled={readOnly || policy !== 'custom'}
                onChange={(multi) => patchEditing({ multi, defaultValue: multi ? [] : null })} /></label>
              {editing.multi && policy === 'custom' ? <div className="table-config-field"><span>默认选项</span><CustomSelect className="settings-select" disabled={readOnly} multiple
                value="" onChange={() => {}} selectedValues={Array.isArray(editing.defaultValue) ? editing.defaultValue : []}
                onSelectionChange={(values) => patchEditing({ defaultValue: values })}
                options={options.filter((option) => option.name.trim()).map((option) => ({ value: option.id, label: option.name }))} /></div>
              : <label className="table-config-field"><span>默认选项</span><CustomSelect className="settings-select" disabled={readOnly} value={typeof editing.defaultValue === 'string' ? editing.defaultValue : ''}
                options={[{ value: '', label: '无默认值' }, ...options.filter((option) => option.name.trim()).map((option) => ({ value: option.id, label: option.name }))]}
                onChange={(value) => patchEditing({ defaultValue: value || null })} /></label>}
              <div className="table-config-field"><span>效果预览</span><CustomSelect className="settings-select" disabled={readOnly} multiple={Boolean(editing.multi)} value={typeof editing.defaultValue === 'string' ? editing.defaultValue : ''}
                onChange={() => {}} selectedValues={Array.isArray(editing.defaultValue) ? editing.defaultValue : []} onSelectionChange={() => {}}
                placeholder="请选择" options={options.filter((option) => option.name.trim()).map((option) => ({ value: option.id, label: option.name }))} /></div>
              {policy !== 'custom' && <p className="settings-description">{policy === 'category' ? '发票类别' : '付款人'}仅允许单选。已使用的选项不可删除。</p>}
            </>}
            {editing.kind === 'formula' && <>
              <div className="table-config-field table-config-formula"><span>计算公式</span><div className="table-config-formula-tokens">
                {(editing.formula ?? []).length ? editing.formula?.map((token, index) => <button key={index} type="button" className="settings-button settings-button-secondary" disabled={readOnly}
                  title="点击移除" onClick={() => patchEditing({ formula: editing.formula?.filter((_, itemIndex) => itemIndex !== index) })}>
                  {token.type === 'field' ? columns.find((column) => column.id === token.value)?.name ?? '失效字段' : token.value} ×</button>) : <span className="settings-description">选择字段并组合公式</span>}
              </div></div>
              <div className="table-config-formula-tools">
                <input className="settings-input" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="搜索数值字段" aria-label="搜索数值字段" disabled={readOnly} />
                <CustomSelect className="settings-select" value="" disabled={readOnly} placeholder="插入字段"
                  options={numericColumns.filter((column) => `${column.parentId ? `${groups.find((group) => group.id === column.parentId)?.name ?? ''} / ` : ''}${column.name}`.includes(fieldSearch)).map((column) => ({ value: column.id, label: `${column.parentId ? `${groups.find((group) => group.id === column.parentId)?.name ?? ''} / ` : ''}${column.name}` }))}
                  onChange={(id) => { appendToken({ type: 'field', value: id }); setFieldSearch('') }} />
                <div className="table-config-operators">{['+', '−', '×', '÷', '(', ')'].map((label) => <button key={label} type="button" className="settings-button settings-button-secondary" disabled={readOnly}
                  onClick={() => appendToken({ type: 'operator', value: label === '−' ? '-' : label === '×' ? '*' : label === '÷' ? '/' : label })}>{label}</button>)}</div>
                <input className="settings-input" type="number" value={constant} onChange={(event) => setConstant(event.target.value)} placeholder="固定数值" aria-label="固定数值" disabled={readOnly} />
                <button type="button" className="settings-button settings-button-secondary" disabled={readOnly || !constant || !Number.isFinite(Number(constant))}
                  onClick={() => { appendToken({ type: 'number', value: constant }); setConstant('') }}>插入数值</button>
              </div>
              <NumericFormat editing={editing} onChange={patchEditing} readOnly={readOnly} />
              <p className="settings-description">只可引用数字输入列和内置金额列，支持 + − × ÷ 与括号。</p>
              {session.project.expenses.length > 0 && <div className="table-config-field"><span>预览明细</span><CustomSelect className="settings-select" value={previewExpense?.id ?? ''} disabled={readOnly}
                options={session.project.expenses.map((expense) => ({ value: expense.id, label: expense.name || expense.date || expense.id }))} onChange={setPreviewExpenseId} /></div>}
              <div className="table-config-preview">预览：{preview ? preview.status === 'ok' ? formatNumericPreview(preview.value!, editing) : preview.message ?? '暂无值' : '暂无明细可预览'}</div>
            </>}
            {editing.kind !== 'group' && <label className="table-config-field"><span>列宽</span><input className="settings-input" type="number" min={60} max={600} value={editing.width ?? ''} disabled={readOnly} placeholder="自动"
              onChange={(event) => patchEditing({ width: event.target.value ? Number(event.target.value) : undefined })} /></label>}
            {editorError && <p className="settings-inline-error" role="alert">{editorError}</p>}
          </div>
          <div className="table-config-editor-footer">
            {!isCreating && editing.kind !== 'builtin' && editing.kind !== 'group' && <button type="button" className="settings-button settings-button-danger" disabled={readOnly}
              onClick={() => { updateDraft({ tableConfig: { columns: columns.filter((column) => column.id !== editing.id) } } as Partial<ProjectSettingsDraft>); setEditing(null) }}>删除列</button>}
            {!isCreating && editing.kind === 'group' && <button type="button" className="settings-button settings-button-danger" disabled={readOnly || columns.some((column) => column.parentId === editing.id)}
              title={columns.some((column) => column.parentId === editing.id) ? '先移出子列' : undefined}
              onClick={() => { updateDraft({ tableConfig: { columns: columns.filter((column) => column.id !== editing.id) } } as Partial<ProjectSettingsDraft>); setEditing(null) }}>删除分组</button>}
            <button type="button" className="settings-button settings-button-secondary" onClick={() => setEditing(null)}>取消</button>
            <button type="button" className="settings-button settings-button-primary" disabled={readOnly} onClick={commit}>完成</button>
          </div>
        </section>}
    </div>
  )
}

function NumericFormat({ editing, onChange, readOnly }: { editing: TableColumn; onChange: (patch: Partial<TableColumn>) => void; readOnly: boolean }) {
  return <>
    <div className="table-config-pair">
    <label className="table-config-field"><span>显示格式</span><CustomSelect className="settings-select" value={editing.format ?? 'number'} disabled={readOnly}
      options={[{ value: 'number', label: '数字' }, { value: 'currency', label: '金额' }, { value: 'percent', label: '百分比' }]}
      onChange={(value) => onChange({ format: value as TableColumn['format'] })} /></label>
    <label className="table-config-field"><span>小数位数</span><input className="settings-input" type="number" min={0} max={8} value={editing.precision ?? 2} disabled={readOnly}
      onChange={(event) => onChange({ precision: Number(event.target.value) })} /></label>
    </div>
    <label className="table-config-field"><span>单位</span><input className="settings-input" value={editing.unit ?? ''} disabled={readOnly} maxLength={20}
      onChange={(event) => onChange({ unit: event.target.value })} /></label>
  </>
}

function formatNumericPreview(value: number, column: TableColumn): string {
  if (!Number.isFinite(value)) return '无效数值'
  const precision = Math.min(12, Math.max(0, column.precision ?? 2))
  const formatted = (column.format === 'percent' ? value * 100 : value).toLocaleString('zh-CN', {
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  })
  const prefix = column.format === 'currency' ? '¥' : ''
  const suffix = column.format === 'percent' ? '%' : column.unit ? ` ${column.unit}` : ''
  return `${prefix}${formatted}${suffix}`
}
