import './SettingsSection.css'

interface SettingsSectionProps {
  title?: string
  children: React.ReactNode
}

export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <div className="settings-section">
      {title && <h2 className="settings-section-title">{title}</h2>}
      <div className="settings-section-content">{children}</div>
    </div>
  )
}

interface SettingsRowProps {
  label: string
  description?: string
  children: React.ReactNode
}

export function SettingsRow({ label, description, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <label className="settings-label">{label}</label>
        {description && <p className="settings-description">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

interface SettingControlProps {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function SettingControl({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: SettingControlProps) {
  return (
    <SettingsRow label={label} description={description}>
      <input
        type="checkbox"
        className="settings-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
    </SettingsRow>
  )
}
