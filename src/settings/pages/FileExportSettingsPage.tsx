import { useState, useEffect } from 'react'
import './SettingsPage.css'
import { SettingsSection, SettingControl } from '../components/SettingsSection'
import { DirectorySettingRow } from '../components/DirectorySettingRow'
import type { PageProps, GlobalSettingsDraft } from '../settings-types'
import type { SettingsDirectoryKind, DirectoryStatus } from '../../shared/models'

const DIRECTORY_CONFIG: Array<{
  kind: SettingsDirectoryKind
  label: string
  draftKey: keyof GlobalSettingsDraft
}> = [
  { kind: 'projectParent', label: '新建项目目录', draftKey: 'lastProjectParentDirectory' },
  { kind: 'openProject', label: '打开项目目录', draftKey: 'lastOpenProjectDirectory' },
  { kind: 'invoiceImport', label: '发票导入目录', draftKey: 'lastImportDirectories' },
  { kind: 'paymentImport', label: '支付截图目录', draftKey: 'lastImportDirectories' },
  { kind: 'otherImport', label: '其他附件目录', draftKey: 'lastImportDirectories' },
  { kind: 'export', label: '导出目录', draftKey: 'lastExportDirectory' },
]

export function FileExportSettingsPage({ draft, updateDraft, appSettings }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft
  const [directoryStatus, setDirectoryStatus] = useState<DirectoryStatus | null>(null)
  const [isChoosing, setIsChoosing] = useState(false)

  useEffect(() => {
    loadDirectoryStatus()
  }, [appSettings])

  const loadDirectoryStatus = async () => {
    try {
      const status = await window.invoiceManager.checkSettingsDirectories()
      setDirectoryStatus(status)
    } catch (error) {
      console.error('加载目录状态失败:', error)
    }
  }

  const handleChooseDirectory = async (kind: SettingsDirectoryKind) => {
    if (isChoosing) return
    setIsChoosing(true)

    try {
      const result = await window.invoiceManager.chooseSettingsDirectory(kind)
      if (result) {
        // 根据目录类型更新草稿
        if (kind === 'export') {
          updateDraft({ lastExportDirectory: result })
        } else if (kind === 'projectParent') {
          updateDraft({ lastProjectParentDirectory: result })
        } else if (kind === 'openProject') {
          updateDraft({ lastOpenProjectDirectory: result })
        } else {
          const importDirs = { ...(draft as GlobalSettingsDraft).lastImportDirectories }
          if (kind === 'invoiceImport') importDirs.invoice = result
          if (kind === 'paymentImport') importDirs.payment = result
          if (kind === 'otherImport') importDirs.other = result
          updateDraft({ lastImportDirectories: importDirs })
        }
        setDirectoryStatus((current) => current ? { ...current, [kind]: true } : current)
      }
    } catch (error) {
      console.error('选择目录失败:', error)
      alert(`选择目录失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setIsChoosing(false)
    }
  }

  const handleResetDirectory = (kind: SettingsDirectoryKind) => {
    if (kind === 'export') {
      updateDraft({ lastExportDirectory: null })
    } else if (kind === 'projectParent') {
      updateDraft({ lastProjectParentDirectory: null })
    } else if (kind === 'openProject') {
      updateDraft({ lastOpenProjectDirectory: null })
    } else {
      const importDirs = { ...(draft as GlobalSettingsDraft).lastImportDirectories }
      if (kind === 'invoiceImport') importDirs.invoice = null
      if (kind === 'paymentImport') importDirs.payment = null
      if (kind === 'otherImport') importDirs.other = null
      updateDraft({ lastImportDirectories: importDirs })
    }
    setDirectoryStatus((current) => current ? { ...current, [kind]: null } : current)
  }

  const getDirectoryPath = (config: typeof DIRECTORY_CONFIG[0]): string | null => {
    if (config.draftKey === 'lastImportDirectories') {
      const importDirs = globalDraft.lastImportDirectories
      if (config.kind === 'invoiceImport') return importDirs.invoice
      if (config.kind === 'paymentImport') return importDirs.payment
      if (config.kind === 'otherImport') return importDirs.other
      return null
    }
    return globalDraft[config.draftKey] as string | null
  }

  return (
    <div className="settings-page">
      <SettingsSection title="默认目录">
        {DIRECTORY_CONFIG.map((config) => {
          const path = getDirectoryPath(config)
          const status = path ? (directoryStatus?.[config.kind] ?? true) : null
          return (
            <DirectorySettingRow
              key={config.kind}
              label={config.label}
              kind={config.kind}
              currentPath={path}
              status={status}
              onChoose={handleChooseDirectory}
              onReset={handleResetDirectory}
            />
          )
        })}
      </SettingsSection>

      <SettingsSection title="导出默认选项">
        <SettingControl
          label="默认包含支付截图"
          description="导出时默认包含支付截图"
          checked={globalDraft.defaultIncludePayments}
          onChange={(checked) => updateDraft({ defaultIncludePayments: checked } as Partial<GlobalSettingsDraft>)}
        />
        <SettingControl
          label="默认包含其他附件"
          description="导出时默认包含其他附件"
          checked={globalDraft.defaultIncludeOtherAttachments}
          onChange={(checked) => updateDraft({ defaultIncludeOtherAttachments: checked } as Partial<GlobalSettingsDraft>)}
        />
      </SettingsSection>
    </div>
  )
}
