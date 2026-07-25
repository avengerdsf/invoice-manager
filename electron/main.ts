import { mkdirSync } from 'node:fs'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { AppSettingsStorage } from './app-settings'
import { exportProject } from './exporter'
import { ProjectStorage } from './project-storage'
import {
  createSyncSnapshot,
  installSyncPackage,
  safePackageFileName,
  summarizeProject,
  uniqueProjectRoot,
  validateSyncPackageZip,
  writeSyncPackageZip,
} from './sync-package'
import { WebdavClient, compareSyncState, createLocalSnapshot, syncStatusDetail } from './webdav-sync'
import type {
  AttachmentKind,
  ExportOptions,
  Project,
  ProjectFundsSummary,
  PayerUsage,
  SettingsDirectoryKind,
  DirectoryStatus,
  RecentProjectStatus,
  AppDiagnostics,
  WebdavSyncProgress,
  WebdavSyncStatus,
} from '../src/shared/models'
import { IPC_CHANNELS, ProjectSchema } from '../src/shared/models'
import { calculateProjectSummary } from '../src/domain/project'

function configureInstalledDataPath(): void {
  if (!app.isPackaged || process.platform !== 'win32') return
  const legacyUserDataPath = app.getPath('userData')
  const installDirectory = path.dirname(process.execPath)
  const installedDataPath = path.join(installDirectory, 'data')
  const updateBackupPath = `${installDirectory}.__update-data`
  if (path.resolve(legacyUserDataPath).toLowerCase() === path.resolve(installedDataPath).toLowerCase()) return

  // An updater can fail to rename the preserved directory back because of a
  // transient file lock. Recover it before creating an empty data directory.
  const installedSettingsPath = path.join(installedDataPath, 'settings.json')
  const updateBackupSettingsPath = path.join(updateBackupPath, 'settings.json')
  if (!existsSync(installedSettingsPath) && existsSync(updateBackupSettingsPath)) {
    cpSync(updateBackupPath, installedDataPath, { recursive: true, force: false, errorOnExist: false })
    if (existsSync(installedSettingsPath)) rmSync(updateBackupPath, { recursive: true, force: true })
  }

  mkdirSync(installedDataPath, { recursive: true })
  if (existsSync(legacyUserDataPath)) {
    const legacySettingsPath = path.join(legacyUserDataPath, 'settings.json')
    if (!existsSync(installedSettingsPath) && existsSync(legacySettingsPath)) {
      copyFileSync(legacySettingsPath, installedSettingsPath)
    }
    if (existsSync(installedSettingsPath)) {
      // Do not block the first launch while deleting old Electron caches.
      void rm(legacyUserDataPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  app.setPath('userData', installedDataPath)
}

configureInstalledDataPath()

const storage = new ProjectStorage()
const settingsStorage = new AppSettingsStorage(path.join(app.getPath('userData'), 'settings.json'))
let mainWindow: BrowserWindow | null = null

const sessionDataPath = path.join(app.getPath('temp'), 'InvoiceManager', 'Session')
mkdirSync(sessionDataPath, { recursive: true })
app.setPath('sessionData', sessionDataPath)
app.setAppLogsPath()

async function getDeviceId(): Promise<string> {
  const deviceIdPath = path.join(app.getPath('userData'), 'device-id')
  try {
    const existing = (await readFile(deviceIdPath, 'utf8')).trim()
    if (existing) return existing
  } catch {
    // Created on first sync/export.
  }
  const deviceId = randomUUID()
  await mkdir(path.dirname(deviceIdPath), { recursive: true })
  await writeFile(deviceIdPath, deviceId, 'utf8')
  return deviceId
}

async function findKnownProjectById(projectId: string): Promise<string | null> {
  const settings = await settingsStorage.read()
  const candidates = [...new Set([
    ...settings.knownProjectPaths,
    ...settings.recentProjects.map((project) => project.rootPath),
  ])]
  for (const rootPath of candidates) {
    try {
      const project = ProjectSchema.parse(JSON.parse(await readFile(path.join(rootPath, 'project.json'), 'utf8')))
      if (project.id === projectId) return rootPath
    } catch {
      continue
    }
  }
  return null
}

function formatSyncStatus(status: WebdavSyncStatus): string {
  const stateText = status.state === 'remote-missing'
    ? '远端不存在'
    : status.state === 'latest'
      ? '本地和远端已是最新'
      : status.state === 'local-newer'
        ? '本地较新'
        : status.state === 'remote-newer'
          ? '远端较新'
          : '存在冲突'
  return `${syncStatusDetail(status)}\n\n判断结果：${stateText}`
}

function emitWebdavSyncProgress(progress: WebdavSyncProgress): void {
  mainWindow?.webContents.send(IPC_CHANNELS.webdavSyncProgress, progress)
}

async function prepareWebdavSync(rawProject: unknown): Promise<{
  project: Project
  activeRoot: string
  client: WebdavClient
  snapshot: Awaited<ReturnType<typeof createLocalSnapshot>>
  remote: Awaited<ReturnType<WebdavClient['readRemoteIndex']>>
  status: WebdavSyncStatus
}> {
  if (!storage.activeRoot) throw new Error('请先打开一个项目')
  const activeRoot = storage.activeRoot
  const incomingProject = ProjectSchema.parse(rawProject)
  const project = storage.activeProject
    && storage.activeProject.id === incomingProject.id
    && storage.activeProject.revision >= incomingProject.revision
    ? storage.activeProject
    : await storage.save(incomingProject)
  const config = await settingsStorage.readWebdavConfig()
  const client = new WebdavClient(config)
  const snapshot = await createLocalSnapshot(project, activeRoot, app.getVersion(), await getDeviceId())
  const remote = await client.readRemoteIndex(project.id)
  const status = compareSyncState(snapshot, remote)
  return { project, activeRoot, client, snapshot, remote, status }
}

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
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
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

  ipcMain.handle(IPC_CHANNELS.saveWorkspaceState, (_event, rawPaths: unknown, rawActivePath: unknown) => {
    if (!Array.isArray(rawPaths) || !rawPaths.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error('项目标签状态无效')
    }
    if (rawActivePath !== null && (typeof rawActivePath !== 'string' || rawActivePath.length === 0)) {
      throw new Error('当前项目状态无效')
    }
    return settingsStorage.saveWorkspaceState(rawPaths, rawActivePath)
  })

  ipcMain.handle(IPC_CHANNELS.createProject, async (_event, rawName: unknown) => {
    if (typeof rawName !== 'string') throw new Error('项目名称无效')
    const settings = await settingsStorage.read()
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择项目保存位置',
      defaultPath: settings.lastProjectParentDirectory && existsSync(settings.lastProjectParentDirectory)
        ? settings.lastProjectParentDirectory
        : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    await settingsStorage.rememberProjectParentDirectory(selection.filePaths[0])
    const session = await storage.create(selection.filePaths[0], rawName, app.getVersion())
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.openProject, async () => {
    const settings = await settingsStorage.read()
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '打开本地项目',
      defaultPath: settings.lastOpenProjectDirectory && existsSync(settings.lastOpenProjectDirectory)
        ? settings.lastOpenProjectDirectory
        : undefined,
      properties: ['openDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const session = await storage.open(selection.filePaths[0])
    await settingsStorage.rememberOpenProjectDirectory(selection.filePaths[0])
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.openRecentProject, async (_event, rawRootPath: unknown) => {
    if (typeof rawRootPath !== 'string' || !(await settingsStorage.isRecentProject(rawRootPath))) {
      throw new Error('最近项目路径无效')
    }
    const session = await storage.open(rawRootPath)
    await settingsStorage.rememberProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.closeCurrentProject, async () => {
    await storage.close()
  })

  ipcMain.handle(IPC_CHANNELS.checkRecentProject, (_event, rawRootPath: unknown) => (
    typeof rawRootPath === 'string' && existsSync(path.join(rawRootPath, 'project.json'))
  ))

  ipcMain.handle(IPC_CHANNELS.removeRecentProject, async (_event, rawRootPath: unknown) => {
    if (typeof rawRootPath !== 'string') throw new Error('最近项目路径无效')
    return settingsStorage.forgetProject(rawRootPath)
  })

  ipcMain.handle(IPC_CHANNELS.saveProject, async (_event, rawProject: unknown) => {
    const previousRootPath = storage.activeRoot
    const project = await storage.save(ProjectSchema.parse(rawProject))
    if (storage.activeRoot) {
      const session = { project, rootPath: storage.activeRoot, readOnly: false }
      if (previousRootPath && previousRootPath !== storage.activeRoot) {
        await settingsStorage.replaceProjectPath(previousRootPath, session)
      } else {
        await settingsStorage.rememberProject(session)
      }
    }
    return { project, rootPath: storage.activeRoot! }
  })

  ipcMain.handle(IPC_CHANNELS.importAttachments, async (_event, rawKind: unknown) => {
    if (rawKind !== 'invoice' && rawKind !== 'payment' && rawKind !== 'other') throw new Error('附件类型无效')
    const kind = rawKind as AttachmentKind
    const settings = await settingsStorage.read()
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'invoice' ? '选择发票' : kind === 'payment' ? '选择支付截图' : '选择其他附件',
      defaultPath: (() => {
        const directoryPath = settings.lastImportDirectories[kind]
        return directoryPath && existsSync(directoryPath) ? directoryPath : undefined
      })(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '支持的附件', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (selection.canceled) return []
    if (selection.filePaths[0]) await settingsStorage.rememberImportDirectory(kind, path.dirname(selection.filePaths[0]))
    return storage.importFiles(kind, selection.filePaths)
  })

  ipcMain.handle(IPC_CHANNELS.importDroppedAttachments, async (_event, rawKind: unknown, rawPaths: unknown) => {
    if (rawKind !== 'invoice' && rawKind !== 'payment' && rawKind !== 'other') throw new Error('附件类型无效')
    if (!Array.isArray(rawPaths) || !rawPaths.every((filePath) => typeof filePath === 'string' && path.isAbsolute(filePath))) {
      throw new Error('拖入的文件路径无效')
    }
    const kind = rawKind as AttachmentKind
    const sourcePaths = [...new Set(rawPaths as string[])]
    if (!sourcePaths.length) return []
    await settingsStorage.rememberImportDirectory(kind, path.dirname(sourcePaths[0]))
    return storage.importFiles(kind, sourcePaths)
  })

  ipcMain.handle(IPC_CHANNELS.readAttachmentForOcr, async (_event, attachmentId: unknown) => {
    if (typeof attachmentId !== 'string') throw new Error('附件标识无效')
    const attachment = storage.activeProject?.attachments.find((item) => item.id === attachmentId)
    if (!attachment || attachment.kind !== 'invoice') throw new Error('OCR 仅支持发票附件')
    if (attachment.size > 50 * 1024 * 1024) throw new Error('附件超过 50 MB，无法识别')
    const file = await readFile(storage.getAttachmentPath(attachmentId))
    const data = Uint8Array.from(file).buffer
    return { mimeType: attachment.mimeType, data }
  })

  ipcMain.handle(IPC_CHANNELS.deleteCurrentProject, async () => {
    const rootPath = storage.activeRoot
    if (!rootPath) throw new Error('没有活动项目')
    await storage.close()
    await shell.trashItem(rootPath)
    return settingsStorage.forgetProject(rootPath)
  })

  ipcMain.handle(IPC_CHANNELS.moveCurrentProject, async () => {
    const oldRootPath = storage.activeRoot
    if (!oldRootPath) throw new Error('没有活动项目')
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择项目的新位置',
      buttonLabel: '移动到这里',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const session = await storage.moveTo(selection.filePaths[0])
    const settings = await settingsStorage.replaceProjectPath(oldRootPath, session)
    return { session, settings }
  })

  ipcMain.handle(IPC_CHANNELS.getAllProjectsSummary, async (_event, rawCurrentProject: unknown) => {
    const settings = await settingsStorage.read()
    const currentProject = rawCurrentProject === undefined ? null : ProjectSchema.parse(rawCurrentProject)
    const activeRoot = storage.activeRoot
    const projects: ProjectFundsSummary[] = []
    const categoryTotals = new Map<string, number>()
    const payerTotals = new Map<string, { totalCents: number; reimbursedCents: number; unreimbursedCents: number }>()
    for (const rootPath of [...new Set(settings.knownProjectPaths)]) {
      try {
        const project = currentProject && activeRoot === rootPath
          ? currentProject
          : ProjectSchema.parse(JSON.parse(await readFile(path.join(rootPath, 'project.json'), 'utf8')))
        const summary = calculateProjectSummary(project)
        for (const category of summary.categories) {
          categoryTotals.set(category.categoryName, (categoryTotals.get(category.categoryName) ?? 0) + category.totalCents)
        }
        for (const expense of project.expenses) {
          const payerName = expense.actualPayer.trim() || '未设置付款人'
          const totalCents = expense.priceCents + expense.taxCents
          const payer = payerTotals.get(payerName) ?? { totalCents: 0, reimbursedCents: 0, unreimbursedCents: 0 }
          payer.totalCents += totalCents
          if (expense.reimbursed) payer.reimbursedCents += totalCents
          else payer.unreimbursedCents += totalCents
          payerTotals.set(payerName, payer)
        }
        projects.push({
          name: project.name,
          rootPath,
          expenseCount: project.expenses.length,
          totalCents: summary.totalCents,
          actualPaymentCents: summary.actualPaymentCents,
          invoicedCents: summary.invoicedCents,
          uninvoicedCents: summary.uninvoicedCents,
          reimbursedCents: summary.reimbursedCents,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      projects,
      categories: [...categoryTotals.entries()]
        .map(([categoryName, totalCents]) => ({ categoryName, totalCents }))
        .filter((item) => item.totalCents > 0)
        .sort((left, right) => right.totalCents - left.totalCents),
      payers: [...payerTotals.entries()]
        .map(([payerName, totals]) => ({ payerName, ...totals }))
        .sort((left, right) => right.unreimbursedCents - left.unreimbursedCents),
      totalCents: projects.reduce((sum, item) => sum + item.totalCents, 0),
      actualPaymentCents: projects.reduce((sum, item) => sum + item.actualPaymentCents, 0),
      invoicedCents: projects.reduce((sum, item) => sum + item.invoicedCents, 0),
      uninvoicedCents: projects.reduce((sum, item) => sum + item.uninvoicedCents, 0),
      reimbursedCents: projects.reduce((sum, item) => sum + item.reimbursedCents, 0),
    }
  })

  ipcMain.handle(IPC_CHANNELS.readAttachmentPreview, async (_event, attachmentId: unknown) => {
    if (typeof attachmentId !== 'string') throw new Error('附件标识无效')
    const attachment = storage.activeProject?.attachments.find((item) => item.id === attachmentId)
    if (!attachment) throw new Error('附件不存在')
    if (attachment.size > 100 * 1024 * 1024) throw new Error('附件超过 100 MB，无法预览')
    const file = await readFile(storage.getAttachmentPath(attachmentId))
    return { mimeType: attachment.mimeType, data: Uint8Array.from(file).buffer }
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
    if (!storage.activeRoot) throw new Error('请先打开一个项目')
    const project = await storage.save(ProjectSchema.parse(rawProject))
    const options = rawOptions as ExportOptions
    if (typeof options?.includePayments !== 'boolean' || typeof options?.includeOtherAttachments !== 'boolean') {
      throw new Error('导出选项无效')
    }
    const settings = await settingsStorage.read()
    const suggestedFileName = `${project.name}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '选择导出位置',
      buttonLabel: '导出',
      defaultPath: path.join(
        settings.lastExportDirectory && existsSync(settings.lastExportDirectory)
          ? settings.lastExportDirectory
          : app.getPath('documents'),
        suggestedFileName,
      ),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    })
    if (selection.canceled || !selection.filePath) return null
    await settingsStorage.rememberExportDirectory(path.dirname(selection.filePath))
    await exportProject(project, storage.activeRoot, selection.filePath, path.join(app.getPath('temp'), 'InvoiceManager'), options)
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: '导出完成',
      message: '项目压缩包已成功导出',
      detail: selection.filePath,
      buttons: ['打开所在文件夹', '关闭'],
      defaultId: 0,
      cancelId: 1,
    })
    if (confirmation.response === 0) {
      const error = await shell.openPath(path.dirname(selection.filePath))
      if (error) throw new Error(`无法打开导出目录：${error}`)
    }
    return { filePath: selection.filePath, project }
  })

  ipcMain.handle(IPC_CHANNELS.importSyncPackage, async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '从文件导入项目',
      properties: ['openFile'],
      filters: [{ name: '项目同步包', extensions: ['zip'] }],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const zipPath = selection.filePaths[0]
    const packageData = await validateSyncPackageZip(zipPath)
    const summary = packageData.summary
    const detail = [
      `项目名称：${summary.projectName}`,
      `revision：${summary.revision}`,
      `更新时间：${summary.updatedAt}`,
      `明细数量：${summary.expenseCount}`,
      `发票数量：${summary.invoiceAttachmentCount}`,
      `付款截图数量：${summary.paymentAttachmentCount}`,
      `其他附件数量：${summary.otherAttachmentCount}`,
    ].join('\n')
    const existingRoot = await findKnownProjectById(summary.projectId)
    const confirmation = await dialog.showMessageBox(mainWindow!, existingRoot ? {
      type: 'question',
      title: '导入项目同步包',
      message: '检测到相同 projectId 的项目',
      detail,
      buttons: ['覆盖现有项目', '导入为副本', '取消'],
      defaultId: 1,
      cancelId: 2,
    } : {
      type: 'question',
      title: '导入项目同步包',
      message: '确认导入以下项目？',
      detail,
      buttons: ['导入项目', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if ((!existingRoot && confirmation.response !== 0) || (existingRoot && confirmation.response === 2)) return null
    const mode = existingRoot
      ? confirmation.response === 0 ? 'overwrite' : 'copy'
      : 'new'
    let targetRootPath = existingRoot && mode === 'overwrite' ? existingRoot : ''
    if (!targetRootPath) {
      const settings = await settingsStorage.read()
      const parentSelection = await dialog.showOpenDialog(mainWindow!, {
        title: '选择项目保存位置',
        defaultPath: settings.lastProjectParentDirectory && existsSync(settings.lastProjectParentDirectory)
          ? settings.lastProjectParentDirectory
          : app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (parentSelection.canceled || !parentSelection.filePaths[0]) return null
      await settingsStorage.rememberProjectParentDirectory(parentSelection.filePaths[0])
      targetRootPath = uniqueProjectRoot(parentSelection.filePaths[0], mode === 'copy' ? `${summary.projectName} 副本` : summary.projectName)
    }
    if (storage.activeRoot && path.resolve(storage.activeRoot).toLowerCase() === path.resolve(targetRootPath).toLowerCase()) {
      await storage.close()
    }
    const installed = await installSyncPackage({
      zipPath,
      targetRootPath,
      tempParentDirectory: path.join(app.getPath('temp'), 'InvoiceManager'),
      mode,
    })
    const session = await storage.open(installed.rootPath)
    const settings = await settingsStorage.rememberProject(session)
    return { session, settings, summary: summarizeProject(session.project), mode, backupPath: installed.backupPath }
  })

  ipcMain.handle(IPC_CHANNELS.exportSyncPackage, async (_event, rawProject: unknown) => {
    if (!storage.activeRoot) throw new Error('请先打开一个项目')
    const incomingProject = ProjectSchema.parse(rawProject)
    const project = storage.activeProject
      && storage.activeProject.id === incomingProject.id
      && storage.activeProject.revision >= incomingProject.revision
      ? storage.activeProject
      : await storage.save(incomingProject)
    const settings = await settingsStorage.read()
    const suggestedFileName = safePackageFileName(project.name)
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出项目同步包',
      buttonLabel: '导出',
      defaultPath: path.join(
        settings.lastExportDirectory && existsSync(settings.lastExportDirectory)
          ? settings.lastExportDirectory
          : app.getPath('documents'),
        suggestedFileName,
      ),
      filters: [{ name: '项目同步包', extensions: ['zip'] }],
    })
    if (selection.canceled || !selection.filePath) return null
    await settingsStorage.rememberExportDirectory(path.dirname(selection.filePath))
    const destinationPath = selection.filePath.endsWith('-invoice-sync.zip')
      ? selection.filePath
      : selection.filePath.replace(/\.zip$/i, '') + '-invoice-sync.zip'
    const snapshot = await createSyncSnapshot(project, storage.activeRoot, app.getVersion(), await getDeviceId())
    await writeSyncPackageZip(snapshot, destinationPath, path.join(app.getPath('temp'), 'InvoiceManager'))
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: '同步包导出完成',
      message: '项目同步包已成功导出',
      detail: destinationPath,
      buttons: ['打开所在文件夹', '关闭'],
      defaultId: 0,
      cancelId: 1,
    })
    if (confirmation.response === 0) {
      const error = await shell.openPath(path.dirname(destinationPath))
      if (error) throw new Error(`无法打开导出目录：${error}`)
    }
    return { filePath: destinationPath, project }
  })

  ipcMain.handle(IPC_CHANNELS.testWebdavConnection, async (_event, rawOverride: unknown) => {
    const config = await settingsStorage.readWebdavConfig(rawOverride && typeof rawOverride === 'object' ? rawOverride as any : undefined)
    try {
      const client = new WebdavClient(config)
      await client.testConnection()
      return { ok: true, message: '连接成功，远程目录可访问' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.getWebdavSyncStatus, async (_event, rawProject: unknown) => {
    const { status } = await prepareWebdavSync(rawProject)
    return { status }
  })

  ipcMain.handle(IPC_CHANNELS.uploadCurrentProjectWebdav, async (_event, rawProject: unknown, rawForce: unknown) => {
    const { project, client, snapshot, status } = await prepareWebdavSync(rawProject)
    const force = rawForce === true
    if (!force && (status.state === 'remote-newer' || status.conflict)) {
      throw new Error('远端较新或存在冲突，需要确认后才能上传')
    }
    await client.uploadSnapshot(snapshot, emitWebdavSyncProgress)
    const nextRemote = await client.readRemoteIndex(project.id)
    return { action: 'upload', status: compareSyncState(snapshot, nextRemote) }
  })

  ipcMain.handle(IPC_CHANNELS.downloadCurrentProjectWebdav, async (_event, rawProject: unknown, rawForce: unknown) => {
    const { project, activeRoot, client, remote, status } = await prepareWebdavSync(rawProject)
    const force = rawForce === true
    if (!remote) throw new Error('远端项目不存在，无法下载')
    if (!force && (status.state === 'local-newer' || status.conflict)) {
      throw new Error('本地较新或存在冲突，需要确认后才能下载')
    }
    const zipPath = await client.downloadProjectToZip(project.id, path.join(app.getPath('temp'), 'InvoiceManager'), emitWebdavSyncProgress)
    await storage.close()
    try {
      emitWebdavSyncProgress({ action: 'download', phase: 'install', current: 1, total: 1, message: '正在备份并覆盖本地项目' })
      await installSyncPackage({
        zipPath,
        targetRootPath: activeRoot,
        tempParentDirectory: path.join(app.getPath('temp'), 'InvoiceManager'),
        mode: 'overwrite',
      })
    } finally {
      await rm(zipPath, { force: true })
    }
    const session = await storage.open(activeRoot)
    emitWebdavSyncProgress({ action: 'download', phase: 'reopen', current: 1, total: 1, message: '正在重新打开项目' })
    const settings = await settingsStorage.rememberProject(session)
    const nextSnapshot = await createLocalSnapshot(session.project, session.rootPath, app.getVersion(), await getDeviceId())
    const nextRemote = await client.readRemoteIndex(session.project.id)
    return { action: 'download', status: compareSyncState(nextSnapshot, nextRemote), session, settings }
  })

  ipcMain.handle(IPC_CHANNELS.syncCurrentProjectWebdav, async (_event, rawProject: unknown) => {
    if (!storage.activeRoot) throw new Error('请先打开一个项目')
    const incomingProject = ProjectSchema.parse(rawProject)
    const project = storage.activeProject
      && storage.activeProject.id === incomingProject.id
      && storage.activeProject.revision >= incomingProject.revision
      ? storage.activeProject
      : await storage.save(incomingProject)
    const config = await settingsStorage.readWebdavConfig()
    const client = new WebdavClient(config)
    const snapshot = await createLocalSnapshot(project, storage.activeRoot, app.getVersion(), await getDeviceId())
    const remote = await client.readRemoteIndex(project.id)
    const status = compareSyncState(snapshot, remote)
    const buttons = status.state === 'latest'
      ? ['关闭']
      : status.state === 'remote-missing'
        ? ['上传当前项目到坚果云', '取消']
        : ['上传当前项目到坚果云', '从坚果云下载到当前项目', '取消']
    const response = await dialog.showMessageBox(mainWindow!, {
      type: status.conflict ? 'warning' : 'question',
      title: '与坚果云同步',
      message: '同步前请确认本地与远端状态',
      detail: formatSyncStatus(status),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    })
    if (status.state === 'latest' || response.response === buttons.length - 1) return { action: 'none', status }
    if (response.response === 0) {
      if ((status.state === 'remote-newer' || status.conflict) && (await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '确认上传',
        message: '远端较新或存在冲突，上传会以当前项目替换远端正式版本。',
        buttons: ['继续上传', '取消'],
        defaultId: 1,
        cancelId: 1,
      })).response !== 0) return { action: 'none', status }
      await client.uploadSnapshot(snapshot)
      const nextRemote = await client.readRemoteIndex(project.id)
      return { action: 'upload', status: compareSyncState(snapshot, nextRemote) }
    }
    if (!remote) throw new Error('远端项目不存在，无法下载')
    if ((status.state === 'local-newer' || status.conflict) && (await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: '确认下载',
      message: '本地较新或存在冲突，下载会自动备份后覆盖当前项目。',
      buttons: ['继续下载', '取消'],
      defaultId: 1,
      cancelId: 1,
    })).response !== 0) return { action: 'none', status }
    const zipPath = await client.downloadProjectToZip(project.id, path.join(app.getPath('temp'), 'InvoiceManager'))
    const targetRootPath = storage.activeRoot
    if (!targetRootPath) throw new Error('当前项目路径无效')
    await storage.close()
    try {
      await installSyncPackage({
        zipPath,
        targetRootPath,
        tempParentDirectory: path.join(app.getPath('temp'), 'InvoiceManager'),
        mode: 'overwrite',
      })
    } finally {
      await rm(zipPath, { force: true })
    }
    const session = await storage.open(targetRootPath)
    const settings = await settingsStorage.rememberProject(session)
    const nextSnapshot = await createLocalSnapshot(session.project, session.rootPath, app.getVersion(), await getDeviceId())
    const nextRemote = await client.readRemoteIndex(session.project.id)
    return { action: 'download', status: compareSyncState(nextSnapshot, nextRemote), session, settings }
  })

  // 新增：获取付款人使用统计
  ipcMain.handle(IPC_CHANNELS.getPayerUsage, async () => {
    const settings = await settingsStorage.read()
    const projectPaths = [...new Set([
      ...settings.knownProjectPaths,
      ...settings.recentProjects.map((project) => project.rootPath),
    ])]
    const usage = new Map<string, PayerUsage>()
    for (const payerName of settings.payerNames) {
      usage.set(payerName, { payerName, projectCount: 0, expenseCount: 0 })
    }
    for (const rootPath of projectPaths) {
      try {
        const project = ProjectSchema.parse(JSON.parse(await readFile(path.join(rootPath, 'project.json'), 'utf8')))
        for (const expense of project.expenses) {
          const payerName = expense.actualPayer.trim() || '未设置付款人'
          const entry = usage.get(payerName)
          if (entry) {
            entry.expenseCount += 1
          }
        }
        for (const payerName of usage.keys()) {
          if (project.expenses.some((expense) => (expense.actualPayer.trim() || '未设置付款人') === payerName)) {
            const entry = usage.get(payerName)!
            entry.projectCount += 1
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return Array.from(usage.values()).filter((u) => u.projectCount > 0 || u.expenseCount > 0)
  })

  // 新增：选择设置目录
  ipcMain.handle(IPC_CHANNELS.chooseSettingsDirectory, async (_event, rawKind: unknown) => {
    const validKinds: SettingsDirectoryKind[] = ['projectParent', 'openProject', 'invoiceImport', 'paymentImport', 'otherImport', 'export']
    if (typeof rawKind !== 'string' || !validKinds.includes(rawKind as SettingsDirectoryKind)) {
      throw new Error('目录类型无效')
    }
    const kind = rawKind as SettingsDirectoryKind
    const settings = await settingsStorage.read()

    let defaultPath: string | undefined
    let title = '选择目录'

    switch (kind) {
      case 'projectParent':
        title = '选择新建项目的默认父目录'
        defaultPath = settings.lastProjectParentDirectory && existsSync(settings.lastProjectParentDirectory)
          ? settings.lastProjectParentDirectory
          : undefined
        break
      case 'openProject':
        title = '选择打开项目的默认目录'
        defaultPath = settings.lastOpenProjectDirectory && existsSync(settings.lastOpenProjectDirectory)
          ? settings.lastOpenProjectDirectory
          : undefined
        break
      case 'invoiceImport':
        title = '选择发票导入默认目录'
        defaultPath = settings.lastImportDirectories.invoice && existsSync(settings.lastImportDirectories.invoice)
          ? settings.lastImportDirectories.invoice
          : undefined
        break
      case 'paymentImport':
        title = '选择支付截图导入默认目录'
        defaultPath = settings.lastImportDirectories.payment && existsSync(settings.lastImportDirectories.payment)
          ? settings.lastImportDirectories.payment
          : undefined
        break
      case 'otherImport':
        title = '选择其他附件导入默认目录'
        defaultPath = settings.lastImportDirectories.other && existsSync(settings.lastImportDirectories.other)
          ? settings.lastImportDirectories.other
          : undefined
        break
      case 'export':
        title = '选择导出默认目录'
        defaultPath = settings.lastExportDirectory && existsSync(settings.lastExportDirectory)
          ? settings.lastExportDirectory
          : app.getPath('documents')
        break
    }

    const selection = await dialog.showOpenDialog(mainWindow!, {
      title,
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })

    if (selection.canceled || !selection.filePaths[0]) return null
    return selection.filePaths[0]
  })

  // 新增：检查设置目录状态
  ipcMain.handle(IPC_CHANNELS.checkSettingsDirectories, async () => {
    const settings = await settingsStorage.read()
    const validKinds: SettingsDirectoryKind[] = ['projectParent', 'openProject', 'invoiceImport', 'paymentImport', 'otherImport', 'export']
    const result: DirectoryStatus = {} as DirectoryStatus

    for (const kind of validKinds) {
      result[kind] = null
    }

    if (settings.lastProjectParentDirectory) {
      result.projectParent = existsSync(settings.lastProjectParentDirectory)
    }
    if (settings.lastOpenProjectDirectory) {
      result.openProject = existsSync(settings.lastOpenProjectDirectory)
    }
    if (settings.lastExportDirectory) {
      result.export = existsSync(settings.lastExportDirectory)
    }
    if (settings.lastImportDirectories.invoice) {
      result.invoiceImport = existsSync(settings.lastImportDirectories.invoice)
    }
    if (settings.lastImportDirectories.payment) {
      result.paymentImport = existsSync(settings.lastImportDirectories.payment)
    }
    if (settings.lastImportDirectories.other) {
      result.otherImport = existsSync(settings.lastImportDirectories.other)
    }

    return result
  })

  // 新增：获取最近项目状态
  ipcMain.handle(IPC_CHANNELS.getRecentProjectStatuses, async () => {
    const settings = await settingsStorage.read()
    const result: RecentProjectStatus[] = []

    for (const recent of settings.recentProjects) {
      const available = existsSync(path.join(recent.rootPath, 'project.json'))
      result.push({ ...recent, available })
    }

    return result
  })

  // 新增：移除无效最近项目
  ipcMain.handle(IPC_CHANNELS.removeInvalidRecentProjects, async () => {
    return await settingsStorage.removeInvalidRecentProjects()
  })

  // 新增：重新定位最近项目
  ipcMain.handle(IPC_CHANNELS.relocateRecentProject, async (_event, oldRootPath: unknown) => {
    if (typeof oldRootPath !== 'string') throw new Error('旧项目路径无效')

    const settings = await settingsStorage.read()
    const oldRecord = settings.recentProjects.find((p) => p.rootPath === oldRootPath)
    if (!oldRecord) throw new Error('项目不存在于最近记录中')

    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择项目的新位置',
      properties: ['openDirectory'],
    })

    if (selection.canceled || !selection.filePaths[0]) return null

    const newRootPath = selection.filePaths[0]
    const projectPath = path.join(newRootPath, 'project.json')

    if (!existsSync(projectPath)) {
      throw new Error('所选目录不是有效的项目目录')
    }

    const project = ProjectSchema.parse(JSON.parse(await readFile(projectPath, 'utf8')))

    // 如果旧路径可读，比较项目 ID
    try {
      const oldProject = ProjectSchema.parse(JSON.parse(await readFile(path.join(oldRootPath, 'project.json'), 'utf8')))
      if (oldProject.id !== project.id) {
        throw new Error('所选项目与原项目不匹配')
      }
    } catch {
      // 旧路径不可读，要求用户确认
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '项目不匹配',
        message: '无法读取原项目，所选项目将替换该记录',
        buttons: ['继续', '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      if (confirmation.response === 1) return null
    }

    // 使用新的公共方法更新记录
    return await settingsStorage.relocateRecentProject(oldRootPath, newRootPath, project)
  })

  // 新增：获取应用诊断信息
  ipcMain.handle(IPC_CHANNELS.getAppDiagnostics, async () => {
    const userDataPath = app.getPath('userData')
    const ocrModelPath = path.join(rendererRoot(), 'ocr')
    const modelConfigPath = path.join(ocrModelPath, 'model-config.json')
    const checksumsPath = path.join(ocrModelPath, 'checksums.json')

    let ocrModelReady = false
    try {
      ocrModelReady = [
        modelConfigPath,
        checksumsPath,
        path.join(ocrModelPath, 'text-detection.onnx'),
        path.join(ocrModelPath, 'text-recognition.onnx'),
      ].every(existsSync)
    } catch {
      ocrModelReady = false
    }

    return {
      productName: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      userDataPath,
      ocrModelReady,
    } as AppDiagnostics
  })

  // 新增：打开应用数据目录
  ipcMain.handle(IPC_CHANNELS.openAppDataDirectory, async () => {
    const userDataPath = app.getPath('userData')
    const error = await shell.openPath(userDataPath)
    if (error) throw new Error(error)
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
