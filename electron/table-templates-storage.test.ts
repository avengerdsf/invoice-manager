import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppSettingsStorage } from './app-settings'
import { createTableTemplate } from '../src/domain/table-templates'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('table template settings storage', () => {
  it('reads legacy settings with a synthetic default and persists an independent selected template', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'invoice-template-'))
    directories.push(directory)
    const file = path.join(directory, 'settings.json')
    const storage = new AppSettingsStorage(file)
    const legacy = await storage.read()
    expect(legacy.tableTemplates?.[0].id).toBe('template-default')
    expect(legacy.defaultTableTemplateId).toBe('template-default')
    const second = createTableTemplate('Travel', undefined, 'template-travel')
    await storage.saveSettings({ payerNames: [], tableTemplates: [...legacy.tableTemplates!, second], defaultTableTemplateId: second.id })
    const reopened = new AppSettingsStorage(file)
    expect((await reopened.read()).tableTemplates?.[1].name).toBe('Travel')
    expect((await reopened.read()).defaultTableTemplateId).toBe('template-travel')
  })

  it('rejects deleting the active default atomically without changing the settings file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'invoice-template-'))
    directories.push(directory)
    const file = path.join(directory, 'settings.json')
    const storage = new AppSettingsStorage(file)
    const initial = await storage.read()
    await storage.saveSettings({ payerNames: [], tableTemplates: initial.tableTemplates, defaultTableTemplateId: initial.defaultTableTemplateId })
    const before = await readFile(file, 'utf8')
    await expect(storage.saveSettings({ payerNames: [], tableTemplates: [createTableTemplate('Other', undefined, 'template-other')], defaultTableTemplateId: 'template-default' })).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('recovers from a corrupt active template pair using the backup file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'invoice-template-'))
    directories.push(directory)
    const file = path.join(directory, 'settings.json')
    const storage = new AppSettingsStorage(file)
    await storage.saveSettings({ payerNames: [], tableTemplates: [createTableTemplate('Valid', undefined, 'template-valid')], defaultTableTemplateId: 'template-valid' })
    const corrupt = JSON.parse(await readFile(file, 'utf8'))
    corrupt.tableTemplates = [createTableTemplate('Other', undefined, 'template-other')]
    corrupt.defaultTableTemplateId = 'template-missing'
    await writeFile(file, JSON.stringify(corrupt), 'utf8')
    expect((await storage.read()).defaultTableTemplateId).toBe('template-valid')
  })
})
