import { useState, useEffect } from 'react'
import './SettingsPage.css'
import { SettingsSection } from '../components/SettingsSection'
import type { PageProps } from '../settings-types'
import type { AppDiagnostics } from '../../shared/models'

export function AboutPage({ appSettings }: PageProps) {
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null)

  useEffect(() => {
    loadDiagnostics()
  }, [])

  const loadDiagnostics = async () => {
    try {
      const info = await window.invoiceManager.getAppDiagnostics()
      setDiagnostics(info)
    } catch (error) {
      console.error('加载诊断信息失败:', error)
    }
  }

  const handleOpenDataDirectory = async () => {
    try {
      await window.invoiceManager.openAppDataDirectory()
    } catch (error) {
      alert(`打开数据目录失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const handleCopyDiagnostics = () => {
    if (!diagnostics) return

    const text = [
      `产品名称: ${diagnostics.productName}`,
      `版本: ${diagnostics.version}`,
      `平台: ${diagnostics.platform}`,
      `架构: ${diagnostics.arch}`,
      `数据目录: ${diagnostics.userDataPath}`,
      `OCR 模型: ${diagnostics.ocrModelReady ? '已就绪' : '未就绪'}`,
    ].join('\n')

    navigator.clipboard.writeText(text).then(() => {
      alert('诊断信息已复制到剪贴板')
    }).catch(() => {
      alert('复制失败')
    })
  }

  if (!diagnostics) {
    return <div className="settings-page">加载中...</div>
  }

  return (
    <div className="settings-page">
      <SettingsSection title="关于">
        <div className="about-info">
          <div className="about-row">
            <span className="about-label">产品名称</span>
            <span className="about-value">{diagnostics.productName}</span>
          </div>
          <div className="about-row">
            <span className="about-label">版本</span>
            <span className="about-value">{diagnostics.version}</span>
          </div>
          <div className="about-row">
            <span className="about-label">平台</span>
            <span className="about-value">{diagnostics.platform} {diagnostics.arch}</span>
          </div>
          <div className="about-row">
            <span className="about-label">数据目录</span>
            <span className="about-value about-value-path">{diagnostics.userDataPath}</span>
          </div>
          <div className="about-row">
            <span className="about-label">OCR 模型</span>
            <span className="about-value">
              {diagnostics.ocrModelReady ? '文件已找到' : '未就绪'}
            </span>
          </div>
        </div>

        <div className="about-actions">
          <button
            className="settings-button settings-button-secondary"
            onClick={handleOpenDataDirectory}
          >
            打开数据目录
          </button>
          <button
            className="settings-button settings-button-secondary"
            onClick={handleCopyDiagnostics}
          >
            复制诊断信息
          </button>
        </div>
      </SettingsSection>
    </div>
  )
}
