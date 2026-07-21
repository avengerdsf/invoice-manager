import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import type { Attachment, AttachmentKind, Project, ProjectSession } from '../src/shared/models'
import { ProjectSchema } from '../src/shared/models'
import { DEFAULT_CATEGORIES } from '../src/domain/project'

const PROJECT_FILE = 'project.json'
const LOCK_FILE = '.project.lock'
const MAX_BACKUPS = 20

interface LockData {
  pid: number
  hostname: string
  createdAt: string
}

function sanitizeProjectName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  if (!sanitized) {
    throw new Error('项目名称不能为空或只包含非法字符')
  }
  return sanitized
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function detectFile(filePath: string): Promise<{ extension: string; mimeType: string }> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const header = buffer.subarray(0, bytesRead)
    if (header.subarray(0, 5).toString() === '%PDF-') return { extension: '.pdf', mimeType: 'application/pdf' }
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { extension: '.jpg', mimeType: 'image/jpeg' }
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { extension: '.png', mimeType: 'image/png' }
    }
    if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') {
      return { extension: '.webp', mimeType: 'image/webp' }
    }
    throw new Error(`不支持的文件类型：${path.basename(filePath)}`)
  } finally {
    await handle.close()
  }
}

export class ProjectStorage {
  private rootPath: string | null = null
  private project: Project | null = null
  private readOnly = false
  private ownsLock = false

  get activeProject(): Project | null {
    return this.project
  }

  get activeRoot(): string | null {
    return this.rootPath
  }

  async create(parentDirectory: string, name: string, appVersion: string): Promise<ProjectSession> {
    await this.close()
    const projectName = sanitizeProjectName(name)
    const rootPath = path.join(parentDirectory, `${projectName}.invoice-project`)
    if (existsSync(rootPath)) {
      throw new Error(`项目目录已存在：${rootPath}`)
    }
    await this.createDirectories(rootPath)
    const now = new Date().toISOString()
    const project: Project = {
      schemaVersion: 1,
      appVersion,
      id: randomUUID(),
      name: projectName,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
      expenses: [],
      attachments: [],
      invoiceAllocations: [],
      paymentAllocations: [],
      otherAllocations: [],
    }
    this.rootPath = rootPath
    this.project = project
    this.readOnly = false
    await this.acquireLock(rootPath)
    await this.writeProjectFile(project, false)
    return this.session()
  }

  async open(rootPath: string): Promise<ProjectSession> {
    await this.close()
    const projectPath = path.join(rootPath, PROJECT_FILE)
    const parsed = ProjectSchema.parse(JSON.parse(await readFile(projectPath, 'utf8')))
    await this.createDirectories(rootPath)
    this.rootPath = rootPath
    this.project = parsed
    this.readOnly = !(await this.acquireLock(rootPath))
    return this.session()
  }

  async save(project: Project): Promise<Project> {
    if (!this.rootPath || !this.project) throw new Error('请先创建或打开项目')
    if (this.readOnly) throw new Error('项目当前以只读方式打开，无法保存')
    if (project.id !== this.project.id) throw new Error('保存数据与当前项目不一致')
    const snapshot = ProjectSchema.parse({
      ...project,
      revision: Math.max(project.revision, this.project.revision) + 1,
      updatedAt: new Date().toISOString(),
    })
    const previousRootPath = this.rootPath
    const shouldRenameDirectory = snapshot.name !== this.project.name
    const targetRootPath = shouldRenameDirectory
      ? path.join(path.dirname(previousRootPath), `${sanitizeProjectName(snapshot.name)}.invoice-project`)
      : previousRootPath
    const changesDirectory = path.resolve(targetRootPath).toLowerCase() !== path.resolve(previousRootPath).toLowerCase()
    if (changesDirectory && existsSync(targetRootPath)) {
      throw new Error(`目标位置已存在同名项目：${targetRootPath}`)
    }
    if (changesDirectory) {
      await rename(previousRootPath, targetRootPath)
      this.rootPath = targetRootPath
    }
    try {
      await this.writeProjectFile(snapshot, true)
    } catch (error) {
      if (changesDirectory && existsSync(targetRootPath) && !existsSync(previousRootPath)) {
        await rename(targetRootPath, previousRootPath)
        this.rootPath = previousRootPath
      }
      throw error
    }
    this.project = snapshot
    return snapshot
  }

  async importFiles(kind: AttachmentKind, sourcePaths: string[]): Promise<Attachment[]> {
    if (!this.rootPath || !this.project) throw new Error('请先创建或打开项目')
    if (this.readOnly) throw new Error('只读项目不能导入附件')
    const directoryName = kind === 'invoice' ? 'invoices' : kind === 'payment' ? 'payments' : 'others'
    const targetDirectory = path.join(this.rootPath, 'assets', directoryName)
    const imported: Attachment[] = []

    for (const sourcePath of sourcePaths) {
      const detected = await detectFile(sourcePath)
      const sha256 = await hashFile(sourcePath)
      const id = `${kind}-${sha256}`
      const fileName = `${sha256}${detected.extension}`
      const storedPath = path.posix.join('assets', directoryName, fileName)
      const targetPath = path.join(targetDirectory, fileName)
      if (!existsSync(targetPath)) {
        const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
        await copyFile(sourcePath, temporaryPath)
        try {
          await rename(temporaryPath, targetPath)
        } catch (error) {
          await rm(temporaryPath, { force: true })
          if (!existsSync(targetPath)) throw error
        }
      }
      const fileStat = await stat(targetPath)
      const attachment: Attachment = {
        id,
        kind,
        sha256,
        originalName: path.basename(sourcePath),
        storedPath,
        mimeType: detected.mimeType,
        size: fileStat.size,
        createdAt: new Date().toISOString(),
      }
      imported.push(attachment)
      if (!this.project.attachments.some((item) => item.id === attachment.id)) {
        this.project.attachments.push(attachment)
      }
    }
    return imported
  }

