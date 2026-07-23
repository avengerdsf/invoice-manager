import './DirectorySettingRow.css'
import type { SettingsDirectoryKind } from '../../shared/models'

interface DirectorySettingRowProps {
  label: string
  kind: SettingsDirectoryKind
  currentPath: string | null
  status: boolean | null
  onChoose: (kind: SettingsDirectoryKind) => void
  onReset: (kind: SettingsDirectoryKind) => void
}

export function DirectorySettingRow({
  label,
  kind,
  currentPath,
  status,
  onChoose,
  onReset,
}: DirectorySettingRowProps) {
  const statusText = status === null ? '未设置' : status ? '可用' : '不可用'
  const statusClass = status === null ? 'unset' : status ? 'available' : 'unavailable'

  const displayPath = currentPath && currentPath.length > 50
    ? `${currentPath.slice(0, 25)}...${currentPath.slice(-22)}`
    : currentPath || '未设置'

  return (
    <div className="directory-setting-row">
      <div className="directory-setting-info">
        <div className="directory-label">{label}</div>
        <div className={`directory-path ${statusClass}`} title={currentPath || ''}>
          {displayPath}
          <span className={`directory-status ${statusClass}`}>
            {statusText}
          </span>
        </div>
      </div>
      <div className="directory-setting-actions">
        <button
          className="directory-action-button"
          onClick={() => onChoose(kind)}
        >
          选择
        </button>
        {currentPath && (
          <button
            className="directory-action-button directory-reset-button"
            onClick={() => onReset(kind)}
          >
            重置
          </button>
        )}
      </div>
    </div>
  )
}
