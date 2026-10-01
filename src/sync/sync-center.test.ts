import { describe, expect, it } from 'vitest'
import {
  createSyncProjectRows,
  syncProjectCloudDisplay,
  syncProjectLocalDisplay,
  syncProjectStatusLabel,
} from './sync-center'
import type { RecentProjectStatus, WebdavSyncStatus } from '../shared/models'

const recentProjects: RecentProjectStatus[] = [
  {
    name: '差旅报销',
    rootPath: 'E:\\projects\\travel.invoice-project',
    lastOpenedAt: '2026-08-30T10:00:00.000Z',
    available: true,
  },
  {
    name: '设备采购',
    rootPath: 'E:\\projects\\devices.invoice-project',
    lastOpenedAt: '2026-08-29T10:00:00.000Z',
    available: true,
  },
  {
    name: '已移动项目',
    rootPath: 'E:\\projects\\missing.invoice-project',
    lastOpenedAt: '2026-08-28T10:00:00.000Z',
    available: false,
  },
]

describe('sync center project rows', () => {
  it('defaults only the current available project to checked and leaves each row unchecked for status', () => {
    const rows = createSyncProjectRows(recentProjects, 'E:\\projects\\travel.invoice-project')

    expect(rows).toEqual([
      {
        name: '差旅报销',
        rootPath: 'E:\\projects\\travel.invoice-project',
        available: true,
        checked: true,
        statusKind: 'unchecked',
        statusText: '未检查',
      },
      {
        name: '设备采购',
        rootPath: 'E:\\projects\\devices.invoice-project',
        available: true,
        checked: false,
        statusKind: 'unchecked',
        statusText: '未检查',
      },
      {
        name: '已移动项目',
        rootPath: 'E:\\projects\\missing.invoice-project',
        available: false,
        checked: false,
        statusKind: 'unavailable',
        statusText: '项目不可用',
      },
    ])
  })

  it('labels every WebDAV sync state shown in the project list', () => {
    const baseStatus: WebdavSyncStatus = {
      localRevision: 3,
      localUpdatedAt: '2026-08-30T10:00:00.000Z',
      remoteExists: true,
      remoteRevision: 3,
      remoteUpdatedAt: '2026-08-30T10:00:00.000Z',
      localHasUnuploadedChanges: false,
      remoteHasUndownloadedChanges: false,
      conflict: false,
      state: 'latest',
    }

    expect(syncProjectStatusLabel(baseStatus)).toBe('已同步')
    expect(syncProjectStatusLabel({ ...baseStatus, state: 'local-newer' })).toBe('待上传')
    expect(syncProjectStatusLabel({ ...baseStatus, state: 'remote-newer' })).toBe('待下载')
    expect(syncProjectStatusLabel({ ...baseStatus, state: 'remote-missing', remoteExists: false, remoteRevision: null })).toBe('待上传')
    expect(syncProjectStatusLabel({ ...baseStatus, state: 'conflict', conflict: true })).toBe('冲突')
  })

  it('shows user-facing local and cloud timestamps instead of revision numbers', () => {
    const status: WebdavSyncStatus = {
      localRevision: 51,
      localUpdatedAt: '2026-07-26T02:17:48.000Z',
      remoteExists: false,
      remoteRevision: null,
      remoteUpdatedAt: null,
      localHasUnuploadedChanges: true,
      remoteHasUndownloadedChanges: false,
      conflict: false,
      state: 'remote-missing',
    }

    expect(syncProjectLocalDisplay(status)).toEqual({
      primary: '2026/7/26 10:17',
      secondary: '本地有修改',
      title: '本地版本 51',
    })
    expect(syncProjectCloudDisplay(status)).toEqual({
      primary: '未上传',
      secondary: '云端无项目',
      title: '云端无版本',
    })
  })
})
