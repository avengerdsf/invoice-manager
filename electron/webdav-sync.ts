import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project, WebdavSyncProgress, WebdavSyncStatus } from '../src/shared/models'
import { ProjectSchema } from '../src/shared/models'
import {
  type ChecksumsFile,
  type SyncManifest,
  type SyncSnapshot,
  checksumSignature,
  createSyncSnapshot,
  safePackageFileName,
  summarizeProject,
  validateProjectReferences,
} from './sync-package'

export interface WebdavConfig {
  enabled: boolean
  url: string
  username: string
  password: string
  remoteDirectory: string
}

export interface RemoteProjectIndex {
  manifest: SyncManifest
  project: Project
  checksums: ChecksumsFile
  projectJson: Buffer
  checksumsJson: Buffer
  manifestJson: Buffer
}

const CRITICAL_REMOTE_FILES = ['project.json', 'checksums.json', 'manifest.json'] as const
type ProgressReporter = (progress: WebdavSyncProgress) => void

function assertCompleteConfig(config: WebdavConfig): void {
  if (!config.enabled) throw new Error('尚未启用坚果云 WebDAV')
  if (!config.url.trim()) throw new Error('WebDAV 服务地址未配置')
  if (!config.username.trim()) throw new Error('WebDAV 账号邮箱未配置')
  if (!config.password) throw new Error('WebDAV 第三方应用密码未配置')
  if (!config.remoteDirectory.trim()) throw new Error('WebDAV 远程目录未配置')
}

function normalizeDirectory(value: string): string {
  const trimmed = value.trim() || '/InvoiceManager/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`
}

function joinRemotePath(...parts: string[]): string {
  return parts
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
}

function encodeRemotePath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function parseJsonBuffer<T>(buffer: Buffer, label: string): T {
  try {
    return JSON.parse(buffer.toString('utf8')) as T
  } catch {
    throw new Error(`${label} 不是有效 JSON`)
  }
}

function parseWebdavHrefs(xml: string): string[] {
  return [...xml.matchAll(/<[^:>]*:?href>([^<]+)<\/[^:>]*:?href>/gi)]
    .map((match) => match[1])
    .filter(Boolean)
}

export class WebdavClient {
  private readonly baseUrl: URL
  private readonly remoteDirectory: string
  private readonly authorization: string

