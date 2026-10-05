/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as main from '../src/main'
import * as auth from '../src/auth'
import * as hexel from '../src/hexel'

// Mock the action's main function
const runMock = jest.spyOn(main, 'run')

// Mock the GitHub Actions core library
let infoMock: jest.SpiedFunction<typeof core.info>
let getInputMock: jest.SpiedFunction<typeof core.getInput>
let getPortalCookiesMock: jest.SpiedFunction<typeof auth.getPortalCookies>

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    jest.spyOn(core, 'debug').mockImplementation()
    infoMock = jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()
    getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
    getPortalCookiesMock = jest
      .spyOn(auth, 'getPortalCookies')
      .mockResolvedValue('session=abc123')
  })

  it('should fail if chunkSize is not a number', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return 'invalid'
        default:
          return ''
      }
    })

    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(runMock).toHaveReturned()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid chunk size. Must be a number.'
    )
    expect(getPortalCookiesMock).not.toHaveBeenCalled()
  })

  it('should fail if maxRetries is not a number', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return 'invalid'
        default:
          return ''
      }
    })

    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      'Invalid max retries. Must be a number.'
    )
  })

  it('should authenticate and skip upload when skipUpload is set', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '3'
        case 'skipUpload':
          return 'true'
        case 'cookie':
          return 'forum-cookie'
        default:
          return ''
      }
    })

    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(getPortalCookiesMock).toHaveBeenCalledWith('forum-cookie', 3)
    expect(infoMock).toHaveBeenCalledWith(
      'Authenticated with CFX Portal. Skipping upload ...'
    )
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('should surface a failed authentication as a failed run', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '3'
        case 'skipUpload':
          return 'true'
        case 'cookie':
          return 'bad-cookie'
        default:
          return ''
      }
    })

    getPortalCookiesMock.mockRejectedValue(new Error('auth blew up'))
    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith('auth blew up')
  })

  it('publishes only to Hexel without needing a CFX cookie', async () => {
    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '3'
        case 'hexel':
          return 'product: carmarket'
        case 'hexelSecret':
          return 'secret'
        default:
          return ''
      }
    })
    const publishMock = jest.spyOn(hexel, 'publishToHexel').mockResolvedValue()
    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(getPortalCookiesMock).not.toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledWith(
      { product: 'carmarket', category: undefined, author: 'Hexel' },
      expect.objectContaining({ releaseCandidate: expect.any(Boolean) }),
      'secret'
    )
  })

  it('uploads a release as a new portal version', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-main-'))
    const zipPath = path.join(tmp, 'asset.zip')
    fs.writeFileSync(zipPath, Buffer.alloc(1500))
    const eventPath = path.join(tmp, 'event.json')
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ release: { tag_name: '1.2.0', body: 'Notes' } })
    )
    process.env.GITHUB_WORKSPACE = tmp
    process.env.GITHUB_EVENT_PATH = eventPath

    getInputMock.mockImplementation(name => {
      switch (name) {
        case 'chunkSize':
          return '1000'
        case 'maxRetries':
          return '3'
        case 'cookie':
          return 'forum-cookie'
        case 'assetId':
          return '42'
        case 'zipPath':
          return zipPath
        default:
          return ''
      }
    })

    const existing = {
      id: 1,
      version: '1.0.0',
      state: 'active',
      created_at: '2026-01-01'
    }
    const uploaded = { ...existing, id: 7, version: '1.2.0' }
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { versions: [existing] } } as never)
      .mockResolvedValueOnce({
        data: { versions: [existing, uploaded] }
      } as never)
    const postMock = jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: { asset_id: 42, version_id: 7, errors: null }
      } as never)
      .mockResolvedValue({ data: {} } as never)
    const setFailedMock = jest.spyOn(core, 'setFailed')

    await main.run()

    expect(setFailedMock).not.toHaveBeenCalled()
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      'https://portal-api.cfx.re/v1/assets/42/re-upload',
      expect.objectContaining({
        chunk_count: 2,
        version: '1.2.0',
        changelog: 'Notes',
        release_candidate: false
      }),
      expect.anything()
    )
    expect(postMock).toHaveBeenLastCalledWith(
      'https://portal-api.cfx.re/v1/assets/42/versions/7/complete-upload',
      {},
      expect.anything()
    )
    expect(postMock).toHaveBeenCalledTimes(4)

    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.GITHUB_EVENT_PATH
  })
})
