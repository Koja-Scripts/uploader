import * as core from '@actions/core'
import FormData from 'form-data'
import axios from 'axios'

import { createReadStream, statSync } from 'fs'
import { Agent } from 'https'
import { basename } from 'path'
import { ReUploadResponse, BuildOptions, VersionMeta, ZipPaths } from './types'
import { getPortalCookies } from './auth'
import { parseHexelConfig, publishToHexel } from './hexel'
import { syncSecrets } from './secrets'
import {
  PORTAL_MAX_VERSIONS,
  getReleaseEvent,
  prepareVersionSlot,
  pruneVersions,
  resolveVersionMeta,
  waitForVersion
} from './versions'
import {
  deleteIfExists,
  resolveAssetId,
  getEnv,
  getUrl,
  zipAsset,
  createVersions,
  createHQVersion,
  createLQVersion
} from './utils'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    let assetId = core.getInput('assetId')
    let assetName = core.getInput('assetName')

    let zipPath = core.getInput('zipPath')
    const makeZip = core.getInput('makeZip').toLowerCase() === 'true'
    const skipUpload = core.getInput('skipUpload').toLowerCase() === 'true'

    const escrowedInput = core.getInput('escrowed')
    const openSourceInput = core.getInput('openSource')

    const chunkSize = parseInt(core.getInput('chunkSize'))
    const maxRetries = parseInt(core.getInput('maxRetries'))

    if (isNaN(chunkSize)) {
      throw new Error('Invalid chunk size. Must be a number.')
    }

    if (isNaN(maxRetries)) {
      throw new Error('Invalid max retries. Must be a number.')
    }

    const keepVersions = parseInt(core.getInput('keepVersions') || '5')
    if (
      isNaN(keepVersions) ||
      keepVersions < 1 ||
      keepVersions > PORTAL_MAX_VERSIONS
    ) {
      throw new Error(
        `Invalid keepVersions. Must be a number from 1 to ${PORTAL_MAX_VERSIONS}.`
      )
    }

    const processingTimeout = parseInt(
      core.getInput('processingTimeout') || '120'
    )
    if (isNaN(processingTimeout) || processingTimeout < 0) {
      throw new Error('Invalid processingTimeout. Must be a number >= 0.')
    }

    // A repo sold only on the Hexel store has no CFX asset (and no cookie).
    const hexelConfig = parseHexelConfig(core.getInput('hexel'))
    const hexelSecret = core.getInput('hexelSecret')
    const cfxWanted =
      skipUpload ||
      !hexelConfig ||
      [
        'assetId',
        'assetName',
        'zipPath',
        'escrowed',
        'openSource',
        'hq',
        'lq'
      ].some(name => core.getInput(name))

    if (hexelConfig && !cfxWanted) {
      await publishToHexel(hexelConfig, resolveVersionMeta(), hexelSecret)
      await sendReleaseNotification()
      return
    }

    if (!assetId && !assetName && !skipUpload) {
      core.debug('No asset id or name provided, using repository name...')
      assetName = basename(getEnv('GITHUB_WORKSPACE'))
    }

    const cookieInput = core.getInput('cookie').trim()
    if (!cookieInput) {
      throw new Error(
        'No forum cookie provided. Check that the cookie secret (e.g. FORUM_COOKIE) is set and ' +
          'that this repository has access to it. (Heads-up: organization secrets ' +
          'are NOT available to private repositories on the GitHub Free plan.)'
      )
    }

    const session = await getPortalCookies(cookieInput, maxRetries)
    const cookies = session.cookies

    await storeForumCookie(cookieInput, session.forumCookie, skipUpload)

    if (skipUpload) {
      core.info('Authenticated with CFX Portal. Skipping upload ...')
      return
    }

    const meta = resolveVersionMeta()
    core.info(
      `🏷️ Version: ${meta.version}` +
        (meta.releaseCandidate ? ' (release candidate)' : '')
    )
    core.debug(`Changelog: ${meta.changelog}`)

    const ctx: UploadContext = {
      cookies,
      chunkSize,
      meta,
      keepVersions,
      processingTimeout
    }

    let escrowedConfig: any = null
    let openSourceConfig: any = null

    if (escrowedInput) {
      try {
        escrowedConfig = JSON.parse(escrowedInput)
      } catch {
        const lines = escrowedInput.split('\n').filter(line => line.trim())
        escrowedConfig = {}
        for (const line of lines) {
          const match = line.match(/^\s*(\w+):\s*(.+)$/)
          if (match) {
            const [, key, value] = match
            if (key === 'escrow_ignore') {
              if (value.includes('[') && value.includes(']')) {
                escrowedConfig[key] = value
                  .replace(/[\[\]'"`]/g, '')
                  .split(',')
                  .map(s => s.trim())
              } else {
                escrowedConfig[key] = value
                  .replace(/[\"']/g, '')
                  .split(',')
                  .map(s => s.trim())
              }
            } else {
              escrowedConfig[key] = value.replace(/[\"']/g, '').trim()
            }
          }
        }
      }
    }

    if (openSourceInput) {
      try {
        openSourceConfig = JSON.parse(openSourceInput)
      } catch {
        const lines = openSourceInput.split('\n').filter(line => line.trim())
        openSourceConfig = {}
        for (const line of lines) {
          const match = line.match(/^\s*(\w+):\s*(.+)$/)
          if (match) {
            const [, key, value] = match
            openSourceConfig[key] = value.replace(/[\"']/g, '').trim()
          }
        }
      }
    }

    const hqInput = core.getInput('hq')
    const lqInput = core.getInput('lq')

    let hqConfig: any = null
    let lqConfig: any = null

    if (hqInput) {
      try {
        hqConfig = JSON.parse(hqInput)
      } catch {
        const lines = hqInput.split('\n').filter(line => line.trim())
        hqConfig = {}
        for (const line of lines) {
          const match = line.match(/^\s*(\w+):\s*(.+)$/)
          if (match) {
            const [, key, value] = match
            if (key === 'escrow_ignore') {
              if (value.includes('[') && value.includes(']')) {
                hqConfig[key] = value
                  .replace(/[\[\]'"`]/g, '')
                  .split(',')
                  .map(s => s.trim())
              } else {
                hqConfig[key] = value
                  .replace(/[\"']/g, '')
                  .split(',')
                  .map(s => s.trim())
              }
            } else {
              hqConfig[key] = value.replace(/[\"']/g, '').trim()
            }
          }
        }
      }
    }

    if (lqInput) {
      try {
        lqConfig = JSON.parse(lqInput)
      } catch {
        const lines = lqInput.split('\n').filter(line => line.trim())
        lqConfig = {}
        for (const line of lines) {
          const match = line.match(/^\s*(\w+):\s*(.+)$/)
          if (match) {
            const [, key, value] = match
            if (key === 'escrow_ignore') {
              if (value.includes('[') && value.includes(']')) {
                lqConfig[key] = value
                  .replace(/[\[\]'"`]/g, '')
                  .split(',')
                  .map(s => s.trim())
              } else {
                lqConfig[key] = value
                  .replace(/[\"']/g, '')
                  .split(',')
                  .map(s => s.trim())
              }
            } else {
              lqConfig[key] = value.replace(/[\"']/g, '').trim()
            }
          }
        }
      }
    }

    const shouldCreateEscrowed = !!escrowedConfig
    const shouldCreateOpenSource = !!openSourceConfig
    const shouldCreateHQ = !!hqConfig
    const shouldCreateLQ = !!lqConfig

    const uploadTypes = []
    if (shouldCreateEscrowed) uploadTypes.push('escrowed')
    if (shouldCreateOpenSource) uploadTypes.push('open-source')
    if (shouldCreateHQ) uploadTypes.push('HQ')
    if (shouldCreateLQ) uploadTypes.push('LQ')
    core.info(`🚀 Uploading: ${uploadTypes.join(', ')}`)

    if (
      shouldCreateEscrowed ||
      shouldCreateOpenSource ||
      shouldCreateHQ ||
      shouldCreateLQ
    ) {
      const buildOptions: BuildOptions = {
        version: meta.version,
        createEscrowed: shouldCreateEscrowed,
        createOpenSource: shouldCreateOpenSource,
        createHq: shouldCreateHQ,
        createLq: shouldCreateLQ,
        escrowedConfig: escrowedConfig || undefined,
        openSourceConfig: openSourceConfig || undefined,
        hqConfig: hqConfig || undefined,
        lqConfig: lqConfig || undefined
      }

      const baseAssetName = assetName || basename(getEnv('GITHUB_WORKSPACE'))
      const zipPaths: ZipPaths = await createVersions(
        buildOptions,
        baseAssetName
      )

      if (zipPaths.escrowed && shouldCreateEscrowed) {
        let escrowedId: string

        if (escrowedConfig?.asset_id) {
          escrowedId = escrowedConfig.asset_id
        } else if (escrowedConfig?.asset_name) {
          escrowedId = await resolveAssetId(escrowedConfig.asset_name, cookies)
        } else {
          throw new Error('Escrowed config must include asset_id or asset_name')
        }

        core.info('🚀 Uploading escrowed version...')
        await uploadVersion(zipPaths.escrowed, escrowedId, ctx)
      }

      if (zipPaths.openSource && shouldCreateOpenSource) {
        let openSourceId: string

        if (openSourceConfig?.asset_id) {
          openSourceId = openSourceConfig.asset_id
        } else if (openSourceConfig?.asset_name) {
          openSourceId = await resolveAssetId(
            openSourceConfig.asset_name,
            cookies
          )
        } else {
          throw new Error(
            'OpenSource config must include asset_id or asset_name'
          )
        }

        core.info('🚀 Uploading open source version...')
        await uploadVersion(zipPaths.openSource, openSourceId, ctx)
      }

      let hqZipPath: string | null = null
      let hqId: string | null = null
      let lqZipPath: string | null = null
      let lqId: string | null = null

      if (shouldCreateHQ && hqConfig) {
        core.info('📦 Creating HQ version...')
        const hqBranch = hqConfig.branch || 'main'
        const hqIgnoreFiles = hqConfig.escrow_ignore || []
        hqZipPath = await createHQVersion(
          hqConfig.asset_name || `${baseAssetName}-hq`,
          hqBranch,
          hqIgnoreFiles
        )

        if (hqConfig.asset_id) {
          hqId = hqConfig.asset_id
        } else if (hqConfig.asset_name) {
          hqId = await resolveAssetId(hqConfig.asset_name, cookies)
        } else {
          const fallbackName = `${baseAssetName}-hq`
          hqId = await resolveAssetId(fallbackName, cookies)
        }
      }

      if (shouldCreateLQ && lqConfig) {
        core.info('📦 Creating LQ version...')
        const lqBranch = lqConfig.branch || 'low-quality'
        const lqIgnoreFiles = lqConfig.escrow_ignore || []
        lqZipPath = await createLQVersion(
          lqConfig.asset_name || `${baseAssetName}-lq`,
          lqBranch,
          lqIgnoreFiles
        )

        if (lqConfig.asset_id) {
          lqId = lqConfig.asset_id
        } else if (lqConfig.asset_name) {
          lqId = await resolveAssetId(lqConfig.asset_name, cookies)
        } else {
          const fallbackName = `${baseAssetName}-lq`
          lqId = await resolveAssetId(fallbackName, cookies)
        }
      }

      // Now upload both versions
      if (hqZipPath && hqId) {
        core.info('🚀 Uploading HQ version...')
        await uploadVersion(hqZipPath, hqId, ctx)
      }

      if (lqZipPath && lqId) {
        core.info('🚀 Uploading LQ version...')
        await uploadVersion(lqZipPath, lqId, ctx)
      }
    } else {
      // Original single upload logic
      if (assetName) {
        assetId = await resolveAssetId(assetName, cookies)
      }

      zipPath = await getZipPath(assetName, zipPath, makeZip)
      await uploadVersion(zipPath, assetId, ctx)
    }

    if (hexelConfig) {
      await publishToHexel(hexelConfig, meta, hexelSecret)
    }

    await sendReleaseNotification()
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const { status, statusText, data } = error.response
      const method = error.config?.method?.toUpperCase() ?? ''
      core.error(
        `Portal API ${method} ${error.config?.url} failed: ${status} ${statusText}`
      )
      core.error(`Response body: ${JSON.stringify(data)}`)

      const message = (data as { message?: unknown } | undefined)?.message
      const reason = typeof message === 'string' ? message : error.message
      core.setFailed(reason)
      await sendFailureAlert(reason)
    } else {
      const reason = error instanceof Error ? error.message : String(error)
      core.setFailed(reason)
      await sendFailureAlert(reason)
    }
  }
}

/**
 * Discourse rotates the forum `_t` token during the SSO walk and the old value
 * dies shortly after, which breaks every other repository holding a copy. With
 * a `githubToken` the new value is written back to every repository that has
 * the cookie secret, so the cookie never has to be pasted again.
 *
 * `shareTokenAs` also copies the token itself into those repositories, so a
 * single scheduled run can hand it to repos that do not have it yet.
 */
async function storeForumCookie(
  previous: string,
  current: string,
  strict: boolean
): Promise<void> {
  const rotated = current !== previous
  if (rotated) core.setSecret(current)

  const token = core.getInput('githubToken')
  const shareTokenAs = core.getInput('shareTokenAs')

  if (!token) {
    if (rotated) {
      core.warning(
        'The forum rotated the cookie, but no githubToken is set to save it. ' +
          'Other repositories holding the old cookie will stop authenticating.'
      )
    }
    return
  }

  if (!rotated && !shareTokenAs) {
    core.info('Forum cookie unchanged, nothing to sync.')
    return
  }

  const cookieSecret = core.getInput('cookieSecret') || 'FORUM_COOKIE'
  const secrets: Record<string, string> = { [cookieSecret]: current }
  if (shareTokenAs) secrets[shareTokenAs] = token

  try {
    await syncSecrets({
      token,
      owner:
        core.getInput('syncOwner') ||
        process.env.GITHUB_REPOSITORY_OWNER ||
        (process.env.GITHUB_REPOSITORY || '').split('/')[0],
      secrets,
      marker: cookieSecret
    })
  } catch (error) {
    const reason = `Could not sync ${cookieSecret}: ${(error as Error).message}`
    // A refresh-only run exists to keep the cookie alive, so it must fail
    // loudly. A release still uploads and only warns.
    if (strict) throw new Error(reason)
    core.warning(reason)
  }
}

/**
 * Post a failed run to a Discord webhook (`alertWebhook`), if configured.
 */
async function sendFailureAlert(reason: string): Promise<void> {
  const webhook = core.getInput('alertWebhook')
  if (!webhook) return

  const repository = process.env.GITHUB_REPOSITORY || 'unknown repository'
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined
  const refreshOnly = core.getInput('skipUpload').toLowerCase() === 'true'

  try {
    await axios.post(
      webhook,
      {
        username: 'Koja Uploader',
        embeds: [
          {
            title: refreshOnly
              ? '❌ Forum cookie refresh failed'
              : '❌ CFX Portal upload failed',
            description: `${reason.slice(0, 1500)}${
              refreshOnly
                ? '\n\nPaste a fresh `_t` cookie into FORUM_COOKIE of this repository and re-run the workflow.'
                : ''
            }`,
            url: runUrl,
            color: 0xe03131,
            fields: [
              { name: 'Repository', value: repository, inline: true },
              {
                name: 'Workflow',
                value: process.env.GITHUB_WORKFLOW || '-',
                inline: true
              }
            ],
            timestamp: new Date().toISOString()
          }
        ]
      },
      { timeout: 15000 }
    )
  } catch (error) {
    core.warning(`Failure alert not sent: ${(error as Error).message}`)
  }
}

interface UploadContext {
  cookies: string
  chunkSize: number
  meta: VersionMeta
  keepVersions: number
  processingTimeout: number
}

/**
 * Uploads a zip as a new version of an asset: frees a version slot, uploads,
 * waits for the portal to process it and prunes old versions if requested.
 * @param zipPath
 * @param assetId
 * @param ctx
 * @returns {Promise<void>} Resolves when the version is uploaded.
 */
async function uploadVersion(
  zipPath: string,
  assetId: string,
  ctx: UploadContext
): Promise<void> {
  await prepareVersionSlot(assetId, ctx.meta.version, ctx.cookies)

  const versionId = await uploadZip(
    zipPath,
    assetId,
    ctx.chunkSize,
    ctx.cookies,
    ctx.meta
  )

  const versions = await waitForVersion(
    assetId,
    versionId,
    ctx.cookies,
    ctx.processingTimeout
  )

  if (versions && ctx.keepVersions < PORTAL_MAX_VERSIONS) {
    await pruneVersions(
      assetId,
      versions,
      versionId,
      ctx.keepVersions,
      ctx.cookies
    )
  }
}

/**
 * Sends a release notification after a successful upload. The endpoint comes
 * from the `webhookUrl` input (or the `WEBHOOK_URL` env var) so the URL stays
 * in a secret rather than the repo. Reads the release details from the GitHub
 * event payload and falls back to runner env vars. Only fires on `release`
 * events and never throws — a failed notification must not fail the upload.
 * @returns {Promise<void>} Resolves once the notification attempt is done.
 */
async function sendReleaseNotification(): Promise<void> {
  if (process.env.GITHUB_EVENT_NAME !== 'release') {
    core.debug('Not a release event, skipping notification.')
    return
  }

  const webhookUrl =
    core.getInput('webhookUrl') || process.env.WEBHOOK_URL || ''
  if (!webhookUrl) {
    core.info('No webhook URL configured, skipping release notification.')
    return
  }

  try {
    const release = getReleaseEvent()

    const payload = {
      repository: process.env.GITHUB_REPOSITORY || '',
      description: release.body || process.env.RELEASE_BODY || '',
      version: release.tag_name || process.env.GITHUB_REF_NAME || '',
      author: release.author?.login || process.env.GITHUB_ACTOR || '',
      date: release.published_at || new Date().toISOString()
    }

    await axios.post(`${webhookUrl}/api/github/release`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      httpsAgent: new Agent({ rejectUnauthorized: false })
    })

    core.info('📣 Release notification sent.')
  } catch (error) {
    core.warning(
      `Release notification failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Retrieves the zipPath or creates a zip based on the provided parameters.
 * @param assetName - The name of the asset.
 * @param zipPath - The path to the zip file.
 * @param makeZip - Flag indicating whether to create a zip file.
 * @returns {Promise<string>} Resolves with the path to the zip file.
 * @throws If neither zipPath nor makeZip is provided, or if the pre-zip command fails.
 */
async function getZipPath(
  assetName: string,
  zipPath: string,
  makeZip: boolean
): Promise<string> {
  core.debug('Zip path: ' + JSON.stringify(zipPath))
  if (zipPath.length > 0) {
    core.debug('Using provided zip path.')
    return zipPath
  }

  if (!makeZip && zipPath.length == 0) {
    throw new Error(
      'Either zipPath or makeZip must be provided to upload a file.'
    )
  }

  core.info('Creating zip file ...')

  deleteIfExists('.git/')
  deleteIfExists('.github/')
  deleteIfExists('.vscode/')

  return zipAsset(assetName)
}

/**
 * Starts the re-upload process by uploading the asset in chunks.
 * @param zipPath
 * @param assetId
 * @param chunkSize
 * @param cookies
 * @param meta
 * @returns {Promise<[number, number]>} The asset and new version IDs.
 * @throws If the re-upload fails due to errors in the response.
 */
async function startReupload(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  meta: VersionMeta
): Promise<[number, number]> {
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)

  core.info('Starting upload ...')

  core.debug(`Total size: ${totalSize}`)
  core.debug(`Original file name: ${originalFileName}`)
  core.debug(`Chunk size: ${chunkSize}`)
  core.debug(`Chunk count: ${chunkCount}`)

  const reUploadReponse = await axios.post<ReUploadResponse>(
    getUrl('REUPLOAD', { id: assetId }),
    {
      chunk_count: chunkCount,
      chunk_size: chunkSize,
      name: originalFileName,
      original_file_name: originalFileName,
      total_size: totalSize,
      version: meta.version,
      changelog: meta.changelog,
      release_candidate: meta.releaseCandidate
    },
    {
      headers: {
        Cookie: cookies
      }
    }
  )

  if (reUploadReponse.data.errors !== null) {
    core.debug(JSON.stringify(reUploadReponse.data.errors))
    throw new Error(
      'Failed to re-upload file. See debug logs for more information.'
    )
  }

  return [reUploadReponse.data.asset_id, reUploadReponse.data.version_id]
}

/**
 * Uploads a zip file in chunks to the specified asset.
 * @param zipPath
 * @param assetId
 * @param chunkSize.
 * @param cookies
 * @param meta
 * @returns {Promise<number>} The ID of the uploaded version.
 * @throws If the upload fails at any stage.
 */
async function uploadZip(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  meta: VersionMeta
): Promise<number> {
  const [, versionId] = await startReupload(
    zipPath,
    assetId,
    chunkSize,
    cookies,
    meta
  )

  let chunkIndex = 0

  const stats = statSync(zipPath)
  const totalSize = stats.size
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const stream = createReadStream(zipPath, { highWaterMark: chunkSize })

  for await (const chunk of stream) {
    const form = new FormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await axios.post(
      getUrl('UPLOAD_CHUNK', { id: assetId, version_id: versionId }),
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: cookies
        }
      }
    )

    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)

    chunkIndex++
  }

  await completeUpload(assetId, versionId, cookies)

  return versionId
}

/**
 * Completes the upload process.
 * @param assetId
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 */
async function completeUpload(
  assetId: string,
  versionId: number,
  cookies: string
): Promise<void> {
  await axios.post(
    getUrl('COMPLETE_UPLOAD', { id: assetId, version_id: versionId }),
    {},
    {
      headers: {
        Cookie: cookies
      }
    }
  )

  core.info('Upload completed.')
}