  constructor(private readonly config: WebdavConfig) {
    assertCompleteConfig(config)
    this.baseUrl = new URL(config.url)
    this.remoteDirectory = normalizeDirectory(config.remoteDirectory)
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`
  }

  async testConnection(): Promise<void> {
    await this.ensureDirectory('')
    await this.listDirectoryPaged('', 100).next()
  }

  async ensureProjectDirectories(projectId: string): Promise<void> {
    await this.ensureDirectory('')
    await this.ensureDirectory('projects')
    await this.ensureDirectory(`projects/${projectId}`)
    await this.ensureDirectory(`projects/${projectId}/attachments`)
    await this.ensureDirectory(`projects/${projectId}/attachments/invoices`)
    await this.ensureDirectory(`projects/${projectId}/attachments/payments`)
    await this.ensureDirectory(`projects/${projectId}/attachments/others`)
  }

  async readRemoteIndex(projectId: string): Promise<RemoteProjectIndex | null> {
    const root = `projects/${projectId}`
    const manifestJson = await this.getOptional(`${root}/manifest.json`)
    if (!manifestJson) return null
    const projectJson = await this.get(`${root}/project.json`)
    const checksumsJson = await this.get(`${root}/checksums.json`)
    const manifest = parseJsonBuffer<SyncManifest>(manifestJson, '远端 manifest.json')
    const checksums = parseJsonBuffer<ChecksumsFile>(checksumsJson, '远端 checksums.json')
    const project = ProjectSchema.parse(parseJsonBuffer(projectJson, '远端 project.json'))
    if (project.id !== projectId || manifest.projectId !== projectId) throw new Error('远端项目 ID 与当前项目不一致')
    validateProjectReferences(project)
    const projectChecksum = checksums['project.json']
    if (!projectChecksum || projectChecksum.sha256 !== hashBuffer(projectJson) || projectChecksum.length !== projectJson.length) {
      throw new Error('远端 project.json 校验失败')
    }
    return { manifest, project, checksums, projectJson, checksumsJson, manifestJson }
  }

  async uploadSnapshot(snapshot: SyncSnapshot, onProgress?: ProgressReporter): Promise<void> {
    const root = `projects/${snapshot.manifest.projectId}`
    const total = snapshot.files.length + 4
    let current = 0
    onProgress?.({ action: 'upload', phase: 'prepare', current, total, message: '正在准备远程目录' })
    await this.ensureProjectDirectories(snapshot.manifest.projectId)
    current += 1
    const backup = new Map<string, Buffer | null>()
    for (const fileName of CRITICAL_REMOTE_FILES) {
      backup.set(fileName, await this.getOptional(`${root}/${fileName}`))
    }
    try {
      for (const file of snapshot.files) {
        const remotePath = `${root}/${file.packagePath}`
        onProgress?.({ action: 'upload', phase: 'attachments', current, total, message: `正在上传附件 ${current}/${total - 3}` })
        if (!await this.remoteFileMatches(remotePath, file.sha256, file.length)) {
          await this.uploadFileAtomic(remotePath, file.sourcePath, file.sha256, file.length)
        }
        current += 1
      }
      onProgress?.({ action: 'upload', phase: 'project', current, total, message: '正在上传项目数据' })
      await this.uploadBufferAtomic(`${root}/project.json`, snapshot.projectJson)
      current += 1
      onProgress?.({ action: 'upload', phase: 'checksums', current, total, message: '正在上传校验清单' })
      await this.uploadBufferAtomic(`${root}/checksums.json`, snapshot.checksumsJson)
      current += 1
      onProgress?.({ action: 'upload', phase: 'manifest', current, total, message: '正在发布远端版本' })
      await this.uploadBufferAtomic(`${root}/manifest.json`, Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`, 'utf8'))
      onProgress?.({ action: 'upload', phase: 'done', current: total, total, message: '上传完成' })
    } catch (error) {
      for (const [fileName, content] of backup) {
        const remotePath = `${root}/${fileName}`
        try {
          if (content) await this.put(remotePath, content)
        } catch {
          // Keep the original error; restore is best-effort.
        }
      }
      throw error
    }
  }

  async downloadProjectToZip(projectId: string, tempDirectory: string, onProgress?: ProgressReporter): Promise<string> {
    const root = `projects/${projectId}`
    onProgress?.({ action: 'download', phase: 'remote-index', current: 0, total: 1, message: '正在读取远端项目清单' })
    const index = await this.readRemoteIndex(projectId)
    if (!index) throw new Error('远端项目不存在')
    const rawProject = parseJsonBuffer<Project & { attachments: Array<{ packagePath: string }> }>(index.projectJson, '远端 project.json')
    const total = rawProject.attachments.length + 2
    let current = 1
    const packageRoot = path.join(tempDirectory, `webdav-download-${projectId}-${randomUUID()}`)
    await mkdir(packageRoot, { recursive: true })
    try {
      await writeFile(path.join(packageRoot, 'manifest.json'), index.manifestJson)
      await writeFile(path.join(packageRoot, 'project.json'), index.projectJson)
      await writeFile(path.join(packageRoot, 'checksums.json'), index.checksumsJson)
      for (const attachment of rawProject.attachments) {
        if (typeof attachment.packagePath !== 'string') throw new Error('远端附件缺少包内路径')
        onProgress?.({ action: 'download', phase: 'attachments', current, total, message: `正在下载附件 ${current}/${total - 1}` })
        const buffer = await this.get(`${root}/${attachment.packagePath}`)
        const targetPath = path.join(packageRoot, attachment.packagePath)
        await mkdir(path.dirname(targetPath), { recursive: true })
        await writeFile(targetPath, buffer)
        current += 1
      }
      onProgress?.({ action: 'download', phase: 'package', current, total, message: '正在校验并打包远端项目' })
      const zipPath = await zipPackageDirectory(packageRoot, path.join(tempDirectory, safePackageFileName(index.project.name)))
      onProgress?.({ action: 'download', phase: 'done', current: total, total, message: '下载完成' })
      return zipPath
    } finally {
      await rm(packageRoot, { recursive: true, force: true })
    }
  }

  async *listDirectoryPaged(relativePath: string, pageSize: number): AsyncGenerator<string[]> {
    const response = await this.request('PROPFIND', relativePath, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    }, '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>')
    if (response.status === 404) return
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或无权访问远程目录')
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV 文件列表失败：HTTP ${response.status}`)
    const hrefs = parseWebdavHrefs(await response.text())
    for (let index = 0; index < hrefs.length; index += pageSize) {
      yield hrefs.slice(index, index + pageSize)
    }
  }

  private remoteUrl(relativePath: string): URL {
    const basePath = this.baseUrl.pathname.replace(/\/+$/, '')
    const remotePath = encodeRemotePath(joinRemotePath(this.remoteDirectory, relativePath))
    const next = new URL(this.baseUrl.href)
    next.pathname = `${basePath}/${remotePath}`.replace(/\/+/g, '/')
    return next
  }

  private async ensureDirectory(relativePath: string): Promise<void> {
    const parts = joinRemotePath(relativePath).split('/').filter(Boolean)
    let current = ''
    const rootResponse = await this.request('MKCOL', '')
    if (![201, 405].includes(rootResponse.status)) {
      if (rootResponse.status === 401 || rootResponse.status === 403) throw new Error('WebDAV 认证失败或无权创建远程目录')
      throw new Error(`创建远程目录失败：HTTP ${rootResponse.status}`)
    }
    for (const part of parts) {
      current = joinRemotePath(current, part)
      const response = await this.request('MKCOL', current)
      if (![201, 405].includes(response.status)) {
        if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或无权创建远程目录')
        throw new Error(`创建远程目录失败：HTTP ${response.status}`)
      }
    }
  }

  private async remoteFileMatches(relativePath: string, sha256: string, length: number): Promise<boolean> {
    const buffer = await this.getOptional(relativePath)
    return Boolean(buffer && buffer.length === length && hashBuffer(buffer) === sha256)
  }

  private async uploadFileAtomic(relativePath: string, filePath: string, sha256: string, length: number): Promise<void> {
    const temporaryPath = `${relativePath}.tmp-${randomUUID()}`
    const fileBuffer = await readFile(filePath)
    if (fileBuffer.length !== length || hashBuffer(fileBuffer) !== sha256) throw new Error(`上传前附件校验失败：${path.basename(filePath)}`)
    await this.put(temporaryPath, fileBuffer)
    if (!await this.remoteFileMatches(temporaryPath, sha256, length)) throw new Error(`上传后校验失败：${relativePath}`)
    await this.move(temporaryPath, relativePath)
  }

  private async uploadBufferAtomic(relativePath: string, buffer: Buffer): Promise<void> {
    const temporaryPath = `${relativePath}.tmp-${randomUUID()}`
    await this.put(temporaryPath, buffer)
    const uploaded = await this.get(temporaryPath)
    if (uploaded.length !== buffer.length || hashBuffer(uploaded) !== hashBuffer(buffer)) throw new Error(`上传后校验失败：${relativePath}`)
    await this.move(temporaryPath, relativePath)
  }

  private async getOptional(relativePath: string): Promise<Buffer | null> {
    const response = await this.request('GET', relativePath)
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或无权访问远程文件')
    if (!response.ok) throw new Error(`读取远程文件失败：HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  private async get(relativePath: string): Promise<Buffer> {
    const buffer = await this.getOptional(relativePath)
    if (!buffer) throw new Error(`远程文件不存在：${relativePath}`)
    return buffer
  }

  private async put(relativePath: string, body: Buffer): Promise<void> {
    const response = await this.request('PUT', relativePath, {}, body)
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或无权写入远程文件')
    if (response.status < 200 || response.status >= 300) throw new Error(`写入远程文件失败：HTTP ${response.status}`)
  }

  private async move(sourcePath: string, targetPath: string): Promise<void> {
    const response = await this.request('MOVE', sourcePath, {
      Destination: this.remoteUrl(targetPath).href,
      Overwrite: 'T',
    })
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或无权替换远程文件')
    if (response.status < 200 || response.status >= 300) throw new Error(`替换远程文件失败：HTTP ${response.status}`)
  }

  private request(method: string, relativePath: string, headers: Record<string, string> = {}, body?: BodyInit | Buffer): Promise<Response> {
    return fetch(this.remoteUrl(relativePath), {
      method,
      headers: {
        Authorization: this.authorization,
        ...headers,
      },
      body: body as BodyInit | undefined,
    })
  }
}

