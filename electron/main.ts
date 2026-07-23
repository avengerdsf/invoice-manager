import { mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { copyFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { AppSettingsStorage } from './app-settings'
import { exportProject } from './exporter'
import { ProjectStorage } from './project-storage'
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
