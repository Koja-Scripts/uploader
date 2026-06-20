import { Browser, getInstalledBrowsers, install } from '@puppeteer/browsers'
import { homedir } from 'os'
import { join } from 'path'

import * as core from '@actions/core'
import axios from 'axios'
import puppeteer, { Browser as PuppeteerBrowser, Page } from 'puppeteer'
import { Cookie, CookieJar } from 'tough-cookie'

import { SSOResponseBody } from './types'
import { getUrl } from './utils'

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const API_ORIGIN = 'https://portal-api.cfx.re/v1/'
const PORTAL_HOST = 'portal.cfx.re'

/**
 * Obtain the CFX Portal session cookies needed for the upload API.
 *
 * Primary path is a plain-HTTP walk of the Discourse SSO redirect chain (no
 * browser). If that fails for any reason it falls back to the legacy Puppeteer
 * flow so a release can never break while the HTTP path is being proven.
 *
 * @param forumCookie The forum `_t` cookie value (from forum.cfx.re).
 * @param maxRetries Retry budget for the Puppeteer fallback navigation.
 * @returns The `name=value; ...` cookie header string for portal-api.cfx.re.
 */
export async function getPortalCookies(
  forumCookie: string,
  maxRetries: number
): Promise<string> {
  try {
    const cookies = await getCookiesViaHttp(forumCookie)
    core.info('✅ HTTP-SSO succeeded')
    return cookies
  } catch (error) {
    core.warning(
      `HTTP-SSO failed, falling back to Puppeteer: ${(error as Error).message}`
    )
    return getCookiesViaPuppeteer(forumCookie, maxRetries)
  }
}

/**
 * Perform a single GET without following redirects, applying and capturing
 * cookies through the provided jar.
 */
async function jarGet(
  url: string,
  jar: CookieJar
): Promise<{ status: number; location?: string; data: unknown }> {
  const cookieHeader = await jar.getCookieString(url)
  const res = await axios.get(url, {
    maxRedirects: 0,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/html, */*',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    // Treat 3xx as success so we can follow redirects ourselves.
    validateStatus: status => status >= 200 && status < 400
  })

  const setCookies = (res.headers['set-cookie'] as string[] | undefined) ?? []
  for (const raw of setCookies) {
    try {
      await jar.setCookie(raw, url)
    } catch {
      // Ignore cookies that don't apply to this URL (domain/path mismatch).
    }
  }

  const location = res.headers['location'] as string | undefined
  return { status: res.status, location, data: res.data }
}

/**
 * Walk the Discourse SSO redirect chain over plain HTTP and collect the
 * resulting portal session cookies.
 */
async function getCookiesViaHttp(forumCookie: string): Promise<string> {
  const jar = new CookieJar()

  // Seed the forum auth cookie so the SSO provider authenticates us.
  await jar.setCookie(
    new Cookie({
      key: '_t',
      value: forumCookie,
      domain: 'forum.cfx.re',
      path: '/',
      secure: true,
      httpOnly: true
    }),
    'https://forum.cfx.re/'
  )

  // 1. Ask portal-api for the Discourse SSO provider URL (may set a nonce cookie).
  const init = await jarGet(getUrl('SSO'), jar)
  const body = init.data as SSOResponseBody
  if (!body || typeof body.url !== 'string') {
    throw new Error('SSO init did not return a redirect URL')
  }

  // 2. Follow the redirect chain, carrying cookies across domains, until we
  //    land on the portal (the session cookie is set during the callback).
  let nextUrl: string | undefined = body.url
  for (let hop = 0; hop < 12 && nextUrl; hop++) {
    const res = await jarGet(nextUrl, jar)

    if (res.status >= 300 && res.status < 400 && res.location) {
      nextUrl = new URL(res.location, nextUrl).toString()
      if (new URL(nextUrl).hostname === PORTAL_HOST) {
        // Final hop is to the portal app; the API cookie is already set.
        break
      }
      continue
    }
    break
  }

  const cookies = await jar.getCookieString(API_ORIGIN)
  if (!cookies.includes('=')) {
    throw new Error('No portal session cookies obtained via HTTP-SSO')
  }
  return cookies
}

// ---------------------------------------------------------------------------
// Puppeteer fallback (legacy flow). Kept until HTTP-SSO is proven on real runs.
// ---------------------------------------------------------------------------

/**
 * Obtain portal cookies by driving a headless Chrome through the SSO flow.
 */
async function getCookiesViaPuppeteer(
  forumCookie: string,
  maxRetries: number
): Promise<string> {
  await ensureChrome()

  const chromePath = findSystemChrome()
  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-default-apps'
    ]
  }
  if (chromePath) {
    launchOptions.executablePath = chromePath
    core.info(`Using Chrome executable: ${chromePath}`)
  }

  const browser = await puppeteer.launch(launchOptions)
  try {
    const page = await browser.newPage()

    const redirectUrl = await getRedirectUrl(page, maxRetries)
    await setForumCookie(browser, forumCookie)

    await page.goto(redirectUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    })
    await new Promise(resolve => setTimeout(resolve, 3000))

    if (!page.url().includes(PORTAL_HOST)) {
      throw new Error(
        `Redirect failed. Current URL: ${page.url()}. Make sure the provided Cookie is valid and not expired.`
      )
    }

    return await browser
      .cookies()
      .then(cookies =>
        cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      )
  } finally {
    await browser.close()
  }
}