export async function createLocalSnapshot(
  project: Project,
  rootPath: string,
  appVersion: string,
  deviceId: string,
): Promise<SyncSnapshot> {
  return createSyncSnapshot(project, rootPath, appVersion, deviceId)
}

export function compareSyncState(localSnapshot: SyncSnapshot, remote: RemoteProjectIndex | null): WebdavSyncStatus {
  if (!remote) {
    return {
      localRevision: localSnapshot.manifest.revision,
      localUpdatedAt: localSnapshot.manifest.updatedAt,
      remoteExists: false,
      remoteRevision: null,
      remoteUpdatedAt: null,
      localHasUnuploadedChanges: true,
      remoteHasUndownloadedChanges: false,
      conflict: false,
      state: 'remote-missing',
    }
  }
  if (remote.project.id !== localSnapshot.manifest.projectId) throw new Error('projectId 不同，禁止直接覆盖')
  const localSignature = checksumSignature(localSnapshot.checksums)
  const remoteSignature = checksumSignature(remote.checksums)
  const same = localSnapshot.manifest.revision === remote.manifest.revision && localSignature === remoteSignature
  const conflict = localSnapshot.manifest.revision === remote.manifest.revision && localSignature !== remoteSignature
  const localNewer = localSnapshot.manifest.revision > remote.manifest.revision
  const remoteNewer = remote.manifest.revision > localSnapshot.manifest.revision
  return {
    localRevision: localSnapshot.manifest.revision,
    localUpdatedAt: localSnapshot.manifest.updatedAt,
    remoteExists: true,
    remoteRevision: remote.manifest.revision,
    remoteUpdatedAt: remote.manifest.updatedAt,
    localHasUnuploadedChanges: localNewer || conflict,
    remoteHasUndownloadedChanges: remoteNewer || conflict,
    conflict,
    state: same ? 'latest' : conflict ? 'conflict' : localNewer ? 'local-newer' : remoteNewer ? 'remote-newer' : 'conflict',
  }
}

