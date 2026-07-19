import { access, open, readFile, rename, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  AppSettingsSchema,
  AppSettingsUpdateSchema,
  ProjectSchema,
  type AppSettings,
  type AttachmentKind,
  type ProjectSession,
} from '../src/shared/models'

const MAX_RECENT_PROJECTS = 10

export class AppSettingsStorage {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    try {
      const settings = AppSettingsSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
      const validPaths = new Set<string>()
      await Promise.all([...new Set([
        ...settings.knownProjectPaths,
        ...settings.recentProjects.map((project) => project.rootPath),
      ])].map(async (rootPath) => {
        try {
          await access(path.join(rootPath, 'project.json'))
          validPaths.add(rootPath)
        } catch {
          // Projects moved or deleted outside the app are removed from history.
        }
      }))
      const recentProjects = settings.recentProjects.filter((project) => validPaths.has(project.rootPath))
      const knownProjectPaths = settings.knownProjectPaths.filter((rootPath) => validPaths.has(rootPath))
      if (recentProjects.length !== settings.recentProjects.length || knownProjectPaths.length !== settings.knownProjectPaths.length) {
        settings.recentProjects = recentProjects
        settings.knownProjectPaths = knownProjectPaths
        await this.write(settings)
      }
      return settings
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return AppSettingsSchema.parse({})
      throw error
    }
  }

  async saveSettings(rawUpdate: unknown): Promise<AppSettings> {
    const settings = await this.read()
    const update = AppSettingsUpdateSchema.parse(rawUpdate)
    const removedPayerNames = settings.payerNames.filter((payerName) => !update.payerNames.includes(payerName))
    if (removedPayerNames.length > 0) await this.assertPayersUnused(settings, removedPayerNames)
    settings.payerNames = update.payerNames
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
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    const handle = await open(temporaryPath, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(AppSettingsSchema.parse(settings), null, 2)}\n`, 'utf8')
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
  }
}
