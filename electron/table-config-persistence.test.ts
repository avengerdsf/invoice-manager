import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getProjectTableConfig } from '../src/domain/table-config'
import { ProjectStorage } from './project-storage'
import { createSyncSnapshot, installSyncPackage, writeSyncPackageZip } from './sync-package'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('table configuration persistence', () => {
  it('keeps column IDs, order, visibility, and custom values through save, reopen, and sync import', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'invoice-table-config-'))
    temporaryDirectories.push(root)
    const storage = new ProjectStorage()
    try {
      const created = await storage.create(root, '测试项目', '1.5.1')
      const project = structuredClone(created.project)
      const config = getProjectTableConfig(project)
      const customColumn = { id: 'custom-route', name: '路线', kind: 'input' as const, inputType: 'text' as const }
      config.columns.unshift(customColumn)
      config.columns.find((column) => column.id === 'note')!.visible = false
      project.tableConfig = config
      project.expenses.push({
        id: 'expense-1', categoryId: project.categories[0].id, date: '2026-10-01', name: '车票',
        priceCents: 1200, taxCents: 0, actualPayer: '张三', note: '', reimbursed: false,
        customValues: { 'custom-route': '上海到北京' },
      })

      const saved = await storage.save(project)
      await storage.close()
      const reopened = await storage.open(created.rootPath)
      expect(reopened.project.tableConfig?.columns[0].id).toBe('custom-route')
      expect(reopened.project.tableConfig?.columns.find((column) => column.id === 'note')?.visible).toBe(false)
      expect(reopened.project.expenses[0].customValues?.['custom-route']).toBe('上海到北京')

      const snapshot = await createSyncSnapshot(saved, created.rootPath, '1.5.1', 'test-device')
      const zipPath = path.join(root, 'project-invoice-sync.zip')
      await writeSyncPackageZip(snapshot, zipPath, root)
      const restored = await installSyncPackage({
        zipPath, targetRootPath: path.join(root, 'restored.invoice-project'),
        tempParentDirectory: root, mode: 'new',
      })
      expect(restored.project.tableConfig).toEqual(reopened.project.tableConfig)
      expect(restored.project.expenses[0].customValues).toEqual({ 'custom-route': '上海到北京' })
    } finally {
      await storage.close()
    }
  })
})
