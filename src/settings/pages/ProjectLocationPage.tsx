import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import type { PageProps, ProjectSettingsDraft } from '../settings-types'

export function ProjectLocationPage({ draft, updateDraft, session, onSessionChange, onAppSettingsChange, onCloseSettings }: PageProps) {
  const projectDraft = draft as ProjectSettingsDraft
  if (!session) {
    return <div className="settings-page">没有打开的项目</div>
  }

  const project = session.project
  const isReadOnly = session.readOnly

  const handleOpenFolder = async () => {
    try {
      await window.invoiceManager.revealProject()
    } catch (error) {
      alert(`打开文件夹失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const handleMoveProject = async () => {
    if (isReadOnly) {
      alert('只读模式下无法移动项目')
      return
    }

    try {
      const result = await window.invoiceManager.moveCurrentProject()
      if (result) {
        onSessionChange?.(result.session)
        onAppSettingsChange?.(result.settings)
      }
    } catch (error) {
      alert(`移动项目失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const handleDeleteProject = async () => {
    if (isReadOnly) {
      alert('只读模式下无法删除项目')
      return
    }

    const projectName = session.project.name
    const confirmed = prompt(`请输入项目名称"${projectName}"以确认删除`)

    if (confirmed !== projectName) {
      alert('项目名称不匹配，操作已取消')
      return
    }

    try {
      const settings = await window.invoiceManager.deleteCurrentProject()
      onAppSettingsChange?.(settings)
      onSessionChange?.(null)
      onCloseSettings?.()
    } catch (error) {
      alert(`删除项目失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  return (
    <div className="settings-page">
      <SettingsSection title="项目文件与操作">
        <div className="project-location-info">
          <div className="project-location-row">
            <span className="project-location-label">项目名称</span>
            {isReadOnly ? (
              <span className="project-location-value">{projectDraft.name}</span>
            ) : (
              <input
                type="text"
                className="settings-input project-info-input"
                value={projectDraft.name}
                onChange={(event) => updateDraft({ name: event.target.value } as Partial<ProjectSettingsDraft>)}
                maxLength={80}
              />
            )}
          </div>
          <div className="project-location-row">
            <span className="project-location-label">项目文件夹</span>
            <span className="project-location-value">{session.rootPath}</span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">创建时间</span>
            <span className="project-location-value">
              {new Date(project.createdAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">更新时间</span>
            <span className="project-location-value">
              {new Date(project.updatedAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">明细数量</span>
            <span className="project-location-value">{project.expenses.length}</span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">附件数量</span>
            <span className="project-location-value">{project.attachments.length}</span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">数据版本</span>
            <span className="project-location-value">{project.schemaVersion}</span>
          </div>
          <div className="project-location-row">
            <span className="project-location-label">当前状态</span>
            <span className="project-location-value">{isReadOnly ? '只读' : '可编辑'}</span>
          </div>
        </div>

        <div className="project-location-actions">
          <button
            className="settings-button settings-button-secondary"
            onClick={handleOpenFolder}
          >
            在文件管理器中打开
          </button>

          <button
            className="settings-button settings-button-secondary"
            onClick={handleMoveProject}
            disabled={isReadOnly}
          >
            移动项目
          </button>

          <button
            className="settings-button settings-button-danger"
            onClick={handleDeleteProject}
            disabled={isReadOnly}
          >
            删除项目
          </button>
        </div>

        {isReadOnly && (
          <p className="settings-description">
            项目以只读模式打开，无法移动或删除。
          </p>
        )}

        <div className="settings-description settings-warning">
          ⚠️ 删除操作会将项目移至系统回收站，可从回收站恢复。
        </div>
      </SettingsSection>
    </div>
  )
}
