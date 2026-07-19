import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettingsUpdate, AttachmentKind, ExportOptions, InvoiceManagerApi, Project } from '../src/shared/models'

const IPC_CHANNELS = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  createProject: 'project:create',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  saveProject: 'project:save',
  importAttachments: 'attachment:import',
  importDroppedAttachments: 'attachment:import-dropped',
  readAttachmentForOcr: 'attachment:read-for-ocr',
  readAttachmentPreview: 'attachment:read-preview',
  openAttachment: 'attachment:open',
  revealProject: 'project:reveal',
  exportProject: 'project:export',
  deleteCurrentProject: 'project:delete-current',
  getAllProjectsSummary: 'project:summary-all',
  moveCurrentProject: 'project:move-current',
} as const

const api: InvoiceManagerApi = {
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings: AppSettingsUpdate) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  createProject: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.createProject, name),
  openProject: () => ipcRenderer.invoke(IPC_CHANNELS.openProject),
  openRecentProject: (rootPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openRecentProject, rootPath),
  saveProject: (project: Project) => ipcRenderer.invoke(IPC_CHANNELS.saveProject, project),
  importAttachments: (kind: AttachmentKind) => ipcRenderer.invoke(IPC_CHANNELS.importAttachments, kind),
  importDroppedAttachments: (kind: AttachmentKind, files: File[]) => ipcRenderer.invoke(
    IPC_CHANNELS.importDroppedAttachments,
    kind,
    files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  ),
  readAttachmentForOcr: (attachmentId: string) => ipcRenderer.invoke(IPC_CHANNELS.readAttachmentForOcr, attachmentId),
  readAttachmentPreview: (attachmentId: string) => ipcRenderer.invoke(IPC_CHANNELS.readAttachmentPreview, attachmentId),
  openAttachment: (attachmentId: string) => ipcRenderer.invoke(IPC_CHANNELS.openAttachment, attachmentId),
  revealProject: () => ipcRenderer.invoke(IPC_CHANNELS.revealProject),
  exportProject: (project: Project, options: ExportOptions) => ipcRenderer.invoke(IPC_CHANNELS.exportProject, project, options),
  deleteCurrentProject: () => ipcRenderer.invoke(IPC_CHANNELS.deleteCurrentProject),
  getAllProjectsSummary: (currentProject?: Project) => ipcRenderer.invoke(IPC_CHANNELS.getAllProjectsSummary, currentProject),
  moveCurrentProject: () => ipcRenderer.invoke(IPC_CHANNELS.moveCurrentProject),
}

contextBridge.exposeInMainWorld('invoiceManager', api)