/**
 * Look for a system-installed Chrome (present on GitHub-hosted runners).
 */
function findSystemChrome(): string | undefined {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    process.env.CHROME_BIN
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      // Lazy require keeps this testable without fs mocks elsewhere.
      const fs = require('fs')
      if (fs.existsSync(candidate)) {
        core.info(`Found Chrome at: ${candidate}`)
        return candidate
      }
    } catch {
      // ignore
    }
  }
  return undefined
}

/**
 * Download Chrome via Puppeteer only when no system Chrome is available.
 */
async function ensureChrome(): Promise<void> {
  if (process.env.RUNNER_TEMP === undefined) {
    return
  }
  if (findSystemChrome()) {
    return
  }

  try {
    const cacheDir = join(homedir(), '.cache', 'puppeteer')
    const installed = await getInstalledBrowsers({ cacheDir })
    const chromeInstalled = installed.some(b => b.browser === Browser.CHROME)
    if (!chromeInstalled) {
      core.info('Installing Chrome via Puppeteer (fallback)...')
      await install({
        cacheDir,
        browser: Browser.CHROME,
        buildId: '131.0.6778.204'
      })
      core.info('Chrome installation completed')
    }
  } catch (error) {
    core.warning(`Chrome installation failed: ${(error as Error).message}`)
  }
}

/**
 * Navigate to the SSO URL and return the redirect URL, retrying on failure.
 */
async function getRedirectUrl(page: Page, maxRetries: number): Promise<string> {
  let attempt = 0
  while (attempt < maxRetries) {
    try {
      await page.goto(getUrl('SSO'), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })

      const responseBody = await page.evaluate(
        () => JSON.parse(document.body.innerText) as SSOResponseBody
      )
      const redirectUrl = responseBody.url
      const forumUrl = new URL(redirectUrl).origin
      await page.goto(forumUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      })
      return redirectUrl
    } catch {
      core.info(
        `⚠️ SSO navigation failed, retrying... (${attempt + 1}/${maxRetries})`
      )
      await new Promise(resolve => setTimeout(resolve, 1000))
      attempt++
    }
  }
  throw new Error(`Failed to navigate to SSO URL after ${maxRetries} attempts.`)
}

/**
 * Set the forum `_t` cookie in the browser.
 */
async function setForumCookie(
  browser: PuppeteerBrowser,
  forumCookie: string
): Promise<void> {
  core.info('Setting cookies ...')
  await browser.setCookie({
    name: '_t',
    value: forumCookie,
    domain: 'forum.cfx.re',
    path: '/',
    expires: -1,
    size: 1,
    httpOnly: true,
    secure: true,
    session: false
  })
  core.info('Cookies set. Following redirect...')
}
