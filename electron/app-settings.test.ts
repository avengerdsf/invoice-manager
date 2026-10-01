import { describe, expect, it } from 'vitest'
import { readStoredWebdavPassword } from './app-settings'

describe('readStoredWebdavPassword', () => {
  it('turns an unreadable safeStorage ciphertext into an actionable WebDAV password error', () => {
    expect(() => readStoredWebdavPassword('broken-ciphertext', () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    })).toThrow('保存的 WebDAV 密码无法读取，请重新输入第三方应用密码')
  })
})
