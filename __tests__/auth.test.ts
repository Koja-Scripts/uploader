/**
 * Unit tests for the SSO / cookie acquisition, src/auth.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import puppeteer from 'puppeteer'
import { getPortalCookies } from '../src/auth'

const SSO_INIT = 'https://portal-api.cfx.re/v1/auth/discourse?return='
const SSO_CALLBACK = 'https://portal-api.cfx.re/v1/auth/discourse'
const ME = 'https://portal-api.cfx.re/v1/me'
const FORUM_SSO = 'https://forum.cfx.re/session/sso_provider?sso=x&sig=y'
const PORTAL_AUTHENTICATE = 'https://portal.cfx.re/authenticate?sso=abc&sig=def'

describe('getPortalCookies', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()
    delete process.env.RUNNER_TEMP
  })

  function mockSsoChain(meStatus: number): jest.SpyInstance {
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url === SSO_INIT) {
        return {
          status: 200,
          headers: { 'set-cookie': ['sso-nonce=n; Path=/; Secure'] },
          data: { url: FORUM_SSO }
        } as never
      }
      if (url === FORUM_SSO) {
        return {
          status: 302,
          headers: { location: PORTAL_AUTHENTICATE },
          data: ''
        } as never
      }
      if (url === ME) {
        return { status: meStatus, headers: {}, data: {} } as never
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    return jest.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': ['jwt=xyz789; Path=/; Secure; HttpOnly'] },
      data: ''
    } as never)
  }

  it('walks the SSO redirect chain over HTTP and returns portal cookies', async () => {
    const postMock = mockSsoChain(200)

    const cookies = await getPortalCookies('forum-cookie', 3)

    expect(postMock).toHaveBeenCalledWith(
      SSO_CALLBACK,
      { sso: 'abc', sig: 'def' },
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: expect.stringContaining('sso-nonce=n')
        })
      })
    )
    expect(cookies).toContain('jwt=xyz789')
    expect(core.info).toHaveBeenCalledWith('✅ HTTP-SSO succeeded')
  })

  it('does not report success when the portal session is not valid', async () => {
    mockSsoChain(401)
    jest
      .spyOn(puppeteer, 'launch')
      .mockRejectedValue(new Error('launch disabled in test') as never)

    await expect(getPortalCookies('forum-cookie', 1)).rejects.toThrow()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Portal session check failed with status 401')
    )
  })

  it('falls back to Puppeteer when HTTP-SSO fails', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('network down'))
    const launchMock = jest
      .spyOn(puppeteer, 'launch')
      .mockRejectedValue(new Error('launch disabled in test') as never)

    await expect(getPortalCookies('forum-cookie', 1)).rejects.toThrow()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('HTTP-SSO failed, falling back to Puppeteer')
    )
    expect(launchMock).toHaveBeenCalled()
  })
})
