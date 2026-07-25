import { useState } from 'react'
import './SettingsPage.css'
import { SettingsSection, SettingControl, SettingsRow } from '../components/SettingsSection'
import type { GlobalSettingsDraft, PageProps } from '../settings-types'

export function SyncSettingsPage({ draft, updateDraft }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft
  const sync = globalDraft.syncWebdav
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState('')

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
        <SettingsRow label="第三方应用密码" description={sync.passwordConfigured && !sync.password ? '已保存安全存储密码；留空表示继续使用' : undefined}>
          <input
            className="settings-input sync-settings-input"
            type="password"
            value={sync.password}
            placeholder={sync.passwordConfigured ? '已保存，留空不变' : ''}
            onChange={(event) => updateSync({ password: event.target.value, clearPassword: false })}
          />
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

