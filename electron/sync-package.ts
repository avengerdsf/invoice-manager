import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type { Attachment, AttachmentKind, Project, SyncPackageSummary } from '../src/shared/models'
import { ProjectSchema } from '../src/shared/models'

export const SYNC_FORMAT = 'invoice-manager-sync'
export const SYNC_FORMAT_VERSION = 1
const PROJECT_FILE = 'project.json'
const CHECKSUMS_FILE = 'checksums.json'
const MANIFEST_FILE = 'manifest.json'
const MAX_ZIP_SIZE = 1024 * 1024 * 1024
const MAX_ZIP_ENTRIES = 20000
const MAX_UNCOMPRESSED_SIZE = 3 * 1024 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 120

export interface SyncManifest {
  format: typeof SYNC_FORMAT
  formatVersion: number
  schemaVersion: number
  projectId: string
  projectName: string
  revision: number
  createdAt: string
  updatedAt: string
  exportedAt: string
  lastWriter: {
    deviceId: string
    platform: 'windows' | 'ubuntu'
    appVersion: string
  }
}

export interface ChecksumEntry {
  sha256: string
  length: number
  mime: string
}

export type ChecksumsFile = Record<string, ChecksumEntry>

interface PackageAttachment extends Attachment {
  packagePath: string
  allocations: Array<{
    allocationId: string
    expenseId: string
    allocatedCents: number
  }>
}

type RawSyncProject = Omit<Project, 'attachments'> & { attachments: PackageAttachment[] }

interface ValidatedSyncPackage {
  manifest: SyncManifest
  project: Project
  rawProject: RawSyncProject
  checksums: ChecksumsFile
  zip: JSZip
  summary: SyncPackageSummary
}

interface SnapshotFile {
  packagePath: string
  sourcePath: string
  mime: string
  length: number
  sha256: string
}

export interface SyncSnapshot {
  manifest: SyncManifest
  projectJson: Buffer
  checksumsJson: Buffer
  files: SnapshotFile[]
  checksums: ChecksumsFile
  summary: SyncPackageSummary
}

export interface InstallSyncPackageOptions {
  zipPath: string
  targetRootPath: string
  tempParentDirectory: string
  mode: 'new' | 'copy' | 'overwrite'
}

export interface InstallSyncPackageResult {
  rootPath: string
  project: Project
  summary: SyncPackageSummary
  backupPath?: string
}

function isoUtc(value: string): string {
  return new Date(value).toISOString()
}

export function sanitizeProjectName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  if (!sanitized) throw new Error('项目名称不能为空')
  return sanitized
}

export function uniqueProjectRoot(parentDirectory: string, projectName: string): string {
  const baseName = sanitizeProjectName(projectName)
  let candidate = path.join(parentDirectory, `${baseName}.invoice-project`)
  let index = 2
  while (existsSync(candidate)) {
    candidate = path.join(parentDirectory, `${baseName} (${index}).invoice-project`)
    index += 1
  }
  return candidate
}

export function summarizeProject(project: Project): SyncPackageSummary {
  return {
    projectName: project.name,
    projectId: project.id,
    revision: project.revision,
    updatedAt: project.updatedAt,
    expenseCount: project.expenses.length,
    invoiceAttachmentCount: project.attachments.filter((item) => item.kind === 'invoice').length,
    paymentAttachmentCount: project.attachments.filter((item) => item.kind === 'payment').length,
    otherAttachmentCount: project.attachments.filter((item) => item.kind === 'other').length,
  }
}

export function safePackageFileName(projectName: string): string {
  return `${sanitizeProjectName(projectName)}-invoice-sync.zip`
}

function platformName(): 'windows' | 'ubuntu' {
  return process.platform === 'win32' ? 'windows' : 'ubuntu'
}

