/**
 * Unit tests for Hexel store publishing, src/hexel.ts
 */

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as utils from '../src/utils'
import {
  HEXEL_UPLOAD_URL,
  parseHexelConfig,
  publishToHexel,
  toSemver
} from '../src/hexel'

const meta = {
  version: '1.5',
  changelog: 'Added:\n- x',
  releaseCandidate: false
}

describe('hexel', () => {
  let tmp: string

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(core, 'info').mockImplementation()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-hexel-'))
    process.env.GITHUB_WORKSPACE = tmp
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('parses YAML-ish and JSON config', () => {
    expect(parseHexelConfig('product: "carmarket"\ncategory: scripts')).toEqual(
      {
        product: 'carmarket',
        category: 'scripts',
        author: 'Hexel'
      }
    )
    expect(parseHexelConfig('{"product":"x","author":"HX"}')).toEqual({
      product: 'x',
      category: undefined,
      author: 'HX'
    })
    expect(parseHexelConfig('  ')).toBeNull()
    expect(() => parseHexelConfig('category: a')).toThrow('product')
  })

  it('coerces versions to semver', () => {
    expect(toSemver('1.5')).toBe('1.5.0')
    expect(toSemver('v3')).toBe('3.0.0')
    expect(toSemver('1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(toSemver('main')).toBeNull()
  })

  it('builds the Hexel pack and uploads it with the secret', async () => {
    const zip = path.join(tmp, 'pack.zip')
    fs.writeFileSync(zip, 'zip')
    const build = jest
      .spyOn(utils, 'createOpenSourceVersion')
      .mockResolvedValue(zip)
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({
        data: { fileName: 'carmarket-v1.5.0.zip' }
      } as never)

    await publishToHexel(
      { product: 'carmarket', author: 'Hexel' },
      meta,
      'secret'
    )

    expect(build).toHaveBeenCalledWith('carmarket', '1.5', 'Hexel')
    expect(post).toHaveBeenCalledWith(
      HEXEL_UPLOAD_URL,
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret' })
      })
    )
  })

  it('skips release candidates and requires the secret', async () => {
    const post = jest.spyOn(axios, 'post')

    await publishToHexel(
      { product: 'carmarket', author: 'Hexel' },
      { ...meta, releaseCandidate: true },
      'secret'
    )
    expect(post).not.toHaveBeenCalled()

    await expect(
      publishToHexel({ product: 'carmarket', author: 'Hexel' }, meta, '')
    ).rejects.toThrow('hexelSecret')
  })
})
