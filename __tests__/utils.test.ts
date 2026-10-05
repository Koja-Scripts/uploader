/**
 * Unit tests for the resource pack contents, src/utils.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { copyResourceFiles } from '../src/utils'

function write(root: string, file: string, content = ''): void {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

describe('copyResourceFiles', () => {
  let workspace: string
  let target: string

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-ws-'))
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'uploader-pack-'))
    for (const file of [
      'fxmanifest.lua',
      'init.lua',
      'install.sql',
      'README.md',
      'client/main.lua',
      'editable/shared/config.lua',
      'stream/graphics.ytd',
      'web/build/index.html',
      'web/src/App.tsx',
      'web/package.json',
      'web/node_modules/react/index.js',
      'dui/build/index.html',
      'dui/src/main.ts',
      '.github/workflows/build.yml',
      '.git/HEAD',
      '.gitignore',
      '.env',
      'old-release.zip',
      'escrowed/leftover.lua'
    ]) {
      write(workspace, file)
    }
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  })

  it('ships every resource folder but only the UI builds when escrowed', () => {
    copyResourceFiles(workspace, target, 'escrowed')

    expect(listFiles(target)).toEqual([
      'README.md',
      'client/main.lua',
      'dui/build/index.html',
      'editable/shared/config.lua',
      'fxmanifest.lua',
      'init.lua',
      'install.sql',
      'stream/graphics.ytd',
      'web/build/index.html'
    ])
  })

  it('ships the UI sources without node_modules when open source', () => {
    copyResourceFiles(workspace, target, 'open-source')

    expect(listFiles(target)).toEqual([
      'README.md',
      'client/main.lua',
      'dui/build/index.html',
      'dui/src/main.ts',
      'editable/shared/config.lua',
      'fxmanifest.lua',
      'init.lua',
      'install.sql',
      'stream/graphics.ytd',
      'web/build/index.html',
      'web/package.json',
      'web/src/App.tsx'
    ])
  })
})
