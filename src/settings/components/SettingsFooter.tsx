import './SettingsFooter.css'

interface SettingsFooterProps {
  dirtyText: string
  showResetDefaults: boolean
  onResetDefaults: () => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  saveError: string | null
}

export function SettingsFooter({
  dirtyText,
  showResetDefaults,
  onResetDefaults,
  onCancel,
  onSave,
  isSaving,
  saveError,
}: SettingsFooterProps) {
  return (
    <div className="settings-center-footer">
      <div className="settings-footer-left">
        {showResetDefaults && (
          <button
            className="settings-button settings-button-secondary"
            onClick={onResetDefaults}
            disabled={isSaving}
          >
            恢复本页默认
          </button>
        )}
        {dirtyText && (
          <span className="settings-dirty-text">{dirtyText}</span>
        )}
      </div>

      <div className="settings-footer-right">
        {saveError && (
          <div className="settings-error-message" role="alert">
            {saveError}
          </div>
        )}
        <button
          className="settings-button settings-button-secondary"
          onClick={onCancel}
          disabled={isSaving}
        >
          取消
        </button>
        <button
          className="settings-button settings-button-primary"
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <>
              <span className="settings-spinner" />
              保存中...
            </>
          ) : (
            '保存设置'
          )}
        </button>
      </div>
    </div>
  )
}
