import { copyFile, open, readFile, rename, rm, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  AppSettingsSchema,
  AppSettingsUpdateSchema,
  ProjectSchema,
  type AppSettings,
  type AttachmentKind,
  type Project,
  type ProjectSession,
} from '../src/shared/models'

const MAX_RECENT_PROJECTS = 10

export class AppSettingsStorage {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    try {
      return AppSettingsSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      try {
        return AppSettingsSchema.parse(JSON.parse(await readFile(`${this.filePath}.bak`, 'utf8')))
      } catch {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return AppSettingsSchema.parse({})
        throw error
      }
    }
  }

  async saveSettings(rawUpdate: unknown): Promise<AppSettings> {
    const settings = await this.read()
    const update = AppSettingsUpdateSchema.parse(rawUpdate)

    // 比较被移除的付款人并执行 assertPayersUnused()
    const removedPayerNames = settings.payerNames.filter((payerName) => !update.payerNames.includes(payerName))
    if (removedPayerNames.length > 0) await this.assertPayersUnused(settings, removedPayerNames)

    // 更新允许由用户修改的字段
    settings.payerNames = update.payerNames
    if (update.defaultViewMode !== undefined) settings.defaultViewMode = update.defaultViewMode
    if (update.defaultIncludePayments !== undefined) settings.defaultIncludePayments = update.defaultIncludePayments
    if (update.defaultIncludeOtherAttachments !== undefined) settings.defaultIncludeOtherAttachments = update.defaultIncludeOtherAttachments
    if (update.showProjectHistoryOnStartup !== undefined) settings.showProjectHistoryOnStartup = update.showProjectHistoryOnStartup
    if (update.autoOpenLastProject !== undefined) settings.autoOpenLastProject = update.autoOpenLastProject
    if (update.showSuccessMessages !== undefined) settings.showSuccessMessages = update.showSuccessMessages

    // 将路径载荷中的 null 转换为删除属性
    if (update.lastProjectParentDirectory === null) {
      delete settings.lastProjectParentDirectory
    } else if (update.lastProjectParentDirectory !== undefined) {
      settings.lastProjectParentDirectory = update.lastProjectParentDirectory
    }

    if (update.lastOpenProjectDirectory === null) {
      delete settings.lastOpenProjectDirectory
    } else if (update.lastOpenProjectDirectory !== undefined) {
      settings.lastOpenProjectDirectory = update.lastOpenProjectDirectory
    }

    if (update.lastExportDirectory === null) {
      delete settings.lastExportDirectory
    } else if (update.lastExportDirectory !== undefined) {
      settings.lastExportDirectory = update.lastExportDirectory
    }

    // 处理导入目录
    if (update.lastImportDirectories?.invoice === null) {
      delete settings.lastImportDirectories.invoice
    } else if (update.lastImportDirectories?.invoice !== undefined) {
      settings.lastImportDirectories.invoice = update.lastImportDirectories.invoice
    }

    if (update.lastImportDirectories?.payment === null) {
      delete settings.lastImportDirectories.payment
    } else if (update.lastImportDirectories?.payment !== undefined) {
      settings.lastImportDirectories.payment = update.lastImportDirectories.payment
    }

    if (update.lastImportDirectories?.other === null) {
      delete settings.lastImportDirectories.other
    } else if (update.lastImportDirectories?.other !== undefined) {
      settings.lastImportDirectories.other = update.lastImportDirectories.other
    }

    // 使用现有临时文件、sync()、重命名和 .bak 流程写入
    await this.write(settings)

    // 返回完整的 AppSettings
    return settings
  }

  async saveWorkspaceState(openProjectPaths: string[], activeProjectPath: string | null): Promise<AppSettings> {
    const settings = await this.read()
    settings.lastOpenProjectPaths = [...new Set(openProjectPaths)].slice(0, MAX_RECENT_PROJECTS)
    if (activeProjectPath && settings.lastOpenProjectPaths.includes(activeProjectPath)) {
      settings.lastActiveProjectPath = activeProjectPath
    } else {
      delete settings.lastActiveProjectPath
    }
    await this.write(settings)
    return settings
  }

  async rememberProject(session: ProjectSession): Promise<AppSettings> {
    const settings = await this.read()
    settings.recentProjects = [
      {
        name: session.project.name,
        rootPath: session.rootPath,
        lastOpenedAt: new Date().toISOString(),
      },
      ...settings.recentProjects.filter((item) => item.rootPath !== session.rootPath),
    ].slice(0, MAX_RECENT_PROJECTS)
    settings.knownProjectPaths = [
      session.rootPath,
      ...settings.knownProjectPaths.filter((rootPath) => rootPath !== session.rootPath),
    ]
    await this.write(settings)
    return settings
  }

  async isRecentProject(rootPath: string): Promise<boolean> {
    return (await this.read()).recentProjects.some((item) => item.rootPath === rootPath)
  }

  async forgetProject(rootPath: string): Promise<AppSettings> {
    const settings = await this.read()
    settings.recentProjects = settings.recentProjects.filter((item) => item.rootPath !== rootPath)
    settings.knownProjectPaths = settings.knownProjectPaths.filter((item) => item !== rootPath)
    await this.write(settings)
    return settings
  }

  async replaceProjectPath(oldRootPath: string, session: ProjectSession): Promise<AppSettings> {
    const settings = await this.read()
    settings.recentProjects = settings.recentProjects.filter((item) => item.rootPath !== oldRootPath && item.rootPath !== session.rootPath)
    settings.recentProjects.unshift({
      name: session.project.name,
      rootPath: session.rootPath,
      lastOpenedAt: new Date().toISOString(),
    })
    settings.recentProjects = settings.recentProjects.slice(0, MAX_RECENT_PROJECTS)
    settings.knownProjectPaths = [
      session.rootPath,
      ...settings.knownProjectPaths.filter((item) => item !== oldRootPath && item !== session.rootPath),
    ]
    await this.write(settings)
    return settings
  }

  async rememberImportDirectory(kind: AttachmentKind, directoryPath: string): Promise<AppSettings> {
    const settings = await this.read()
    settings.lastImportDirectories[kind] = directoryPath
    await this.write(settings)
    return settings
  }

  async rememberProjectParentDirectory(directoryPath: string): Promise<AppSettings> {
    const settings = await this.read()
    settings.lastProjectParentDirectory = directoryPath
    await this.write(settings)
    return settings
  }

  async rememberOpenProjectDirectory(directoryPath: string): Promise<AppSettings> {
    const settings = await this.read()
    settings.lastOpenProjectDirectory = directoryPath
    await this.write(settings)
    return settings
  }

  async rememberExportDirectory(directoryPath: string): Promise<AppSettings> {
    const settings = await this.read()
    settings.lastExportDirectory = directoryPath
    await this.write(settings)
    return settings
  }

  async removeInvalidRecentProjects(): Promise<AppSettings> {
    const settings = await this.read()
    const validRecent = []
    const validPaths = new Set<string>()

    for (const recent of settings.recentProjects) {
      try {
        ProjectSchema.parse(JSON.parse(await readFile(path.join(recent.rootPath, 'project.json'), 'utf8')))
        validRecent.push(recent)
        validPaths.add(recent.rootPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    settings.recentProjects = validRecent
    const validKnownPaths = [...validPaths]
    for (const rootPath of settings.knownProjectPaths) {
      if (validPaths.has(rootPath)) continue
      try {
        ProjectSchema.parse(JSON.parse(await readFile(path.join(rootPath, 'project.json'), 'utf8')))
        validKnownPaths.push(rootPath)
      } catch {
        continue
      }
    }
    settings.knownProjectPaths = validKnownPaths
    await this.write(settings)
    return settings
  }

  async relocateRecentProject(oldRootPath: string, newRootPath: string, project: Project): Promise<AppSettings> {
    const settings = await this.read()
    const oldRecord = settings.recentProjects.find((p) => p.rootPath === oldRootPath)
    if (!oldRecord) throw new Error('项目不存在于最近记录中')

    settings.recentProjects = settings.recentProjects.filter((p) => p.rootPath !== oldRootPath && p.rootPath !== newRootPath)
    settings.recentProjects.unshift({
      name: project.name,
      rootPath: newRootPath,
      lastOpenedAt: new Date().toISOString(),
    })
    settings.recentProjects = settings.recentProjects.slice(0, MAX_RECENT_PROJECTS)
    settings.knownProjectPaths = [
      newRootPath,
      ...settings.knownProjectPaths.filter((p) => p !== oldRootPath && p !== newRootPath),
    ]
    await this.write(settings)
    return settings
  }

  private async assertPayersUnused(settings: AppSettings, payerNames: string[]): Promise<void> {
    const projectPaths = [...new Set([
      ...settings.knownProjectPaths,
      ...settings.recentProjects.map((project) => project.rootPath),
    ])]
    for (const rootPath of projectPaths) {
      try {
        const project = ProjectSchema.parse(JSON.parse(await readFile(path.join(rootPath, 'project.json'), 'utf8')))
        const payerName = payerNames.find((name) => project.expenses.some((expense) => expense.actualPayer === name))
        if (payerName) throw new Error(`付款人“${payerName}”已被项目“${project.name}”使用，无法删除`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
  }

  private async write(settings: AppSettings): Promise<void> {
    const validatedSettings = AppSettingsSchema.parse(settings)
    const writeOperation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`
      try {
        const handle = await open(temporaryPath, 'wx')
        try {
          await handle.writeFile(`${JSON.stringify(validatedSettings, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await rename(temporaryPath, this.filePath)
        } catch {
          await rm(this.filePath, { force: true })
          await rename(temporaryPath, this.filePath)
        }
        await copyFile(this.filePath, `${this.filePath}.bak`)
      } finally {
        await rm(temporaryPath, { force: true })
      }
    })
    this.writeQueue = writeOperation.catch(() => undefined)
    return writeOperation
  }
}
