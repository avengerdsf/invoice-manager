import { useState, useEffect, useCallback } from 'react'
import './SettingsDialog.css'
import type { SettingsPage, GlobalSettingsDraft, ProjectSettingsDraft, SettingsDialogProps } from './settings-types'
import {
  createDefaultGlobalDraft,
  createDefaultProjectDraft,
  isGlobalDirty,
  isProjectDirty,
  normalizeGlobalDraft,
  normalizeProjectDraft,
} from './settings-validation'
import { SettingsNavigation } from './components/SettingsNavigation'
import { SettingsFooter } from './components/SettingsFooter'
import { GeneralSettingsPage } from './pages/GeneralSettingsPage'
import { PayerSettingsPage } from './pages/PayerSettingsPage'
import { ProjectHistoryPage } from './pages/ProjectHistoryPage'
import { AboutPage } from './pages/AboutPage'
import { ProjectLocationPage } from './pages/ProjectLocationPage'
import { SyncSettingsPage } from './pages/SyncSettingsPage'
import { ProjectTablePage } from './pages/ProjectTablePage'
import { validateTableConfig } from '../domain/table-config'
import { validateTableTemplates } from '../domain/table-templates'
import { TemplateManagementPage } from './pages/TemplateManagementPage'

const GLOBAL_PAGES: SettingsPage[] = ['general', 'tableTemplates', 'payers', 'projectHistory', 'sync', 'about']
const PROJECT_PAGES: SettingsPage[] = ['projectLocation', 'projectTable']

