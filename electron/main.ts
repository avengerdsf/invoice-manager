import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { AppSettingsStorage } from './app-settings'
import { exportProject } from './exporter'
import { ProjectStorage } from './project-storage'
import type { AttachmentKind, ExportOptions, Project } from '../src/shared/models'
import { IPC_CHANNELS, ProjectSchema } from '../src/shared/models'

const storage = new ProjectStorage()
const settingsStorage = new AppSettingsStorage(path.join(app.getPath('userData'), 'settings.json'))
let mainWindow: BrowserWindow | null = null

const sessionDataPath = path.join(app.getPath('temp'), 'InvoiceManager', 'Session')
mkdirSync(sessionDataPath, { recursive: true })
app.setPath('sessionData', sessionDataPath)
app.setAppLogsPath()

protocol.registerSchemesAsPrivileged([{
  scheme: 'invoice-app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}])

function rendererRoot(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'dist')
    : path.join(__dirname, '..', '..', 'dist')
}

function registerRendererProtocol(): void {
  protocol.handle('invoice-app', (request) => {
    const requestedPath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html'
    const rootPath = rendererRoot()
    const resolvedPath = path.resolve(rootPath, requestedPath)
    const relativePath = path.relative(rootPath, resolvedPath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(resolvedPath).href)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f5f7fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  const developmentUrl = process.env.VITE_DEV_SERVER_URL
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl)
  } else {
    void mainWindow.loadURL('invoice-app://bundle/index.html')
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.getSettings, () => settingsStorage.read())

  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, rawSettings: unknown) => {
    return settingsStorage.saveSettings(rawSettings)
  })

  ipcMain.handle(IPC_CHANNELS.createProject, async (_event, rawName: unknown) => {
    if (typeof rawName !== 'string') throw new Error('项目名称格式无效')
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择项目保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const session = await storage.create(selection.filePaths[0], rawName, app.getVersion())
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.openProject, async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '打开报销项目',
      properties: ['openDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const session = await storage.open(selection.filePaths[0])
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.openRecentProject, async (_event, rawRootPath: unknown) => {
    if (typeof rawRootPath !== 'string' || !(await settingsStorage.isRecentProject(rawRootPath))) {
      throw new Error('最近项目不存在')
    }
    const session = await storage.open(rawRootPath)
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.saveProject, async (_event, rawProject: unknown) => {
    const project = await storage.save(ProjectSchema.parse(rawProject))
    if (storage.activeRoot) {
      await settingsStorage.rememberProject({ project, rootPath: storage.activeRoot, readOnly: false })
    }
    return project
  })

  ipcMain.handle(IPC_CHANNELS.importAttachments, async (_event, rawKind: unknown) => {
    if (rawKind !== 'invoice' && rawKind !== 'payment') throw new Error('附件类型无效')
    const kind = rawKind as AttachmentKind
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'invoice' ? '导入发票' : '导入支付截图',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '支持的附件', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (selection.canceled) return []
    return storage.importFiles(kind, selection.filePaths)
  })

  ipcMain.handle(IPC_CHANNELS.readAttachmentForOcr, async (_event, attachmentId: unknown) => {
    if (typeof attachmentId !== 'string') throw new Error('附件标识无效')
    const attachment = storage.activeProject?.attachments.find((item) => item.id === attachmentId)
    if (!attachment || attachment.kind !== 'invoice') throw new Error('OCR 只能读取已导入的发票')
    if (attachment.size > 50 * 1024 * 1024) throw new Error('发票文件超过 50 MB，无法识别')
    const file = await readFile(storage.getAttachmentPath(attachmentId))
    const data = Uint8Array.from(file).buffer
    return { mimeType: attachment.mimeType, data }
  })

  ipcMain.handle(IPC_CHANNELS.openAttachment, async (_event, attachmentId: unknown) => {
    if (typeof attachmentId !== 'string') throw new Error('附件标识无效')
    const error = await shell.openPath(storage.getAttachmentPath(attachmentId))
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC_CHANNELS.revealProject, async () => {
    if (!storage.activeRoot) throw new Error('没有活动项目')
    const error = await shell.openPath(storage.activeRoot)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC_CHANNELS.exportProject, async (_event, rawProject: unknown, rawOptions: unknown) => {
    if (!storage.activeRoot) throw new Error('请先创建或打开项目')
    const project = await storage.save(ProjectSchema.parse(rawProject))
    const options = rawOptions as ExportOptions
    if (typeof options?.includePayments !== 'boolean') throw new Error('导出选项无效')
    const exportDirectory = path.join(app.getPath('documents'), '发票整理', 'Exports')
    mkdirSync(exportDirectory, { recursive: true })
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出报销压缩包',
      defaultPath: path.join(exportDirectory, `${project.name}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    })
    if (selection.canceled || !selection.filePath) return null
    await exportProject(project, storage.activeRoot, selection.filePath, path.join(app.getPath('temp'), 'InvoiceManager'), options)
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: '导出完成',
      message: '压缩包导出完成',
      detail: selection.filePath,
      buttons: ['打开导出目录', '关闭'],
      defaultId: 0,
      cancelId: 1,
    })
    if (confirmation.response === 0) {
      const error = await shell.openPath(path.dirname(selection.filePath))
      if (error) throw new Error(`无法打开导出目录：${error}`)
    }
    return { filePath: selection.filePath, project }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerRendererProtocol()
    registerIpc()
    createWindow()
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  void storage.close()
})