async function zipPackageDirectory(sourceRoot: string, destinationPath: string): Promise<string> {
  const { ZipArchive } = await import('archiver')
  await mkdir(path.dirname(destinationPath), { recursive: true })
  const output = createWriteStream(destinationPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(output)
  archive.file(path.join(sourceRoot, 'manifest.json'), { name: 'manifest.json' })
  archive.file(path.join(sourceRoot, 'project.json'), { name: 'project.json' })
  archive.file(path.join(sourceRoot, 'checksums.json'), { name: 'checksums.json' })
  const rawProject = parseJsonBuffer<Project & { attachments: Array<{ packagePath: string }> }>(
    await readFile(path.join(sourceRoot, 'project.json')),
    '远端 project.json',
  )
  for (const attachment of rawProject.attachments) {
    if (!attachment.packagePath || !existsSync(path.join(sourceRoot, attachment.packagePath))) {
      throw new Error('远端同步包附件不完整')
    }
    archive.file(path.join(sourceRoot, attachment.packagePath), { name: attachment.packagePath })
  }
  await archive.finalize()
  await completed
  return destinationPath
}

export function syncStatusDetail(status: WebdavSyncStatus): string {
  return [
    `本地 revision：${status.localRevision}`,
    `本地更新时间：${status.localUpdatedAt}`,
    `远端 revision：${status.remoteExists ? status.remoteRevision : '不存在'}`,
    `远端更新时间：${status.remoteExists ? status.remoteUpdatedAt : '不存在'}`,
    `本地是否有未上传修改：${status.localHasUnuploadedChanges ? '是' : '否'}`,
    `远端是否有未下载修改：${status.remoteHasUndownloadedChanges ? '是' : '否'}`,
    `是否存在冲突：${status.conflict ? '是' : '否'}`,
  ].join('\n')
}

export function syncCompleteMessage(project: Project): string {
  const summary = summarizeProject(project)
  return `项目 ${summary.projectName} 同步完成，revision ${summary.revision}`
}
