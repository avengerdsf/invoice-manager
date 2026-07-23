import { useRef, useState } from 'react'
import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import { CategoryColorPicker } from '../components/CategoryColorPicker'
import type { PageProps, ProjectSettingsDraft } from '../settings-types'
import type { Category } from '../../shared/models'
import {
  validateCategoryName,
  isCategoryUsed,
  getCategoryUsageCount,
  PRESET_COLORS,
} from '../settings-validation'

export function ProjectCategoriesPage({ draft, updateDraft, session }: PageProps) {
  const projectDraft = draft as ProjectSettingsDraft
  if (!session) {
    return <div className="settings-page">没有打开的项目</div>
  }

  const project = session.project
  const categories = projectDraft.categories
  const isReadOnly = session.readOnly

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingNameError, setEditingNameError] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryError, setNewCategoryError] = useState('')
  const [newCategoryColor, setNewCategoryColor] = useState(PRESET_COLORS[0])
  const newCategoryInputRef = useRef<HTMLInputElement | null>(null)

  const startEditing = (category: Category) => {
    setEditingId(category.id)
    setEditingName(category.name)
    setEditingNameError('')
  }

  const saveEditing = () => {
    if (!editingId) return

    const trimmedName = editingName.trim()
    if (!validateCategoryName(trimmedName, categories, editingId)) {
      setEditingNameError('类别名称无效或已存在')
      return
    }

    updateDraft({
      categories: categories.map((cat) =>
        cat.id === editingId ? { ...cat, name: trimmedName } : cat
      ),
    } as Partial<ProjectSettingsDraft>)
    setEditingId(null)
    setEditingName('')
    setEditingNameError('')
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditingName('')
    setEditingNameError('')
  }

  const handleColorChange = (categoryId: string, color: string) => {
    updateDraft({
      categories: categories.map((cat) =>
        cat.id === categoryId ? { ...cat, color } : cat
      ),
    } as Partial<ProjectSettingsDraft>)
  }

  const handleAddCategory = () => {
    const trimmedName = newCategoryName.trim()
    if (!trimmedName) {
      setNewCategoryError('请输入类别名称')
      newCategoryInputRef.current?.focus()
      return
    }
    if (!validateCategoryName(trimmedName, categories)) {
      setNewCategoryError('类别名称无效或已存在')
      newCategoryInputRef.current?.focus()
      return
    }

    const maxOrder = Math.max(-1, ...categories.map((cat) => cat.order))
    const newCategory: Category = {
      id: crypto.randomUUID(),
      name: trimmedName,
      color: newCategoryColor,
      order: maxOrder + 1,
    }

    updateDraft({
      categories: [...categories, newCategory],
    } as Partial<ProjectSettingsDraft>)

    setNewCategoryName('')
    setNewCategoryError('')
    setNewCategoryColor(PRESET_COLORS[0])
  }

  const handleDeleteCategory = (categoryId: string) => {
    if (categories.length <= 1) {
      alert('至少需要保留一个类别')
      return
    }

    if (isCategoryUsed(categoryId, project)) {
      const usageCount = getCategoryUsageCount(categoryId, project)
      alert(`该类别正在被 ${usageCount} 条明细使用，无法删除`)
      return
    }

    updateDraft({
      categories: categories.filter((cat) => cat.id !== categoryId),
    } as Partial<ProjectSettingsDraft>)
  }

  const handleMoveUp = (index: number) => {
    if (index === 0) return
    const newCategories = categories.map((category) => ({ ...category }))
    ;[newCategories[index - 1], newCategories[index]] = [newCategories[index], newCategories[index - 1]]
    // 重新规范化顺序
    newCategories.forEach((cat, idx) => cat.order = idx)
    updateDraft({ categories: newCategories } as Partial<ProjectSettingsDraft>)
  }

  const handleMoveDown = (index: number) => {
    if (index === categories.length - 1) return
    const newCategories = categories.map((category) => ({ ...category }))
    ;[newCategories[index], newCategories[index + 1]] = [newCategories[index + 1], newCategories[index]]
    // 重新规范化顺序
    newCategories.forEach((cat, idx) => cat.order = idx)
    updateDraft({ categories: newCategories } as Partial<ProjectSettingsDraft>)
  }

  const sortedCategories = [...categories].sort((a, b) => a.order - b.order)

  return (
    <div className="settings-page settings-fill-page">
      <SettingsSection title="发票类别">
        {!isReadOnly && (
          <div className="invoice-category-add-form">
            <input
              type="text"
              ref={newCategoryInputRef}
              className="settings-input invoice-category-input"
              placeholder="新类别名称"
              value={newCategoryName}
              onChange={(e) => {
                setNewCategoryName(e.target.value)
                if (newCategoryError) setNewCategoryError('')
              }}
              maxLength={40}
              onKeyPress={(e) => e.key === 'Enter' && handleAddCategory()}
            />
            <CategoryColorPicker
              value={newCategoryColor}
              onChange={setNewCategoryColor}
            />
            <button
              className="settings-button settings-button-primary"
              onClick={handleAddCategory}
              disabled={!newCategoryName.trim()}
            >
              添加类别
            </button>
            {newCategoryError && <div className="settings-inline-error invoice-category-add-error">{newCategoryError}</div>}
          </div>
        )}

        <div className="invoice-category-list">
          {sortedCategories.map((category, index) => {
            const isUsed = isCategoryUsed(category.id, project)
            const isEditing = editingId === category.id

            return (
              <div key={category.id} className="invoice-category-item">
                <div className="invoice-category-info">
                  <div className="invoice-category-order">{index + 1}.</div>

                  {isEditing ? (
                    <input
                      type="text"
                      className="settings-input invoice-category-name-input"
                      value={editingName}
                      onChange={(e) => {
                        setEditingName(e.target.value)
                        if (editingNameError) setEditingNameError('')
                      }}
                      maxLength={40}
                      autoFocus
                      onKeyPress={(e) => e.key === 'Enter' && saveEditing()}
                    />
                  ) : (
                    <span className="invoice-category-name">{category.name}</span>
                  )}

                  {isUsed && (
                    <span className="invoice-category-usage">
                      {getCategoryUsageCount(category.id, project)} 条明细
                    </span>
                  )}
                  {isEditing && editingNameError && <div className="settings-inline-error invoice-category-edit-error">{editingNameError}</div>}
                </div>

                <div className="invoice-category-controls">
                  <CategoryColorPicker
                    value={category.color}
                    onChange={(color) => handleColorChange(category.id, color)}
                    disabled={isReadOnly}
                  />

                  <div className="invoice-category-actions">
                    {isEditing ? (
                      <>
                        <button
                          className="invoice-category-action-button"
                          onClick={saveEditing}
                        >
                          保存
                        </button>
                        <button
                          className="invoice-category-action-button"
                          onClick={cancelEditing}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="invoice-category-action-button"
                          onClick={() => handleMoveUp(index)}
                          disabled={index === 0 || isReadOnly}
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          className="invoice-category-action-button"
                          onClick={() => handleMoveDown(index)}
                          disabled={index === sortedCategories.length - 1 || isReadOnly}
                          title="下移"
                        >
                          ↓
                        </button>
                        <button
                          className="invoice-category-action-button"
                          onClick={() => startEditing(category)}
                          disabled={isReadOnly}
                        >
                          重命名
                        </button>
                        <button
                          className="invoice-category-action-button invoice-category-delete-button"
                          onClick={() => handleDeleteCategory(category.id)}
                          disabled={isUsed || isReadOnly}
                          title={isUsed ? '已使用的类别无法删除' : '删除类别'}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {isReadOnly && (
          <p className="settings-description">
            项目以只读模式打开，无法修改类别。
          </p>
        )}
      </SettingsSection>
    </div>
  )
}
