import * as core from '@actions/core'
import axios from 'axios'
import sodium from 'libsodium-wrappers'

const GITHUB_API = 'https://api.github.com'

export interface SecretSyncOptions {
  /** Token with "Secrets: read and write" on the target repositories. */
  token: string
  /** Organization (or user) whose repositories are updated. */
  owner: string
  /** Secret names and the values to store under them. */
  secrets: Record<string, string>
  /**
   * Only repositories that already have this secret are updated, so repos that
   * never used the uploader are left alone. The current repository is always
   * included.
   */
  marker: string
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

/**
 * List every non-archived repository of the owner, trying the organization
 * endpoint first and the user endpoint second.
 */
async function listRepositories(
  token: string,
  owner: string
): Promise<string[]> {
  const repos: string[] = []

  for (const scope of ['orgs', 'users']) {
    try {
      for (let page = 1; ; page++) {
        const res = await axios.get(
          `${GITHUB_API}/${scope}/${owner}/repos?per_page=100&type=all&page=${page}`,
          { headers: headers(token) }
        )
        const batch = res.data as { name: string; archived: boolean }[]
        repos.push(...batch.filter(repo => !repo.archived).map(r => r.name))
        if (batch.length < 100) return repos
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) continue
      throw error
    }
  }

  return repos
}

async function hasSecret(
  token: string,
  owner: string,
  repo: string,
  name: string
): Promise<boolean> {
  const res = await axios.get(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/${name}`,
    { headers: headers(token), validateStatus: () => true }
  )
  return res.status === 200
}

/** Encrypt a value with the repository public key (libsodium sealed box). */
export async function encryptSecret(
  value: string,
  publicKey: string
): Promise<string> {
  await sodium.ready
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key)
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL)
}

async function writeSecrets(
  token: string,
  owner: string,
  repo: string,
  secrets: Record<string, string>
): Promise<void> {
  const keyRes = await axios.get(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: headers(token) }
  )
  const { key, key_id } = keyRes.data as { key: string; key_id: string }

  for (const [name, value] of Object.entries(secrets)) {
    await axios.put(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/${name}`,
      { encrypted_value: await encryptSecret(value, key), key_id },
      { headers: headers(token) }
    )
  }
}

/**
 * Write the given secrets to every repository of the owner that already has
 * the marker secret. A failing repository is reported and skipped so one
 * missing permission never blocks the rest.
 *
 * @returns The repositories that were updated.
 */
export async function syncSecrets(
  options: SecretSyncOptions
): Promise<string[]> {
  const { token, owner, secrets, marker } = options
  const current = (process.env.GITHUB_REPOSITORY || '').split('/')[1]

  const repos = await listRepositories(token, owner)
  const updated: string[] = []
  const failed: string[] = []

  for (const repo of repos) {
    try {
      if (repo !== current && !(await hasSecret(token, owner, repo, marker))) {
        continue
      }
      await writeSecrets(token, owner, repo, secrets)
      updated.push(repo)
    } catch (error) {
      failed.push(repo)
      core.warning(
        `Could not update secrets in ${owner}/${repo}: ${(error as Error).message}`
      )
    }
  }

  core.info(
    `🔐 Updated ${Object.keys(secrets).join(', ')} in ${updated.length} repositories: ${updated.join(', ')}`
  )
  if (failed.length) {
    core.warning(`Secrets not updated in: ${failed.join(', ')}`)
  }

  return updated
}
