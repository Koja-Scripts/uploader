/**
 * Unit tests for saving the rotated forum cookie and failure alerts, src/main.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import * as auth from '../src/auth'
import * as secrets from '../src/secrets'
import * as main from '../src/main'

let inputs: Record<string, string>

describe('forum cookie sync', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(core, 'debug').mockImplementation()
    jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()
    jest.spyOn(core, 'setSecret').mockImplementation()
    jest.spyOn(core, 'getInput').mockImplementation(name => inputs[name] ?? '')
    process.env.GITHUB_REPOSITORY = 'Koja-Scripts/koja-fishing'
    process.env.GITHUB_REPOSITORY_OWNER = 'Koja-Scripts'

    inputs = {
      chunkSize: '1024',
      maxRetries: '3',
      skipUpload: 'true',
      cookie: 'old-cookie'
    }
  })

  function login(forumCookie: string): void {
    jest
      .spyOn(auth, 'getPortalCookies')
      .mockResolvedValue({ cookies: 'jwt=1', forumCookie })
  }

  it('writes a rotated cookie to the other repositories', async () => {
    inputs.githubToken = 'pat'
    login('new-cookie')
    const syncMock = jest.spyOn(secrets, 'syncSecrets').mockResolvedValue([])

    await main.run()

    expect(core.setSecret).toHaveBeenCalledWith('new-cookie')
    expect(syncMock).toHaveBeenCalledWith({
      token: 'pat',
      owner: 'Koja-Scripts',
      secrets: { FORUM_COOKIE: 'new-cookie' },
      marker: 'FORUM_COOKIE'
    })
  })

  it('does nothing when the cookie did not rotate', async () => {
    inputs.githubToken = 'pat'
    login('old-cookie')
    const syncMock = jest.spyOn(secrets, 'syncSecrets').mockResolvedValue([])

    await main.run()

    expect(syncMock).not.toHaveBeenCalled()
  })

  it('shares the token and the cookie even without a rotation', async () => {
    inputs.githubToken = 'pat'
    inputs.shareTokenAs = 'SECRETS_PAT'
    login('old-cookie')
    const syncMock = jest.spyOn(secrets, 'syncSecrets').mockResolvedValue([])

    await main.run()

    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { FORUM_COOKIE: 'old-cookie', SECRETS_PAT: 'pat' }
      })
    )
  })

  it('warns when the cookie rotated and there is no token to save it', async () => {
    login('new-cookie')
    const syncMock = jest.spyOn(secrets, 'syncSecrets')

    await main.run()

    expect(syncMock).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('no githubToken is set')
    )
  })

  it('fails a refresh run whose sync fails and alerts Discord', async () => {
    inputs.githubToken = 'pat'
    inputs.alertWebhook = 'https://discord.test/webhook'
    login('new-cookie')
    jest.spyOn(secrets, 'syncSecrets').mockRejectedValue(new Error('bad token'))
    const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
    const postMock = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 204 } as never)

    await main.run()

    expect(setFailedMock).toHaveBeenCalledWith(
      'Could not sync FORUM_COOKIE: bad token'
    )
    expect(postMock).toHaveBeenCalledWith(
      'https://discord.test/webhook',
      expect.objectContaining({
        embeds: [
          expect.objectContaining({ title: '❌ Forum cookie refresh failed' })
        ]
      }),
      expect.anything()
    )
  })
})