export function SettingsDialog({
  isOpen,
  onClose,
  appSettings,
  session,
  onSave,
  onSessionChange,
  onAppSettingsChange,
}: SettingsDialogProps) {
  const [currentPage, setCurrentPage] = useState<SettingsPage>('general')
  const [globalDraft, setGlobalDraft] = useState<GlobalSettingsDraft | null>(null)
  const [projectDraft, setProjectDraft] = useState<ProjectSettingsDraft | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  // 每次打开都从已保存的数据创建草稿；取消后重新打开不能沿用旧草稿。
  useEffect(() => {
    if (isOpen) setGlobalDraft(appSettings ? createDefaultGlobalDraft(appSettings) : null)
  }, [appSettings, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (session?.project) {
      setProjectDraft(createDefaultProjectDraft(session.project))
    } else {
      setProjectDraft(null)
    }
  }, [session, isOpen])

  // 当项目关闭时，切换到全局页面
  useEffect(() => {
    if (!session && PROJECT_PAGES.includes(currentPage)) {
      setCurrentPage('general')
      setEditorOpen(false)
    }
  }, [session, currentPage])

  useEffect(() => {
    if (!isOpen) {
      setGlobalDraft(null)
      setProjectDraft(null)
      setEditorOpen(false)
    }
  }, [isOpen])

  const updateGlobalDraft = useCallback((update: Partial<GlobalSettingsDraft>) => {
    setGlobalDraft((prev) => (prev ? { ...prev, ...update } : null))
  }, [])

  const updateProjectDraft = useCallback((update: Partial<ProjectSettingsDraft>) => {
    setProjectDraft((prev) => (prev ? { ...prev, ...update } : null))
  }, [])

  const handlePageChange = useCallback((page: SettingsPage) => {
    if (page === currentPage) return
    if (editorOpen && !window.confirm('当前列尚未完成，确认放弃修改并切换页面？')) return
    setCurrentPage(page)
    setEditorOpen(false)
    setSaveError(null)
  }, [currentPage, editorOpen])

  const globalDirty = globalDraft && appSettings ? isGlobalDirty(globalDraft, appSettings) : false
  const projectDirty = projectDraft && session ? isProjectDirty(projectDraft, session.project) : false

  const handleSave = useCallback(async () => {
    if (!globalDraft || !appSettings) return
    if (editorOpen) return

    setIsSaving(true)
    setSaveError(null)

    try {
      const normalizedGlobal = normalizeGlobalDraft(globalDraft)
      const templateErrors = validateTableTemplates(normalizedGlobal.tableTemplates, normalizedGlobal.defaultTableTemplateId)
      if (templateErrors.length) throw new Error(templateErrors[0])
      if (projectDraft && session && projectDirty) {
        if (session.readOnly) throw new Error('只读项目无法修改设置')
        const errors = validateTableConfig(projectDraft.tableConfig, session.project)
        if (errors.length) throw new Error(errors[0])
      }
      await onSave(
        normalizedGlobal,
        projectDraft ? normalizeProjectDraft(projectDraft) : null,
        Boolean(globalDirty),
        Boolean(projectDirty),
      )
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }, [globalDraft, projectDraft, globalDirty, projectDirty, appSettings, session, editorOpen, onSave, onClose])

  const handleCancel = useCallback(() => {
    if ((editorOpen || globalDirty || projectDirty) && !window.confirm('存在未保存的设置或未完成的列编辑，确认放弃修改？')) return
    setGlobalDraft(appSettings ? createDefaultGlobalDraft(appSettings) : null)
    setProjectDraft(session ? createDefaultProjectDraft(session.project) : null)
    setEditorOpen(false)
    setSaveError(null)
    onClose()
  }, [editorOpen, globalDirty, projectDirty, appSettings, session, onClose])

  const handleResetDefaults = useCallback(() => {
    if (currentPage === 'general') {
      setGlobalDraft((current) => current ? {
        ...current,
        defaultViewMode: 'table',
        defaultIncludePayments: true,
        defaultIncludeOtherAttachments: true,
        showProjectHistoryOnStartup: true,
        autoOpenLastProject: false,
        showSuccessMessages: true,
      } : null)
    }
  }, [currentPage])

  // 计算脏状态
  const dirty = globalDirty || projectDirty
  const dirtyCount = [globalDirty, projectDirty].filter(Boolean).length

  // 计算未保存状态文本
  const dirtyText = dirtyCount > 0 ? `有 ${dirtyCount} 项未保存修改` : ''

  if (!isOpen) return null
  if (!globalDraft) return null
  if (PROJECT_PAGES.includes(currentPage) && (!session || !projectDraft)) return null

  const hasProject = !!session
  const showResetDefaults = GLOBAL_PAGES.includes(currentPage) && currentPage === 'general'

  // 渲染当前页面
  const renderPage = () => {
    const commonProps = {
      draft: hasProject && PROJECT_PAGES.includes(currentPage) ? projectDraft! : globalDraft!,
      updateDraft: (hasProject && PROJECT_PAGES.includes(currentPage) ? updateProjectDraft : updateGlobalDraft) as any,
      appSettings: appSettings!,
      session: session || undefined,
      onSessionChange,
      onAppSettingsChange,
      onCloseSettings: onClose,
      onEditorStateChange: setEditorOpen,
    }

    switch (currentPage) {
      case 'general':
        return <GeneralSettingsPage {...commonProps} />
      case 'tableTemplates':
        return <TemplateManagementPage {...commonProps} />
      case 'payers':
        return <PayerSettingsPage {...commonProps} />
      case 'projectHistory':
        return <ProjectHistoryPage {...commonProps} />
      case 'sync':
        return <SyncSettingsPage {...commonProps} />
      case 'about':
        return <AboutPage {...commonProps} />
      case 'projectTable':
        return <ProjectTablePage {...commonProps} tableContext="project" />
      case 'projectLocation':
        return <ProjectLocationPage {...commonProps} />
      default:
        return null
    }
  }

  return (
    <div className="settings-center-dialog-overlay">
      <div className="settings-center-dialog">
        {/* 标题栏 */}
        <div className="settings-center-header">
          <h1>设置</h1>
          <button className="dialog-close-button settings-close-button" onClick={handleCancel} aria-label="关闭" title="关闭">
            <svg aria-hidden="true" viewBox="0 0 1024 1024">
              <path d="M886.784 746.496q29.696 30.72 43.52 56.32t-4.608 58.368q-4.096 6.144-11.264 14.848t-14.848 16.896-15.36 14.848-12.8 9.728q-25.6 15.36-60.416 8.192t-62.464-34.816l-43.008-43.008-57.344-57.344-67.584-67.584-73.728-73.728-131.072 131.072q-60.416 60.416-98.304 99.328-38.912 38.912-77.312 48.128t-68.096-17.408l-7.168-7.168-11.264-11.264-11.264-11.264q-6.144-6.144-7.168-8.192-11.264-14.336-13.312-29.184t2.56-29.184 13.824-27.648 20.48-24.576q9.216-8.192 32.768-30.72l55.296-57.344q33.792-32.768 75.264-73.728t86.528-86.016q-49.152-49.152-93.696-93.184t-79.872-78.848-57.856-56.832-27.648-27.136q-26.624-26.624-27.136-52.736t17.92-52.736q8.192-10.24 23.552-24.064t21.504-17.92q30.72-20.48 55.296-17.92t49.152 28.16l31.744 31.744q23.552 23.552 58.368 57.344t78.336 76.288 90.624 88.576q38.912-38.912 76.288-75.776t69.632-69.12 58.368-57.856 43.52-43.008q24.576-23.552 53.248-31.232t55.296 12.8q1.024 1.024 6.656 5.12t11.264 9.216 10.752 9.728 7.168 5.632q27.648 26.624 27.136 57.856t-27.136 57.856q-18.432 18.432-45.568 46.08t-60.416 60.416-70.144 69.632l-77.824 77.824q37.888 36.864 74.24 72.192t67.584 66.048 56.32 56.32 41.472 41.984z" />
            </svg>
          </button>
        </div>

        <div className="settings-center-layout">
          {/* 左侧导航 */}
          <SettingsNavigation
            currentPage={currentPage}
            onPageChange={handlePageChange}
            hasProject={hasProject}
            disabled={isSaving}
          />

          {/* 右侧内容区 */}
          <div className={`settings-center-content ${['payers', 'projectTable', 'tableTemplates'].includes(currentPage) ? 'settings-list-only-content' : ''}`}>
            {renderPage()}
          </div>
        </div>

        {/* 底部操作栏 */}
        {!editorOpen && <SettingsFooter
          dirtyText={dirtyText}
          showResetDefaults={showResetDefaults}
          onResetDefaults={handleResetDefaults}
          onCancel={handleCancel}
          onSave={handleSave}
          isSaving={isSaving}
          saveError={saveError}
        />}
      </div>
    </div>
  )
}
