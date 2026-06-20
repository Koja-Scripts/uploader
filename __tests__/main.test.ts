/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as core from '@actions/core'
import * as main from '../src/main'
import * as auth from '../src/auth'

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
})