  getAttachmentPath(attachmentId: string): string {
    if (!this.rootPath || !this.project) throw new Error('请先创建或打开项目')
    const attachment = this.project.attachments.find((item) => item.id === attachmentId)
    if (!attachment) throw new Error('附件不存在')
    return this.resolveInsideProject(attachment.storedPath)
  }

  async close(): Promise<void> {
    if (this.rootPath && this.ownsLock) {
      await rm(path.join(this.rootPath, LOCK_FILE), { force: true })
    }
    this.rootPath = null
    this.project = null
    this.readOnly = false
    this.ownsLock = false
  }

  async moveTo(parentDirectory: string): Promise<ProjectSession> {
    if (!this.rootPath || !this.project) throw new Error('没有活动项目')
    if (this.readOnly) throw new Error('只读项目不能移动')
    const sourcePath = this.rootPath
    const targetPath = path.join(parentDirectory, path.basename(sourcePath))
    if (path.resolve(sourcePath).toLowerCase() === path.resolve(targetPath).toLowerCase()) {
      throw new Error('项目已经位于所选目录中')
    }
    if (existsSync(targetPath)) throw new Error(`目标位置已存在同名项目：${targetPath}`)

    await this.close()
    try {
      try {
        await rename(sourcePath, targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        try {
          await cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false })
        } catch (copyError) {
          await rm(targetPath, { recursive: true, force: true })
          throw copyError
        }
        await rm(sourcePath, { recursive: true })
      }
      return await this.open(targetPath)
    } catch (error) {
      if (existsSync(sourcePath)) {
        if (existsSync(targetPath)) await rm(targetPath, { recursive: true, force: true })
        await this.open(sourcePath)
      }
      throw error
    }
  }

  private session(): ProjectSession {
    if (!this.rootPath || !this.project) throw new Error('没有活动项目')
    return { project: this.project, rootPath: this.rootPath, readOnly: this.readOnly }
  }

  private async createDirectories(rootPath: string): Promise<void> {
    await Promise.all([
      mkdir(path.join(rootPath, 'assets', 'invoices'), { recursive: true }),
      mkdir(path.join(rootPath, 'assets', 'payments'), { recursive: true }),
      mkdir(path.join(rootPath, 'assets', 'others'), { recursive: true }),
      mkdir(path.join(rootPath, 'cache', 'thumbnails'), { recursive: true }),
      mkdir(path.join(rootPath, 'backup'), { recursive: true }),
    ])
  }

  private async acquireLock(rootPath: string): Promise<boolean> {
    const lockPath = path.join(rootPath, LOCK_FILE)
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as LockData
        if (lock.hostname !== hostname() || isProcessAlive(lock.pid)) return false
        await rm(lockPath, { force: true })
      } catch {
        return false
      }
    }
    const lock: LockData = { pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }
    try {
      await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' })
      this.ownsLock = true
      return true
    } catch {
      return false
    }
  }

  private async writeProjectFile(project: Project, createBackup: boolean): Promise<void> {
    if (!this.rootPath) throw new Error('没有活动项目目录')
    const projectPath = path.join(this.rootPath, PROJECT_FILE)
    const temporaryPath = path.join(this.rootPath, `${PROJECT_FILE}.tmp`)
    if (createBackup && existsSync(projectPath)) {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
      await copyFile(projectPath, path.join(this.rootPath, 'backup', `project-${stamp}.json`))
    }
    const handle = await open(temporaryPath, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, projectPath)
    } catch {
      await copyFile(temporaryPath, projectPath)
      await rm(temporaryPath, { force: true })
    }
    await this.pruneBackups()
  }

  private async pruneBackups(): Promise<void> {
    if (!this.rootPath) return
    const backupPath = path.join(this.rootPath, 'backup')
    const backups = (await readdir(backupPath))
      .filter((name) => /^project-\d{14}\.json$/.test(name))
      .sort()
    const obsolete = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))
    await Promise.all(obsolete.map((name) => rm(path.join(backupPath, name), { force: true })))
  }

  private resolveInsideProject(relativePath: string): string {
    if (!this.rootPath || path.isAbsolute(relativePath)) throw new Error('附件路径无效')
    const rootPath = realpathSync(this.rootPath)
    const resolved = realpathSync(path.resolve(rootPath, relativePath))
    const relative = path.relative(rootPath, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('附件路径越过项目目录')
    return resolved
  }
}
