import { useEffect, useState } from 'react'
import './SettingsPage.css'
import { SettingsSection, SettingControl, SettingsRow } from '../components/SettingsSection'
import type { GlobalSettingsDraft, PageProps } from '../settings-types'

export function SyncSettingsPage({ draft, updateDraft }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft
  const sync = globalDraft.syncWebdav
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState('')
  const [editingPassword, setEditingPassword] = useState(!sync.passwordConfigured)

  useEffect(() => {
    setEditingPassword(!sync.passwordConfigured)
  }, [sync.passwordConfigured])

  const updateSync = (update: Partial<GlobalSettingsDraft['syncWebdav']>) => {
    updateDraft({ syncWebdav: { ...sync, ...update } } as Partial<GlobalSettingsDraft>)
    setTestMessage('')
  }

  const testConnection = async () => {
    setTesting(true)
    setTestMessage('')
    try {
      const result = await window.invoiceManager.testWebdavConnection({
        enabled: sync.enabled,
        url: sync.url,
        username: sync.username,
        remoteDirectory: sync.remoteDirectory,
        password: sync.password || undefined,
      })
      setTestMessage(result.message)
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  const clearConfig = () => {
    updateDraft({
      syncWebdav: {
        enabled: false,
        url: 'https://dav.jianguoyun.com/dav/',
        username: '',
        remoteDirectory: '/InvoiceManager/',
        password: '',
        passwordConfigured: false,
        clearPassword: true,
      },
    } as Partial<GlobalSettingsDraft>)
    setTestMessage('配置已清除，保存后生效')
  }

  return (
    <div className="settings-page">
      <SettingsSection title="同步设置">
        <SettingControl
          label="启用坚果云 WebDAV"
          description="关闭后不会删除本地或远程项目"
          checked={sync.enabled}
          onChange={(checked) => updateSync({ enabled: checked })}
        />
        <SettingsRow label="服务地址" description="坚果云默认地址为 https://dav.jianguoyun.com/dav/">
          <input
            className="settings-input sync-settings-input"
            value={sync.url}
            onChange={(event) => updateSync({ url: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="账号邮箱">
          <input
            className="settings-input sync-settings-input"
            value={sync.username}
            onChange={(event) => updateSync({ username: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="第三方应用密码" description={sync.passwordConfigured && !editingPassword ? '密码已保存在 Electron 安全存储中' : undefined}>
          <div className="sync-password-control">
            <input
              className="settings-input sync-settings-input"
              type={editingPassword ? 'password' : 'text'}
              value={editingPassword ? sync.password : '••••••••'}
              readOnly={!editingPassword}
              disabled={!editingPassword}
              placeholder={editingPassword && sync.passwordConfigured ? '输入新密码' : ''}
              onChange={(event) => updateSync({ password: event.target.value, clearPassword: false })}
            />
            {sync.passwordConfigured && !editingPassword ? (
              <button
                className="settings-button settings-button-secondary sync-password-button"
                type="button"
                onClick={() => setEditingPassword(true)}
              >
                更改
              </button>
            ) : sync.passwordConfigured ? (
              <button
                className="settings-button settings-button-secondary sync-password-button"
                type="button"
                onClick={() => {
                  updateSync({ password: '', clearPassword: false })
                  setEditingPassword(false)
                }}
              >
                取消更改
              </button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow label="远程目录">
          <input
            className="settings-input sync-settings-input"
            value={sync.remoteDirectory}
            onChange={(event) => updateSync({ remoteDirectory: event.target.value })}
          />
        </SettingsRow>
        <div className="sync-settings-actions">
          <button className="settings-button settings-button-secondary" type="button" disabled={testing} onClick={testConnection}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button className="settings-button settings-button-secondary" type="button" onClick={clearConfig}>
            清除配置
          </button>
          {testMessage && <span className="sync-settings-message">{testMessage}</span>}
        </div>
      </SettingsSection>
    </div>
  )
}