async function hashBuffer(buffer: Buffer): Promise<string> {
  return createHash('sha256').update(buffer).digest('hex')
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

function attachmentDirectory(kind: AttachmentKind): 'invoices' | 'payments' | 'others' {
  if (kind === 'invoice') return 'invoices'
  if (kind === 'payment') return 'payments'
  return 'others'
}

function extensionForAttachment(attachment: Attachment): string {
  const extension = path.extname(attachment.originalName || attachment.storedPath).toLowerCase()
  if (/^\.[a-z0-9]{1,12}$/.test(extension)) return extension
  if (attachment.mimeType === 'application/pdf') return '.pdf'
  if (attachment.mimeType === 'image/png') return '.png'
  if (attachment.mimeType === 'image/webp') return '.webp'
  return '.jpg'
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\\')) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('//')) return false
  if (/^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith('\\\\')) return false
  const parts = relativePath.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function assertSafePackagePath(relativePath: string): void {
  if (!isSafeRelativePath(relativePath)) throw new Error(`同步包包含不安全路径：${relativePath}`)
}

function resolveInsideProject(rootPath: string, storedPath: string): string {
  if (!isSafeRelativePath(storedPath)) throw new Error(`附件路径无效：${storedPath}`)
  const realRoot = realpathSync(rootPath)
  const resolved = realpathSync(path.resolve(realRoot, storedPath))
  const relative = path.relative(realRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`附件路径越过项目目录：${storedPath}`)
  if (lstatSync(resolved).isSymbolicLink()) throw new Error(`附件不能是符号链接：${storedPath}`)
  return resolved
}

function assertNoDuplicateIds(project: Project): void {
  const assertUnique = (label: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`${label} 存在重复 ID：${id}`)
      seen.add(id)
    }
  }
  assertUnique('分类', project.categories.map((item) => item.id))
  assertUnique('明细', project.expenses.map((item) => item.id))
  assertUnique('附件', project.attachments.map((item) => item.id))
  assertUnique('发票分配', project.invoiceAllocations.map((item) => item.id))
  assertUnique('付款截图分配', project.paymentAllocations.map((item) => item.id))
  assertUnique('其他附件分配', project.otherAllocations.map((item) => item.id))
}

export function validateProjectReferences(project: Project): void {
  assertNoDuplicateIds(project)
  const categoryIds = new Set(project.categories.map((item) => item.id))
  const expenseIds = new Set(project.expenses.map((item) => item.id))
  const attachmentById = new Map(project.attachments.map((item) => [item.id, item]))
  for (const expense of project.expenses) {
    if (!categoryIds.has(expense.categoryId)) throw new Error(`明细引用了不存在的分类：${expense.name}`)
  }
  const validateAllocations = (kind: AttachmentKind, allocations: Project['invoiceAllocations']) => {
    for (const allocation of allocations) {
      if (!expenseIds.has(allocation.expenseId)) throw new Error(`附件分配引用了不存在的明细：${allocation.id}`)
      const attachment = attachmentById.get(allocation.attachmentId)
      if (!attachment) throw new Error(`附件分配引用了不存在的附件：${allocation.id}`)
      if (attachment.kind !== kind) throw new Error(`附件分配类型不匹配：${allocation.id}`)
    }
  }
  validateAllocations('invoice', project.invoiceAllocations)
  validateAllocations('payment', project.paymentAllocations)
  validateAllocations('other', project.otherAllocations)
  for (const attachment of project.attachments) {
    if (!isSafeRelativePath(attachment.storedPath)) throw new Error(`附件路径无效：${attachment.originalName}`)
  }
}

function allocationsForAttachment(project: Project, attachment: Attachment): PackageAttachment['allocations'] {
  const allocations = attachment.kind === 'invoice'
    ? project.invoiceAllocations
    : attachment.kind === 'payment'
      ? project.paymentAllocations
      : project.otherAllocations
  return allocations
    .filter((allocation) => allocation.attachmentId === attachment.id)
    .map((allocation) => ({
      allocationId: allocation.id,
      expenseId: allocation.expenseId,
      allocatedCents: allocation.allocatedCents,
    }))
}

