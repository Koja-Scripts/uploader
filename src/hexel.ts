import * as core from '@actions/core'
import axios from 'axios'
import FormData from 'form-data'
import fs from 'fs'

import { HexelConfig, VersionMeta } from './types'
import { createOpenSourceVersion, deleteIfExists } from './utils'

export const HEXEL_UPLOAD_URL =
  'https://hexelstore.com/api/admin/uploads/download'

/**
 * Parses the `hexel` input: JSON or simple `key: value` lines.
 * @param input The raw input.
 * @returns {HexelConfig | null} The config, or null when the input is empty.
 */
export function parseHexelConfig(input: string): HexelConfig | null {
  if (!input.trim()) {
    return null
  }

  let raw: Record<string, string>
  try {
    raw = JSON.parse(input) as Record<string, string>
  } catch {
    raw = {}
    for (const line of input.split('\n')) {
      const match = line.match(/^\s*(\w+):\s*(.*)$/)
      if (match) {
        raw[match[1]] = match[2].replace(/["']/g, '').trim()
      }
    }
  }

  if (!raw.product) {
    throw new Error('The hexel config needs a `product` (Hexel store slug).')
  }

  return {
    product: raw.product,
    category: raw.category || undefined,
    author: raw.author || 'Hexel',
    resource: raw.resource || undefined
  }
}

/**
 * The Hexel store only takes `X.Y.Z` versions: "1.5" becomes "1.5.0" and
 * "v3" becomes "3.0.0".
 * @param version The release version.
 * @returns {string | null} The semver, or null when there is no number.
 */
export function toSemver(version: string): string | null {
  const match = version
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/)

  return match
    ? `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4]}`
    : null
}

/**
 * Builds the open-source pack with the Hexel author and publishes it as a
 * download (with changelog) on the Hexel store product.
 * @param config The Hexel config.
 * @param meta The release metadata.
 * @param secret The Hexel store API secret (PROJECT_API_SECRET).
 */
export async function publishToHexel(
  config: HexelConfig,
  meta: VersionMeta,
  secret: string
): Promise<void> {
  if (!secret) {
    throw new Error(
      'The hexel config is set but hexelSecret is empty. Add the Hexel store ' +
        'API secret (e.g. HEXEL_API_SECRET) to this repository.'
    )
  }

  if (meta.releaseCandidate) {
    core.info('⏭️ Release candidate — not publishing it to the Hexel store.')
    return
  }

  const semver = toSemver(meta.version)
  if (!semver) {
    throw new Error(
      `Version "${meta.version}" has no number the Hexel store can use.`
    )
  }

  core.info(`📦 Building the Hexel pack for "${config.product}"...`)
  deleteIfExists('open-source/')
  const zipPath = await createOpenSourceVersion(
    config.product,
    meta.version,
    config.author,
    config.resource
  )

  const form = new FormData()
  form.append('file', fs.createReadStream(zipPath), {
    filename: `${config.product}.zip`,
    contentType: 'application/zip'
  })
  form.append('productSlug', config.product)
  form.append('version', `v${semver}`)
  form.append('changelog', meta.changelog)
  if (config.category) {
    form.append('categorySlug', config.category)
  }

  core.info(`🚀 Publishing v${semver} to the Hexel store...`)
  const response = await axios.post<{
    fileName?: string
    prunedVersions?: number
  }>(HEXEL_UPLOAD_URL, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${secret}` },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  })

  core.info(
    `✅ Hexel store: ${response.data.fileName ?? 'uploaded'}` +
      (response.data.prunedVersions
        ? ` (removed ${response.data.prunedVersions} old version(s))`
        : '')
  )
}
