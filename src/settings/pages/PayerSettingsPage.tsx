import { useState, useEffect } from 'react'
import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import type { PageProps, GlobalSettingsDraft } from '../settings-types'
import type { PayerUsage } from '../../shared/models'

export function PayerSettingsPage({ draft, updateDraft, appSettings }: PageProps) {
  const globalDraft = draft as GlobalSettingsDraft
  const [newPayer, setNewPayer] = useState('')
  const [newPayerError, setNewPayerError] = useState('')
  const [payerUsage, setPayerUsage] = useState<PayerUsage[]>([])
  const [isLoadingUsage, setIsLoadingUsage] = useState(false)

  useEffect(() => {
    loadPayerUsage()
  }, [appSettings])

  const loadPayerUsage = async () => {
    setIsLoadingUsage(true)
    try {
      const usage = await window.invoiceManager.getPayerUsage()
      setPayerUsage(usage)
    } catch (error) {
      console.error('加载付款人使用统计失败:', error)
    } finally {
      setIsLoadingUsage(false)
    }
  }

  const handleAddPayer = () => {
    const trimmed = newPayer.trim()
    if (!trimmed) return
    if (globalDraft.payerNames.includes(trimmed)) {
      setNewPayerError('该付款人已存在')
      return
    }
    updateDraft({
      payerNames: [...globalDraft.payerNames, trimmed],
    } as Partial<GlobalSettingsDraft>)
    setNewPayer('')
    setNewPayerError('')
  }

  const handleRemovePayer = (payerName: string) => {
    const usage = payerUsage.find((u) => u.payerName === payerName)
    if (usage && (usage.projectCount > 0 || usage.expenseCount > 0)) {
      alert(`该付款人正在被 ${usage.projectCount} 个项目、${usage.expenseCount} 条明细使用，无法删除`)
      return
    }
    updateDraft({
      payerNames: globalDraft.payerNames.filter((name) => name !== payerName),
    } as Partial<GlobalSettingsDraft>)
  }

  const getPayerUsageInfo = (payerName: string) => {
    const usage = payerUsage.find((u) => u.payerName === payerName)
    if (!usage || (usage.projectCount === 0 && usage.expenseCount === 0)) {
      return null
    }
    return `${usage.projectCount} 个项目、${usage.expenseCount} 条明细使用中`
  }

  return (
    <div className="settings-page settings-fill-page">
      <SettingsSection title="全局付款人">
        <div className="payer-add-form">
          <input
            type="text"
            className="settings-input payer-input"
            placeholder="输入新付款人名称"
            value={newPayer}
            onChange={(e) => {
              setNewPayer(e.target.value)
              if (newPayerError) setNewPayerError('')
            }}
            maxLength={80}
            onKeyPress={(e) => e.key === 'Enter' && handleAddPayer()}
          />
          <button
            className="settings-button settings-button-primary"
            onClick={handleAddPayer}
            disabled={!newPayer.trim()}
          >
            添加
          </button>
          {newPayerError && <div className="settings-inline-error payer-add-error">{newPayerError}</div>}
        </div>

        <div className="payer-list">
          {globalDraft.payerNames.map((payerName) => {
            const usageInfo = getPayerUsageInfo(payerName)
            return (
              <div key={payerName} className="payer-item">
                <div className="payer-info">
                  <span className="payer-name">{payerName}</span>
                  {usageInfo && <span className="payer-usage">{usageInfo}</span>}
                </div>
                <button
                  className="payer-remove-button"
                  onClick={() => handleRemovePayer(payerName)}
                  disabled={!!usageInfo}
                  title={usageInfo ? '已使用的付款人无法删除' : '删除付款人'}
                >
                  删除
                </button>
              </div>
            )
          })}
        </div>

      </SettingsSection>
    </div>
  )
}
