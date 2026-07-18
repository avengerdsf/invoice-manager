import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettingsUpdate, AttachmentKind, ExportOptions, InvoiceManagerApi, Project } from '../src/shared/models'

const IPC_CHANNELS = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  createProject: 'project:create',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  saveProject: 'project:save',
  importAttachments: 'attachment:import',
  readAttachmentForOcr: 'attachment:read-for-ocr',
  openAttachment: 'attachment:open',
  revealProject: 'project:reveal',
  exportProject: 'project:export',
} as const

const api: InvoiceManagerApi = {
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings: AppSettingsUpdate) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  createProject: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.createProject, name),
  openProject: () => ipcRenderer.invoke(IPC_CHANNELS.openProject),
  openRecentProject: (rootPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openRecentProject, rootPath),
  saveProject: (project: Project) => ipcRenderer.invoke(IPC_CHANNELS.saveProject, project),
  importAttachments: (kind: AttachmentKind) => ipcRenderer.invoke(IPC_CHANNELS.importAttachments, kind),
  readAttachmentForOcr: (attachmentId: string) => ipcRenderer.invoke(IPC_CHANNELS.readAttachmentForOcr, attachmentId),
  openAttachment: (attachmentId: string) => ipcRenderer.invoke(IPC_CHANNELS.openAttachment, attachmentId),
  revealProject: () => ipcRenderer.invoke(IPC_CHANNELS.revealProject),
  exportProject: (project: Project, options: ExportOptions) => ipcRenderer.invoke(IPC_CHANNELS.exportProject, project, options),
}

contextBridge.exposeInMainWorld('invoiceManager', api)
