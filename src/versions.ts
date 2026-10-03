import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

import { AssetDetail, AssetVersion, ReleaseEvent, VersionMeta } from './types'
import { getEnv, getUrl } from './utils'

/**
 * The portal keeps at most this many versions per asset. Re-uploading past
 * the limit is rejected, so a slot has to be freed before every upload.
 */
export const PORTAL_MAX_VERSIONS = 5

/**
 * Reads the `release` object from the GitHub event payload.
 * @returns The release (empty when not a release event or unreadable).
 */
export function getReleaseEvent(): ReleaseEvent {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    return {}
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
      release?: ReleaseEvent
    }
    return event.release || {}
  } catch {
    core.debug('Could not parse the GitHub event payload.')
    return {}
  }
}

/**
 * Reads the `version '...'` field from the workspace fxmanifest.lua.
 */
function readManifestVersion(): string | undefined {
  try {
    const manifest = path.join(getEnv('GITHUB_WORKSPACE'), 'fxmanifest.lua')
    const content = fs.readFileSync(manifest, 'utf8')
    return content.match(/^\s*version\s+['"`]([^'"`]+)['"`]/m)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Works out the version number, changelog and release-candidate flag for the
 * upload. Explicit inputs win; otherwise everything comes from the GitHub
 * release, so existing workflows need no new inputs.
 *
 * Runs that are not tied to a tag (e.g. workflow_dispatch) get a
 * `<manifest version>-dev.<sha>` version flagged as release candidate, so a
 * test build never collides with or replaces a real release.
 * @returns {VersionMeta} The metadata sent with the re-upload request.
 */
export function resolveVersionMeta(): VersionMeta {
  const release = getReleaseEvent()
  const tag =
    release.tag_name ||
    (process.env.GITHUB_REF_TYPE === 'tag'
      ? process.env.GITHUB_REF_NAME
      : undefined)

  let version = core.getInput('version').trim()
  let devBuild = false

  if (!version && tag) {
    version = tag
  } else if (!version) {
    const base = readManifestVersion() || '0.0.0'
    const sha = (process.env.GITHUB_SHA || '').slice(0, 7)
    version = sha ? `${base}-dev.${sha}` : base
    devBuild = true
    core.warning(
      `Not a release/tag run — uploading as development version "${version}" (release candidate).`
    )
  }

  const rcInput = core.getInput('releaseCandidate').trim().toLowerCase()
  const releaseCandidate =
    rcInput === 'true' ||
    (rcInput !== 'false' && (release.prerelease === true || devBuild))

  const changelog =
    core.getInput('changelog').trim() ||
    release.body?.trim() ||
    process.env.RELEASE_BODY?.trim() ||
    `Release ${version}`

  return { version, changelog, releaseCandidate }
}

/**
 * Fetches all versions of an asset.
 * @param assetId The ID of the asset.
 * @param cookies The portal session cookies.
 * @returns {Promise<AssetVersion[]>} The asset's versions.
 */
export async function getAssetVersions(
  assetId: string,
  cookies: string
): Promise<AssetVersion[]> {
  const response = await axios.get<AssetDetail>(
    getUrl('ASSET_DETAIL', { id: assetId }),
    { headers: { Cookie: cookies } }
  )

  return response.data.versions ?? []
}

/**
 * Deletes a single version of an asset.
 * @param assetId The ID of the asset.
 * @param version The version to delete.
 * @param cookies The portal session cookies.
 */
export async function deleteAssetVersion(
  assetId: string,
  version: AssetVersion,
  cookies: string
): Promise<void> {
  core.info(`🗑️ Deleting version "${version.version}" (id ${version.id})...`)

  await axios.delete(
    getUrl('DELETE_VERSION', { id: assetId, version_id: version.id }),
    { headers: { Cookie: cookies } }
  )
}

function byAge(a: AssetVersion, b: AssetVersion): number {
  const diff = Date.parse(a.created_at) - Date.parse(b.created_at)
  return isNaN(diff) || diff === 0 ? a.id - b.id : diff
}

/**
 * The newest live stable version (or, failing that, the newest version) is
 * never pruned, so customers always keep a working download.
 */
export function getProtectedVersionId(
  versions: AssetVersion[]
): number | undefined {
  const sorted = [...versions].sort(byAge)
  const stable = sorted.filter(
    v => v.state === 'active' && !v.is_release_candidate
  )

  return (stable.at(-1) ?? sorted.at(-1))?.id
}

/**
 * Picks the oldest versions to delete so that at most `limit` remain.
 * @param versions The asset's current versions.
 * @param limit How many versions may remain.
 * @param keepIds Version IDs that must never be deleted.
 * @returns {AssetVersion[]} The versions to delete, oldest first.
 */
export function selectVersionsToPrune(
  versions: AssetVersion[],
  limit: number,
  keepIds: (number | undefined)[]
): AssetVersion[] {
  const excess = versions.length - limit
  if (excess <= 0) {
    return []
  }

  return [...versions]
    .sort(byAge)
    .filter(v => !keepIds.includes(v.id))
    .slice(0, excess)
}

/**
 * Makes room for a new version before uploading: replaces an existing
 * version with the same number (e.g. a re-run of a failed release) and
 * deletes the oldest versions when the portal limit is reached.
 * @param assetId The ID of the asset.
 * @param version The version number about to be uploaded.
 * @param cookies The portal session cookies.
 */
export async function prepareVersionSlot(
  assetId: string,
  version: string,
  cookies: string
): Promise<void> {
  let versions = await getAssetVersions(assetId, cookies)
  core.info(
    `📚 Asset ${assetId} has ${versions.length}/${PORTAL_MAX_VERSIONS} versions: ` +
      (versions.map(v => v.version).join(', ') || 'none')
  )

  for (const existing of versions.filter(v => v.version === version)) {
    if (versions.length <= 1) {
      throw new Error(
        `Version "${version}" already exists on asset ${assetId} and is its only ` +
          'version, so it cannot be replaced (the portal must keep at least one). ' +
          'Use a new release tag or set the `version` input.'
      )
    }

    core.warning(
      `Version "${version}" already exists (state: ${existing.state}) — replacing it.`
    )
    await deleteAssetVersion(assetId, existing, cookies)
    versions = versions.filter(v => v.id !== existing.id)
  }

  const toDelete = selectVersionsToPrune(versions, PORTAL_MAX_VERSIONS - 1, [
    getProtectedVersionId(versions)
  ])
  for (const old of toDelete) {
    core.info(`🧹 Version limit reached, removing the oldest version.`)
    await deleteAssetVersion(assetId, old, cookies)
  }
}

/**
 * Polls the portal until the uploaded version is processed (escrowed).
 * @param assetId The ID of the asset.
 * @param versionId The ID of the uploaded version.
 * @param cookies The portal session cookies.
 * @param timeoutSeconds How long to wait; 0 skips waiting.
 * @param pollMs Delay between polls.
 * @returns {Promise<AssetVersion[] | undefined>} The asset's versions once
 *   the upload is active, or undefined when waiting was skipped or timed out.
 * @throws If the portal marks the version as failed.
 */
export async function waitForVersion(
  assetId: string,
  versionId: number,
  cookies: string,
  timeoutSeconds: number,
  pollMs = 5000
): Promise<AssetVersion[] | undefined> {
  if (timeoutSeconds <= 0) {
    return undefined
  }

  core.info('⏳ Waiting for the portal to process the upload...')
  const deadline = Date.now() + timeoutSeconds * 1000

  for (;;) {
    const versions = await getAssetVersions(assetId, cookies)
    const state = versions.find(v => v.id === versionId)?.state ?? 'missing'

    if (state === 'active') {
      core.info('✅ New version is live on the portal.')
      return versions
    }

    if (/fail|error|reject/i.test(state)) {
      throw new Error(
        `The portal failed to process version ${versionId} (state: ${state}). ` +
          'Check the asset on portal.cfx.re.'
      )
    }

    if (Date.now() >= deadline) {
      core.warning(
        `Version ${versionId} is still "${state}" after ${timeoutSeconds}s. ` +
          'The portal keeps processing it in the background — check portal.cfx.re.'
      )
      return undefined
    }

    core.debug(`Version ${versionId} state: ${state}`)
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

/**
 * Deletes the oldest versions so at most `keepVersions` remain, never
 * touching the freshly uploaded one.
 * @param assetId The ID of the asset.
 * @param versions The asset's versions after the upload.
 * @param newVersionId The ID of the uploaded version.
 * @param keepVersions How many versions to keep.
 * @param cookies The portal session cookies.
 */
export async function pruneVersions(
  assetId: string,
  versions: AssetVersion[],
  newVersionId: number,
  keepVersions: number,
  cookies: string
): Promise<void> {
  const toDelete = selectVersionsToPrune(versions, keepVersions, [
    newVersionId,
    getProtectedVersionId(versions)
  ])

  for (const old of toDelete) {
    await deleteAssetVersion(assetId, old, cookies)
  }
}
