import type { SettingsPage } from '../settings-types'
import './SettingsNavigation.css'

interface SettingsNavigationProps {
  currentPage: SettingsPage
  onPageChange: (page: SettingsPage) => void
  hasProject: boolean
  disabled?: boolean
}

const GLOBAL_PAGES = [
  { id: 'general' as SettingsPage, label: '基础设置' },
  { id: 'payers' as SettingsPage, label: '全局付款人' },
  { id: 'projectHistory' as SettingsPage, label: '项目记录' },
  { id: 'about' as SettingsPage, label: '关于' },
]

const PROJECT_PAGES = [
  { id: 'projectLocation' as SettingsPage, label: '项目文件与操作' },
  { id: 'categories' as SettingsPage, label: '发票类别' },
]

export function SettingsNavigation({
  currentPage,
  onPageChange,
  hasProject,
  disabled = false,
}: SettingsNavigationProps) {
  return (
    <nav className="settings-center-nav" aria-label="设置页面">
      <div className="settings-nav-section">
        <div className="settings-nav-section-title">全局设置</div>
        <ul className="settings-nav-list">
          {GLOBAL_PAGES.map((page) => (
            <li key={page.id}>
              <button
                className={`settings-nav-item ${currentPage === page.id ? 'active' : ''}`}
                onClick={() => onPageChange(page.id)}
                disabled={disabled}
                aria-current={currentPage === page.id ? 'page' : undefined}
              >
                {page.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {hasProject && (
        <div className="settings-nav-section">
          <div className="settings-nav-section-title">当前打开的项目</div>
          <ul className="settings-nav-list">
            {PROJECT_PAGES.map((page) => (
              <li key={page.id}>
                <button
                  className={`settings-nav-item ${currentPage === page.id ? 'active' : ''}`}
                  onClick={() => onPageChange(page.id)}
                  disabled={disabled}
                  aria-current={currentPage === page.id ? 'page' : undefined}
                >
                  {page.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  )
}
