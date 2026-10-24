/**
 * Unit tests for writing repository secrets, src/secrets.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import sodium from 'libsodium-wrappers'
import { encryptSecret, syncSecrets } from '../src/secrets'

const API = 'https://api.github.com'

describe('encryptSecret', () => {
  it('produces a sealed box the repository key can open', async () => {
    await sodium.ready
    const keys = sodium.crypto_box_keypair()
    const publicKey = sodium.to_base64(
      keys.publicKey,
      sodium.base64_variants.ORIGINAL
    )

    const encrypted = await encryptSecret('cookie-value', publicKey)
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      keys.publicKey,
      keys.privateKey
    )

    expect(sodium.to_string(opened)).toBe('cookie-value')
  })
})

describe('syncSecrets', () => {
  let publicKey: string

  beforeAll(async () => {
    await sodium.ready
    publicKey = sodium.to_base64(
      sodium.crypto_box_keypair().publicKey,
      sodium.base64_variants.ORIGINAL
    )
  })

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()
    process.env.GITHUB_REPOSITORY = 'Koja-Scripts/uploader'
  })

  it('updates only repositories that already have the cookie secret', async () => {
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith(`${API}/orgs/Koja-Scripts/repos`)) {
        return {
          data: [
            { name: 'uploader', archived: false },
            { name: 'koja-fishing', archived: false },
            { name: 'koja-old', archived: true },
            { name: 'koja-docs', archived: false }
          ]
        } as never
      }
      if (url.endsWith('/actions/secrets/FORUM_COOKIE')) {
        return {
          status: url.includes('/koja-fishing/') ? 200 : 404
        } as never
      }
      if (url.endsWith('/actions/secrets/public-key')) {
        return { data: { key: publicKey, key_id: 'kid' } } as never
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    const putMock = jest
      .spyOn(axios, 'put')
      .mockResolvedValue({ status: 204 } as never)

    const updated = await syncSecrets({
      token: 'pat',
      owner: 'Koja-Scripts',
      secrets: { FORUM_COOKIE: 'new-cookie', SECRETS_PAT: 'pat' },
      marker: 'FORUM_COOKIE'
    })

    expect(updated).toEqual(['uploader', 'koja-fishing'])
    expect(putMock).toHaveBeenCalledTimes(4)
    expect(putMock).toHaveBeenCalledWith(
      `${API}/repos/Koja-Scripts/koja-fishing/actions/secrets/FORUM_COOKIE`,
      expect.objectContaining({ key_id: 'kid' }),
      expect.anything()
    )
  })

  it('updates every non-archived repository with all', async () => {
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith(`${API}/orgs/Koja-Scripts/repos`)) {
        return {
          data: [
            { name: 'uploader', archived: false },
            { name: 'koja-new', archived: false },
            { name: 'koja-old', archived: true }
          ]
        } as never
      }
      if (url.endsWith('/actions/secrets/public-key')) {
        return { data: { key: publicKey, key_id: 'kid' } } as never
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    jest.spyOn(axios, 'put').mockResolvedValue({ status: 204 } as never)

    const updated = await syncSecrets({
      token: 'pat',
      owner: 'Koja-Scripts',
      secrets: { FORUM_COOKIE: 'new-cookie' },
      marker: 'FORUM_COOKIE',
      all: true
    })

    expect(updated).toEqual(['uploader', 'koja-new'])
  })

  it('reports a repository it cannot write and carries on', async () => {
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith(`${API}/orgs/Koja-Scripts/repos`)) {
        return {
          data: [
            { name: 'uploader', archived: false },
            { name: 'koja-fishing', archived: false }
          ]
        } as never
      }
      if (url.endsWith('/actions/secrets/FORUM_COOKIE')) {
        return { status: 200 } as never
      }
      if (url.includes('/uploader/actions/secrets/public-key')) {
        throw new Error('forbidden')
      }
      return { data: { key: publicKey, key_id: 'kid' } } as never
    })
    jest.spyOn(axios, 'put').mockResolvedValue({ status: 204 } as never)

    const updated = await syncSecrets({
      token: 'pat',
      owner: 'Koja-Scripts',
      secrets: { FORUM_COOKIE: 'new-cookie' },
      marker: 'FORUM_COOKIE'
    })

    expect(updated).toEqual(['koja-fishing'])
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Secrets not updated in: uploader')
    )
  })
})
