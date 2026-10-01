import type {
  RecentProjectStatus,
  WebdavProjectSyncStatusItem,
  WebdavSyncStatus,
} from '../shared/models'

export type SyncProjectStatusKind =
  | 'unchecked'
  | 'checking'
  | 'latest'
  | 'local-newer'
  | 'remote-newer'
  | 'remote-missing'
  | 'conflict'
  | 'failed'
  | 'unavailable'

export interface SyncProjectRow {
  name: string
  rootPath: string
  available: boolean
  checked: boolean
  statusKind: SyncProjectStatusKind
  statusText: string
  status?: WebdavSyncStatus
  error?: string
}

export interface SyncProjectColumnDisplay {
  primary: string
  secondary: string
  title: string
}

export function createSyncProjectRows(
  projects: RecentProjectStatus[],
  currentRootPath: string | null | undefined,
): SyncProjectRow[] {
  const seen = new Set<string>()
  return projects.filter((project) => {
    const key = project.rootPath.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((project) => {
    const current = currentRootPath
      ? project.rootPath.toLowerCase() === currentRootPath.toLowerCase()
      : false
    const available = project.available
    return {
      name: project.name,
      rootPath: project.rootPath,
      available,
      checked: available && current,
      statusKind: available ? 'unchecked' : 'unavailable',
      statusText: available ? '未检查' : '项目不可用',
    }
  })
}

export function syncProjectStatusKind(status: WebdavSyncStatus): SyncProjectStatusKind {
  return status.state
}

export function syncProjectStatusLabel(status: WebdavSyncStatus): string {
  if (status.state === 'latest') return '已同步'
  if (status.state === 'local-newer') return '待上传'
  if (status.state === 'remote-newer') return '待下载'
  if (status.state === 'remote-missing') return '待上传'
  return '冲突'
}

export function syncProjectLocalDisplay(status: WebdavSyncStatus): SyncProjectColumnDisplay {
  return {
    primary: formatSyncProjectTime(status.localUpdatedAt),
    secondary: status.localHasUnuploadedChanges ? '本地有修改' : '本地已同步',
    title: `本地版本 ${status.localRevision}`,
  }
}

export function syncProjectCloudDisplay(status: WebdavSyncStatus): SyncProjectColumnDisplay {
  if (!status.remoteExists) {
    return {
      primary: '未上传',
      secondary: '云端无项目',
      title: '云端无版本',
    }
  }
  return {
    primary: status.remoteUpdatedAt ? formatSyncProjectTime(status.remoteUpdatedAt) : '时间未知',
    secondary: status.remoteHasUndownloadedChanges ? '云端有修改' : '云端已同步',
    title: status.remoteRevision === null ? '云端版本未知' : `云端版本 ${status.remoteRevision}`,
  }
}

function formatSyncProjectTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(/\//g, '/')
}

export function markRowsChecking(rows: SyncProjectRow[], rootPaths: string[]): SyncProjectRow[] {
  const checking = new Set(rootPaths.map((rootPath) => rootPath.toLowerCase()))
  return rows.map((row) => (
    row.available && checking.has(row.rootPath.toLowerCase())
      ? { ...row, statusKind: 'checking', statusText: '检查中', error: undefined }
      : row
  ))
}

export function applySyncProjectStatusItems(
  rows: SyncProjectRow[],
  items: WebdavProjectSyncStatusItem[],
): SyncProjectRow[] {
  const byPath = new Map(items.map((item) => [item.rootPath.toLowerCase(), item]))
  return rows.map((row) => {
    const item = byPath.get(row.rootPath.toLowerCase())
    if (!item) return row
    if (item.status) {
      return {
        ...row,
        status: item.status,
        statusKind: syncProjectStatusKind(item.status),
        statusText: syncProjectStatusLabel(item.status),
        error: undefined,
      }
    }
    return {
      ...row,
      status: undefined,
      statusKind: 'failed',
      statusText: '检查失败',
      error: item.error || '未知错误',
    }
  })
}
