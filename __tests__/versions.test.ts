/**
 * Unit tests for portal asset versioning, src/versions.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AssetVersion } from '../src/types'
import {
  formatChangelog,
  getProtectedVersionId,
  prepareVersionSlot,
  pruneVersions,
  resolveVersionMeta,
  selectVersionsToPrune,
  waitForVersion
} from '../src/versions'

const API = 'https://portal-api.cfx.re/v1/'

function v(
  id: number,
  version: string,
  extra: Partial<AssetVersion> = {}
): AssetVersion {
  return {
    id,
    version,
    state: 'active',
    created_at: `2026-01-0${id}T00:00:00Z`,
    changelog: '',
    is_release_candidate: false,
    ...extra
  }
}

function mockVersions(...lists: AssetVersion[][]): jest.SpyInstance {
  const get = jest.spyOn(axios, 'get')
  for (const list of lists) {
    get.mockResolvedValueOnce({ data: { versions: list } } as never)
  }
  return get
}

describe('versions', () => {
  let tmp: string
  let inputs: Record<string, string>

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(core, 'info').mockImplementation()
    jest.spyOn(core, 'debug').mockImplementation()
    jest.spyOn(core, 'warning').mockImplementation()

    inputs = {}
    jest.spyOn(core, 'getInput').mockImplementation(name => inputs[name] ?? '')

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-'))
    fs.writeFileSync(
      path.join(tmp, 'fxmanifest.lua'),
      "fx_version 'cerulean'\nversion '1.4.0'\n"
    )
    process.env.GITHUB_WORKSPACE = tmp
    process.env.GITHUB_SHA = 'abcdef1234567'
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_REF_TYPE
    delete process.env.GITHUB_REF_NAME
    delete process.env.RELEASE_BODY
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function setRelease(release: object): void {
    const eventPath = path.join(tmp, 'event.json')
    fs.writeFileSync(eventPath, JSON.stringify({ release }))
    process.env.GITHUB_EVENT_PATH = eventPath
  }

  describe('resolveVersionMeta', () => {
    it('uses the release tag, body and prerelease flag', () => {
      setRelease({ tag_name: '1.5', body: 'Fixed stuff', prerelease: true })

      expect(resolveVersionMeta()).toEqual({
        version: '1.5',
        changelog: 'Fixed stuff',
        releaseCandidate: true
      })
    })

    it('lets inputs override the release', () => {
      setRelease({ tag_name: '1.5', body: 'Fixed stuff', prerelease: true })
      inputs = {
        version: '2.0.0',
        changelog: 'Manual notes',
        releaseCandidate: 'false'
      }

      expect(resolveVersionMeta()).toEqual({
        version: '2.0.0',
        changelog: 'Manual notes',
        releaseCandidate: false
      })
    })

    it('falls back to a dev release candidate outside of tag runs', () => {
      process.env.GITHUB_REF_TYPE = 'branch'
      process.env.GITHUB_REF_NAME = 'main'

      expect(resolveVersionMeta()).toEqual({
        version: '1.4.0-dev.abcdef1',
        changelog: 'Release 1.4.0-dev.abcdef1',
        releaseCandidate: true
      })
    })

    it('uses the tag on plain tag pushes', () => {
      process.env.GITHUB_REF_TYPE = 'tag'
      process.env.GITHUB_REF_NAME = 'v3'

      expect(resolveVersionMeta()).toMatchObject({
        version: 'v3',
        releaseCandidate: false
      })
    })
  })

  describe('formatChangelog', () => {
    it('groups [+] [/] [-] lines like the Discord bot', () => {
      const body = [
        'Big garage update',
        '<!-- internal note -->',
        '[+] Parking fees',
        '- [/] Fixed vehicle duplication',
        '[!] Rebalanced prices',
        '[-] Old impound menu'
      ].join('\r\n')

      expect(formatChangelog(body)).toBe(
        [
          'Big garage update',
          '',
          'Added:',
          '- Parking fees',
          '',
          'Changed & fixed:',
          '- Fixed vehicle duplication',
          '- Rebalanced prices',
          '',
          'Removed:',
          '- Old impound menu'
        ].join('\n')
      )
    })

    it('falls back to "Release <version>" without notes', () => {
      setRelease({ tag_name: '2.0.0', body: '  ' })

      expect(resolveVersionMeta().changelog).toBe('Release 2.0.0')
    })
  })

  describe('selection', () => {
    it('protects the newest active stable version', () => {
      const versions = [
        v(1, '1.0'),
        v(2, '1.1'),
        v(3, '1.2-rc', { is_release_candidate: true }),
        v(4, '1.3', { state: 'processing' })
      ]

      expect(getProtectedVersionId(versions)).toBe(2)
    })

    it('prunes the oldest versions while sparing protected ones', () => {
      const versions = [v(3, 'c'), v(1, 'a'), v(2, 'b'), v(4, 'd'), v(5, 'e')]

      expect(selectVersionsToPrune(versions, 3, [1]).map(x => x.id)).toEqual([
        2, 3
      ])
      expect(selectVersionsToPrune(versions, 5, [])).toEqual([])
    })
  })

  describe('prepareVersionSlot', () => {
    it('frees a slot when the portal limit is reached', async () => {
      mockVersions([v(1, 'a'), v(2, 'b'), v(3, 'c'), v(4, 'd'), v(5, 'e')])
      const del = jest.spyOn(axios, 'delete').mockResolvedValue({} as never)

      await prepareVersionSlot('42', 'f', 'cookie')

      expect(del).toHaveBeenCalledTimes(1)
      expect(del).toHaveBeenCalledWith(`${API}assets/42/versions/1`, {
        headers: { Cookie: 'cookie' }
      })
    })

    it('replaces an existing version with the same number', async () => {
      mockVersions([v(1, 'a'), v(2, 'b', { state: 'failed' })])
      const del = jest.spyOn(axios, 'delete').mockResolvedValue({} as never)

      await prepareVersionSlot('42', 'b', 'cookie')

      expect(del).toHaveBeenCalledTimes(1)
      expect(del).toHaveBeenCalledWith(
        `${API}assets/42/versions/2`,
        expect.anything()
      )
    })

    it('refuses to replace the only version', async () => {
      mockVersions([v(1, 'a')])
      const del = jest.spyOn(axios, 'delete').mockResolvedValue({} as never)

      await expect(prepareVersionSlot('42', 'a', 'cookie')).rejects.toThrow(
        'already exists'
      )
      expect(del).not.toHaveBeenCalled()
    })

    it('does nothing when there is room', async () => {
      mockVersions([v(1, 'a'), v(2, 'b')])
      const del = jest.spyOn(axios, 'delete').mockResolvedValue({} as never)

      await prepareVersionSlot('42', 'c', 'cookie')

      expect(del).not.toHaveBeenCalled()
    })
  })

  describe('waitForVersion', () => {
    it('resolves once the version is active', async () => {
      const get = mockVersions(
        [v(1, 'a'), v(2, 'b', { state: 'processing' })],
        [v(1, 'a'), v(2, 'b')]
      )

      const versions = await waitForVersion('42', 2, 'cookie', 10, 0)

      expect(get).toHaveBeenCalledTimes(2)
      expect(versions?.map(x => x.id)).toEqual([1, 2])
    })

    it('fails when the portal rejects the version', async () => {
      mockVersions([v(2, 'b', { state: 'failed' })])

      await expect(waitForVersion('42', 2, 'cookie', 10, 0)).rejects.toThrow(
        'state: failed'
      )
    })

    it('only warns on timeout', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: { versions: [v(2, 'b', { state: 'processing' })] }
      } as never)

      await expect(waitForVersion('42', 2, 'cookie', 0.02, 5)).resolves.toBe(
        undefined
      )
      expect(core.warning).toHaveBeenCalled()
    })

    it('is skipped with a zero timeout', async () => {
      const get = jest.spyOn(axios, 'get')

      await expect(waitForVersion('42', 2, 'cookie', 0)).resolves.toBe(
        undefined
      )
      expect(get).not.toHaveBeenCalled()
    })
  })

  it('pruneVersions keeps the new version and the newest stable', async () => {
    const del = jest.spyOn(axios, 'delete').mockResolvedValue({} as never)
    const versions = [
      v(1, 'a'),
      v(2, 'b'),
      v(3, 'c-rc', { is_release_candidate: true })
    ]

    await pruneVersions('42', versions, 3, 1, 'cookie')

    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith(
      `${API}assets/42/versions/1`,
      expect.anything()
    )
  })
})
