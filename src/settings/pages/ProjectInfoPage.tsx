import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import type { PageProps, ProjectSettingsDraft } from '../settings-types'

export function ProjectInfoPage({ draft, updateDraft, session }: PageProps) {
  const projectDraft = draft as ProjectSettingsDraft
  if (!session) {
    return <div className="settings-page">没有打开的项目</div>
  }

  const project = session.project
  const isReadOnly = session.readOnly

  return (
    <div className="settings-page">
      <SettingsSection title="项目信息">
        <div className="project-info-list">
          <div className="project-info-row">
            <span className="project-info-label">项目名称</span>
            {isReadOnly ? (
              <span className="project-info-value">{(draft as ProjectSettingsDraft).name}</span>
            ) : (
              <input
                type="text"
                className="settings-input project-info-input"
                value={projectDraft.name}
                onChange={(e) => updateDraft({ name: e.target.value } as Partial<ProjectSettingsDraft>)}
                maxLength={80}
              />
            )}
          </div>

          <div className="project-info-row">
            <span className="project-info-label">项目文件夹</span>
            <span className="project-info-value project-info-value-path">
              {session.rootPath}
            </span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">创建时间</span>
            <span className="project-info-value">
              {new Date(project.createdAt).toLocaleString('zh-CN')}
            </span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">更新时间</span>
            <span className="project-info-value">
              {new Date(project.updatedAt).toLocaleString('zh-CN')}
            </span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">明细数量</span>
            <span className="project-info-value">{project.expenses.length}</span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">附件数量</span>
            <span className="project-info-value">{project.attachments.length}</span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">数据版本</span>
            <span className="project-info-value">{project.schemaVersion}</span>
          </div>

          <div className="project-info-row">
            <span className="project-info-label">当前状态</span>
            <span className="project-info-value">
              {isReadOnly ? '只读' : '可编辑'}
            </span>
          </div>
        </div>

        {isReadOnly && (
          <p className="settings-description">
            项目以只读模式打开，无法修改项目信息。
          </p>
        )}
      </SettingsSection>
    </div>
  )
}