export async function createSyncSnapshot(
  project: Project,
  rootPath: string,
  appVersion: string,
  deviceId: string,
): Promise<SyncSnapshot> {
  const snapshot = ProjectSchema.parse(structuredClone(project))
  validateProjectReferences(snapshot)
  const files: SnapshotFile[] = []
  const fileByContentKey = new Map<string, SnapshotFile>()
  const packageAttachments: PackageAttachment[] = []

  for (const attachment of snapshot.attachments) {
    const sourcePath = resolveInsideProject(rootPath, attachment.storedPath)
    const fileStat = await stat(sourcePath)
    const sha256 = await hashFile(sourcePath)
    if (sha256 !== attachment.sha256) throw new Error(`附件哈希与项目记录不一致：${attachment.originalName}`)
    if (fileStat.size !== attachment.size) throw new Error(`附件大小与项目记录不一致：${attachment.originalName}`)
    const packagePath = `attachments/${attachmentDirectory(attachment.kind)}/${sha256}${extensionForAttachment(attachment)}`
    assertSafePackagePath(packagePath)
    const contentKey = `${sha256}:${packagePath}`
    let snapshotFile = fileByContentKey.get(contentKey)
    if (!snapshotFile) {
      snapshotFile = { packagePath, sourcePath, mime: attachment.mimeType, length: fileStat.size, sha256 }
      fileByContentKey.set(contentKey, snapshotFile)
      files.push(snapshotFile)
    }
    packageAttachments.push({
      ...attachment,
      packagePath,
      allocations: allocationsForAttachment(snapshot, attachment),
    })
  }

  const exportedAt = new Date().toISOString()
  const manifest: SyncManifest = {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    schemaVersion: snapshot.schemaVersion,
    projectId: snapshot.id,
    projectName: snapshot.name,
    revision: snapshot.revision,
    createdAt: isoUtc(snapshot.createdAt),
    updatedAt: isoUtc(snapshot.updatedAt),
    exportedAt,
    lastWriter: {
      deviceId,
      platform: platformName(),
      appVersion,
    },
  }
  const rawProject = {
    ...snapshot,
    attachments: packageAttachments,
  }
  const projectJson = Buffer.from(`${JSON.stringify(rawProject, null, 2)}\n`, 'utf8')
  const checksums: ChecksumsFile = {
    [PROJECT_FILE]: {
      sha256: await hashBuffer(projectJson),
      length: projectJson.length,
      mime: 'application/json',
    },
  }
  for (const file of files) {
    checksums[file.packagePath] = {
      sha256: file.sha256,
      length: file.length,
      mime: file.mime,
    }
  }
  const checksumsJson = Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`, 'utf8')
  return {
    manifest,
    projectJson,
    checksumsJson,
    files,
    checksums,
    summary: summarizeProject(snapshot),
  }
}

export async function writeSyncPackageZip(snapshot: SyncSnapshot, destinationPath: string, tempDirectory: string): Promise<void> {
  const { ZipArchive } = await import('archiver')
  await mkdir(tempDirectory, { recursive: true })
  const temporaryPath = path.join(tempDirectory, `invoice-sync-${snapshot.manifest.projectId}-${Date.now()}.zip`)
  const output = createWriteStream(temporaryPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(output)
  archive.append(Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`, 'utf8'), { name: MANIFEST_FILE })
  archive.append(snapshot.projectJson, { name: PROJECT_FILE })
  archive.append(snapshot.checksumsJson, { name: CHECKSUMS_FILE })
  for (const file of snapshot.files) {
    archive.file(file.sourcePath, { name: file.packagePath })
  }
  await archive.finalize()
  await completed
  await validateSyncPackageZip(temporaryPath)
  await copyFile(temporaryPath, destinationPath)
  await rm(temporaryPath, { force: true })
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 格式无效`)
  return value as Record<string, unknown>
}

function parseManifest(value: unknown): SyncManifest {
  const raw = requireObject(value, MANIFEST_FILE)
  const lastWriter = requireObject(raw.lastWriter, 'lastWriter')
  if (raw.format !== SYNC_FORMAT) throw new Error('同步包格式不受支持')
  if (raw.formatVersion !== SYNC_FORMAT_VERSION) throw new Error('同步包版本不受支持')
  if (lastWriter.platform !== 'windows' && lastWriter.platform !== 'ubuntu') throw new Error('同步包平台字段无效')
  return {
    format: SYNC_FORMAT,
    formatVersion: Number(raw.formatVersion),
    schemaVersion: Number(raw.schemaVersion),
    projectId: String(raw.projectId),
    projectName: String(raw.projectName),
    revision: Number(raw.revision),
    createdAt: isoUtc(String(raw.createdAt)),
    updatedAt: isoUtc(String(raw.updatedAt)),
    exportedAt: isoUtc(String(raw.exportedAt)),
    lastWriter: {
      deviceId: String(lastWriter.deviceId),
      platform: lastWriter.platform,
      appVersion: String(lastWriter.appVersion),
    },
  }
}

function parseChecksums(value: unknown): ChecksumsFile {
  const raw = requireObject(value, CHECKSUMS_FILE)
  const checksums: ChecksumsFile = {}
  for (const [entryPath, entryValue] of Object.entries(raw)) {
    assertSafePackagePath(entryPath)
    const entry = requireObject(entryValue, `checksums.${entryPath}`)
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256))) throw new Error(`校验和 SHA-256 无效：${entryPath}`)
    const length = Number(entry.length)
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`校验和长度无效：${entryPath}`)
    checksums[entryPath] = {
      sha256: String(entry.sha256),
      length,
      mime: String(entry.mime || 'application/octet-stream'),
    }
  }
  return checksums
}

async function readZipEntry(zip: JSZip, entryPath: string): Promise<Buffer> {
  const entry = zip.file(entryPath)
  if (!entry) throw new Error(`同步包缺少必要文件：${entryPath}`)
  return entry.async('nodebuffer')
}

async function readJsonEntry(zip: JSZip, entryPath: string): Promise<unknown> {
  const buffer = await readZipEntry(zip, entryPath)
  return JSON.parse(buffer.toString('utf8')) as unknown
}

function inspectZipEntries(zip: JSZip, zipSize: number): void {
  const names = Object.values(zip.files)
    .map((entry) => String((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name))
  if (names.length > MAX_ZIP_ENTRIES) throw new Error('同步包条目数量过多')
  const normalizedNames = new Set<string>()
  let totalUncompressed = 0
  for (const entry of Object.values(zip.files)) {
    const originalName = String((entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name)
    assertSafePackagePath(originalName.replace(/\/$/, ''))
    const lower = originalName.toLowerCase()
    if (normalizedNames.has(lower)) throw new Error(`同步包存在大小写路径冲突：${originalName}`)
    normalizedNames.add(lower)
    const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
    const uncompressedSize = data?.uncompressedSize
    if (typeof uncompressedSize !== 'number' || uncompressedSize < 0) throw new Error(`无法读取 ZIP 条目大小：${originalName}`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_UNCOMPRESSED_SIZE) throw new Error('同步包解压后体积过大')
  }
  if (zipSize > 0 && totalUncompressed / zipSize > MAX_COMPRESSION_RATIO) throw new Error('同步包压缩比异常，已拒绝导入')
}

function assertManifestMatchesProject(manifest: SyncManifest, project: Project): void {
  if (manifest.schemaVersion !== project.schemaVersion) throw new Error('manifest schemaVersion 与项目不一致')
  if (manifest.projectId !== project.id) throw new Error('manifest projectId 与项目不一致')
  if (manifest.projectName !== project.name) throw new Error('manifest projectName 与项目不一致')
  if (manifest.revision !== project.revision) throw new Error('manifest revision 与项目不一致')
  if (manifest.updatedAt !== isoUtc(project.updatedAt)) throw new Error('manifest updatedAt 与项目不一致')
}

async function assertChecksum(zip: JSZip, entryPath: string, checksums: ChecksumsFile): Promise<void> {
  const expected = checksums[entryPath]
  if (!expected) throw new Error(`checksums.json 缺少记录：${entryPath}`)
  const buffer = await readZipEntry(zip, entryPath)
  if (buffer.length !== expected.length) throw new Error(`文件长度校验失败：${entryPath}`)
  const sha256 = await hashBuffer(buffer)
  if (sha256 !== expected.sha256) throw new Error(`文件 SHA-256 校验失败：${entryPath}`)
}

async function validatePackageContents(packageData: ValidatedSyncPackage): Promise<void> {
  assertManifestMatchesProject(packageData.manifest, packageData.project)
  validateProjectReferences(packageData.project)
  await assertChecksum(packageData.zip, PROJECT_FILE, packageData.checksums)
  for (const attachment of packageData.rawProject.attachments) {
    assertSafePackagePath(attachment.packagePath)
    const expectedDirectory = `attachments/${attachmentDirectory(attachment.kind)}/`
    if (!attachment.packagePath.startsWith(expectedDirectory)) throw new Error(`附件包内目录与类型不一致：${attachment.originalName}`)
    const fileName = attachment.packagePath.slice(expectedDirectory.length)
    if (!fileName.startsWith(`${attachment.sha256}.`)) throw new Error(`附件未使用 SHA-256 命名：${attachment.originalName}`)
    await assertChecksum(packageData.zip, attachment.packagePath, packageData.checksums)
    const checksum = packageData.checksums[attachment.packagePath]
    if (checksum.sha256 !== attachment.sha256) throw new Error(`附件校验和与项目记录不一致：${attachment.originalName}`)
    if (checksum.length !== attachment.size) throw new Error(`附件大小与项目记录不一致：${attachment.originalName}`)
    if (checksum.mime !== attachment.mimeType) throw new Error(`附件 MIME 与项目记录不一致：${attachment.originalName}`)
  }
}

export async function validateSyncPackageZip(zipPath: string): Promise<ValidatedSyncPackage> {
  if (!zipPath.endsWith('-invoice-sync.zip')) throw new Error('请选择文件名以 -invoice-sync.zip 结尾的普通 ZIP 文件')
  const zipStat = await stat(zipPath)
  if (zipStat.size <= 0 || zipStat.size > MAX_ZIP_SIZE) throw new Error('同步包文件大小无效')
  const zip = await JSZip.loadAsync(await readFile(zipPath), { checkCRC32: true })
  inspectZipEntries(zip, zipStat.size)
  const manifest = parseManifest(await readJsonEntry(zip, MANIFEST_FILE))
  const checksums = parseChecksums(await readJsonEntry(zip, CHECKSUMS_FILE))
  const rawProject = requireObject(await readJsonEntry(zip, PROJECT_FILE), PROJECT_FILE) as RawSyncProject
  if (!Array.isArray(rawProject.attachments)) throw new Error('project.json 附件列表无效')
  for (const attachment of rawProject.attachments) {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.packagePath !== 'string') {
      throw new Error('project.json 附件缺少包内路径')
    }
  }
  const project = ProjectSchema.parse(rawProject)
  const packageData: ValidatedSyncPackage = {
    manifest,
    project,
    rawProject,
    checksums,
    zip,
    summary: summarizeProject(project),
  }
  await validatePackageContents(packageData)
  return packageData
}

async function createProjectDirectories(rootPath: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(rootPath, 'assets', 'invoices'), { recursive: true }),
    mkdir(path.join(rootPath, 'assets', 'payments'), { recursive: true }),
    mkdir(path.join(rootPath, 'assets', 'others'), { recursive: true }),
    mkdir(path.join(rootPath, 'cache', 'thumbnails'), { recursive: true }),
    mkdir(path.join(rootPath, 'backup'), { recursive: true }),
  ])
}

function importedStoredPath(attachment: PackageAttachment): string {
  return path.posix.join('assets', attachmentDirectory(attachment.kind), path.posix.basename(attachment.packagePath))
}

function projectForInstall(packageData: ValidatedSyncPackage, mode: 'new' | 'copy' | 'overwrite'): Project {
  const nextProject = structuredClone(packageData.project)
  if (mode === 'copy') {
    nextProject.id = randomUUID()
    nextProject.name = `${nextProject.name} 副本`.slice(0, 80)
    nextProject.revision += 1
    nextProject.updatedAt = new Date().toISOString()
  }
  const packageAttachmentById = new Map(packageData.rawProject.attachments.map((item) => [item.id, item]))
  nextProject.attachments = nextProject.attachments.map((attachment) => {
    const packageAttachment = packageAttachmentById.get(attachment.id)
    if (!packageAttachment) throw new Error(`附件缺少同步包元数据：${attachment.originalName}`)
    return {
      ...attachment,
      storedPath: importedStoredPath(packageAttachment),
    }
  })
  return ProjectSchema.parse(nextProject)
}

async function writeProjectFromPackage(packageData: ValidatedSyncPackage, rootPath: string, mode: 'new' | 'copy' | 'overwrite'): Promise<Project> {
  await createProjectDirectories(rootPath)
  const project = projectForInstall(packageData, mode)
  const packageAttachmentById = new Map(packageData.rawProject.attachments.map((item) => [item.id, item]))
  for (const attachment of project.attachments) {
    const packageAttachment = packageAttachmentById.get(attachment.id)
    if (!packageAttachment) throw new Error(`附件缺少同步包元数据：${attachment.originalName}`)
    const buffer = await readZipEntry(packageData.zip, packageAttachment.packagePath)
    const targetPath = path.join(rootPath, attachment.storedPath)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, buffer)
  }
  await writeFile(path.join(rootPath, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`, 'utf8')
  return project
}

