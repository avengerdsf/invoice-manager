import type { AppSettings, ProjectSession, ViewMode, Category, AttachmentKind } from '../shared/models'

export type SettingsPage =
  | 'general'
  | 'payers'
  | 'projectHistory'
  | 'sync'
  | 'about'
  | 'categories'
  | 'projectLocation'

export interface GlobalSettingsDraft {
  payerNames: string[]
  defaultViewMode: ViewMode
  defaultIncludePayments: boolean
  defaultIncludeOtherAttachments: boolean
  showProjectHistoryOnStartup: boolean
  autoOpenLastProject: boolean
  showSuccessMessages: boolean
  syncWebdav: {
    enabled: boolean
    url: string
    username: string
    remoteDirectory: string
    password: string
    passwordConfigured: boolean
    clearPassword: boolean
  }
  lastProjectParentDirectory: string | null
  lastOpenProjectDirectory: string | null
  lastExportDirectory: string | null
  lastImportDirectories: Record<AttachmentKind, string | null>
}

export interface ProjectSettingsDraft {
  name: string
  categories: Category[]
}

export interface SettingsDraftState {
  global: GlobalSettingsDraft
  project: ProjectSettingsDraft | null
}

export interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  appSettings: AppSettings | null
  session: ProjectSession | null
  onSave(
    globalDraft: GlobalSettingsDraft,
    projectDraft: ProjectSettingsDraft | null,
    globalDirty: boolean,
    projectDirty: boolean,
  ): Promise<void>
  onSessionChange(session: ProjectSession | null): void
  onAppSettingsChange(settings: AppSettings): void
}

export interface PageProps {
  draft: GlobalSettingsDraft | ProjectSettingsDraft
  updateDraft: (update: Partial<GlobalSettingsDraft | ProjectSettingsDraft>) => void
  appSettings: AppSettings
  session?: ProjectSession
  onSessionChange?(session: ProjectSession | null): void
  onAppSettingsChange?(settings: AppSettings): void
  onCloseSettings?(): void
}
