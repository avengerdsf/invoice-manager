import './SettingsPage.css'
import CustomSelect from '../../components/CustomSelect'
import { SettingsSection, SettingControl } from '../components/SettingsSection'
import type { PageProps, GlobalSettingsDraft } from '../settings-types'

export function GeneralSettingsPage({ draft, updateDraft }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft

  return (
    <div className="settings-page">
      <SettingsSection title="基础设置">
        <div className="settings-row">
          <div className="settings-row-info">
            <label className="settings-label" htmlFor="default-view-mode">初始页面</label>
            <p className="settings-description">打开项目后默认进入的页面</p>
          </div>
          <div className="settings-row-control">
            <CustomSelect
              className="settings-select"
              value={globalDraft.defaultViewMode}
              onChange={(value) => updateDraft({ defaultViewMode: value as GlobalSettingsDraft['defaultViewMode'] } as Partial<GlobalSettingsDraft>)}
              options={[
                { value: 'table', label: '表格视图' },
                { value: 'card', label: '卡片视图' },
              ]}
            />
          </div>
        </div>
        <SettingControl
          label="启动时显示项目记录"
          description="在开始页显示最近打开的项目"
          checked={globalDraft.showProjectHistoryOnStartup}
          onChange={(checked) => updateDraft({ showProjectHistoryOnStartup: checked } as Partial<GlobalSettingsDraft>)}
        />
        <SettingControl
          label="自动打开上次项目"
          description="启动后自动打开最近使用的项目"
          checked={globalDraft.autoOpenLastProject}
          onChange={(checked) => updateDraft({ autoOpenLastProject: checked } as Partial<GlobalSettingsDraft>)}
        />
        <SettingControl
          label="显示成功提示"
          description="操作成功时显示提示消息"
          checked={globalDraft.showSuccessMessages}
          onChange={(checked) => updateDraft({ showSuccessMessages: checked } as Partial<GlobalSettingsDraft>)}
        />
        <SettingControl
          label="导出时包含支付截图"
          description="新建导出任务时默认勾选支付截图"
          checked={globalDraft.defaultIncludePayments}
          onChange={(checked) => updateDraft({ defaultIncludePayments: checked } as Partial<GlobalSettingsDraft>)}
        />
        <SettingControl
          label="导出时包含其他附件"
          description="新建导出任务时默认勾选其他附件"
          checked={globalDraft.defaultIncludeOtherAttachments}
          onChange={(checked) => updateDraft({ defaultIncludeOtherAttachments: checked } as Partial<GlobalSettingsDraft>)}
        />
      </SettingsSection>
    </div>
  )
}
