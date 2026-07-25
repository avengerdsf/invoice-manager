import { useState, useEffect } from 'react'
import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import type { PageProps } from '../settings-types'
import type { RecentProjectStatus } from '../../shared/models'

export function ProjectHistoryPage({ appSettings, onSessionChange, onAppSettingsChange, onCloseSettings }: PageProps) {
  const [projectStatuses, setProjectStatuses] = useState<RecentProjectStatus[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isRelocating, setIsRelocating] = useState(false)

  useEffect(() => {
    loadProjectStatuses()
  }, [appSettings])

  const loadProjectStatuses = async () => {
    setIsLoading(true)
    try {
      const statuses = await window.invoiceManager.getRecentProjectStatuses()
      setProjectStatuses(statuses)
    } catch (error) {
      console.error('加载项目记录失败:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleOpenProject = async (rootPath: string) => {
    try {
      const opened = await window.invoiceManager.openRecentProject(rootPath)
      onSessionChange?.(opened)
      onCloseSettings?.()
    } catch (error) {
      alert(`打开项目失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const handleRemoveProject = async (rootPath: string) => {
    if (!confirm('确定要移除此项目记录吗？这不会删除项目文件夹。')) return

    try {
      const settings = await window.invoiceManager.removeRecentProject(rootPath)
      onAppSettingsChange?.(settings)
      await loadProjectStatuses()
    } catch (error) {
      alert(`移除记录失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const handleRelocateProject = async (oldRootPath: string) => {
    if (isRelocating) return

    setIsRelocating(true)
    try {
      const result = await window.invoiceManager.relocateRecentProject(oldRootPath)
      if (result) {
        onAppSettingsChange?.(result)
        await loadProjectStatuses()
      }
    } catch (error) {
      alert(`重新定位失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setIsRelocating(false)
    }
  }

  const handleRemoveInvalid = async () => {
    if (!confirm('确定要清理所有失效的项目记录吗？')) return

    try {
      const settings = await window.invoiceManager.removeInvalidRecentProjects()
      onAppSettingsChange?.(settings)
      await loadProjectStatuses()
    } catch (error) {
      alert(`清理失效记录失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const availableProjects = projectStatuses.filter((p) => p.available)
  const unavailableProjects = projectStatuses.filter((p) => !p.available)

  return (
    <div className="settings-page settings-fill-page project-history-page">
      <SettingsSection title="项目记录">
        {isLoading ? (
          <div className="loading-text">加载中...</div>
        ) : projectStatuses.length === 0 ? (
          <div className="empty-text">暂无项目记录</div>
        ) : (
          <>
            <div className="project-history-list">
              {availableProjects.map((project) => (
                <div key={project.rootPath} className="project-history-item available">
                  <div className="project-history-info">
                    <div className="project-history-name">{project.name}</div>
                    <div className="project-history-path">{project.rootPath}</div>
                    <div className="project-history-date">
                      最后打开: {formatDate(project.lastOpenedAt)}
                    </div>
                  </div>
                  <div className="project-history-actions">
                    <button
                      className="project-history-button"
                      onClick={() => handleOpenProject(project.rootPath)}
                    >
                      打开
                    </button>
                    <button
                      className="project-history-button"
                      onClick={() => handleRelocateProject(project.rootPath)}
                      disabled={isRelocating}
                    >
                      重新定位
                    </button>
                    <button
                      className="project-history-button project-history-button-danger"
                      onClick={() => handleRemoveProject(project.rootPath)}
                    >
                      移除记录
                    </button>
                  </div>
                </div>
              ))}

              {unavailableProjects.map((project) => (
                <div key={project.rootPath} className="project-history-item unavailable">
                  <div className="project-history-info">
                    <div className="project-history-name">{project.name}</div>
                    <div className="project-history-path">{project.rootPath}</div>
                    <div className="project-history-status">项目不可用</div>
                  </div>
                  <div className="project-history-actions">
                    <button
                      className="project-history-button"
                      onClick={() => handleRelocateProject(project.rootPath)}
                      disabled={isRelocating}
                    >
                      重新定位
                    </button>
                    <button
                      className="project-history-button project-history-button-danger"
                      onClick={() => handleRemoveProject(project.rootPath)}
                    >
                      移除记录
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {unavailableProjects.length > 0 && (
              <div className="project-history-footer">
                <button
                  className="settings-button settings-button-secondary"
                  onClick={handleRemoveInvalid}
                >
                  清理失效记录
                </button>
              </div>
            )}
          </>
        )}
      </SettingsSection>
    </div>
  )
}