function backupPathFor(targetRootPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return path.join(path.dirname(targetRootPath), `${path.basename(targetRootPath)}.backup-${stamp}`)
}

export async function installSyncPackage(options: InstallSyncPackageOptions): Promise<InstallSyncPackageResult> {
  const packageData = await validateSyncPackageZip(options.zipPath)
  await mkdir(options.tempParentDirectory, { recursive: true })
  const targetParent = path.dirname(options.targetRootPath)
  const stagingRoot = path.join(targetParent, `.invoice-sync-import-${randomUUID()}.tmp`)
  let backupPath: string | undefined
  try {
    await writeProjectFromPackage(packageData, stagingRoot, options.mode)
    if (options.mode === 'overwrite') {
      if (!existsSync(options.targetRootPath)) throw new Error('要覆盖的项目不存在')
      backupPath = backupPathFor(options.targetRootPath)
      await rename(options.targetRootPath, backupPath)
      try {
        await rename(stagingRoot, options.targetRootPath)
      } catch (error) {
        if (existsSync(backupPath) && !existsSync(options.targetRootPath)) await rename(backupPath, options.targetRootPath)
        throw error
      }
    } else {
      if (existsSync(options.targetRootPath)) throw new Error(`目标项目已存在：${options.targetRootPath}`)
      await rename(stagingRoot, options.targetRootPath)
    }
    const project = ProjectSchema.parse(JSON.parse(await readFile(path.join(options.targetRootPath, PROJECT_FILE), 'utf8')))
    return { rootPath: options.targetRootPath, project, summary: summarizeProject(project), backupPath }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

export async function copySyncDirectoryToProject(sourceRoot: string, targetRoot: string): Promise<string | undefined> {
  const backupPath = existsSync(targetRoot) ? backupPathFor(targetRoot) : undefined
  if (backupPath) await rename(targetRoot, backupPath)
  try {
    await cp(sourceRoot, targetRoot, { recursive: true, force: false, errorOnExist: true })
    return backupPath
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true })
    if (backupPath && existsSync(backupPath) && !existsSync(targetRoot)) await rename(backupPath, targetRoot)
    throw error
  }
}

export function checksumSignature(checksums: ChecksumsFile): string {
  return JSON.stringify(
    Object.entries(checksums)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryPath, entry]) => [entryPath, entry.sha256, entry.length, entry.mime]),
  )
}
