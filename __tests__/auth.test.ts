/**
 * Unit tests for the SSO / cookie acquisition, src/auth.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import puppeteer from 'puppeteer'
import { getPortalCookies } from '../src/auth'

const SSO_INIT = 'https://portal-api.cfx.re/v1/auth/discourse?return='
const FORUM_SSO = 'https://forum.cfx.re/session/sso_provider?sso=x&sig=y'
const PORTAL_CALLBACK =
  'https://portal-api.cfx.re/v1/auth/discourse/callback?sso=x&sig=y'

describe('getPortalCookies', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()
    delete process.env.RUNNER_TEMP
  })

  it('walks the SSO redirect chain over HTTP and returns portal cookies', async () => {
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url === SSO_INIT) {
        return { status: 200, headers: {}, data: { url: FORUM_SSO } } as never
      }
      if (url === FORUM_SSO) {
        return {
          status: 302,
          headers: { location: PORTAL_CALLBACK },
          data: ''
        } as never
      }
      if (url === PORTAL_CALLBACK) {
        return {
          status: 302,
          headers: {
            location: 'https://portal.cfx.re/',
            'set-cookie': ['session=xyz789; Path=/; Secure; HttpOnly']
          },
          data: ''
        } as never
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    const cookies = await getPortalCookies('forum-cookie', 3)

    expect(cookies).toContain('session=xyz789')
    expect(core.info).toHaveBeenCalledWith('✅ HTTP-SSO succeeded')
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
