import { SearchResponse, Urls, BuildOptions, ZipPaths } from './types'

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import yazl from 'yazl'

export async function resolveAssetId(
  name: string,
  cookies: string
): Promise<string> {
  try {
    const search = await axios.get<SearchResponse>(
      `https://portal-api.cfx.re/v1/me/assets?search=${name}&sort=asset.name&direction=asc`,
      {
        headers: {
          Cookie: cookies
        }
      }
    )

    if (search.data.items.length == 0) {
      core.error(`❌ No assets found matching: "${name}"`)
      core.error(
        '💡 Make sure the asset exists in your CFX Portal and the name is correct'
      )
      throw new Error(
        `No assets found matching "${name}". Check if the asset exists in your CFX Portal.`
      )
    }

    for (const asset of search.data.items) {
      if (asset.name === name) {
        return asset.id.toString()
      }
    }

    const suggestions = search.data.items
      .map((asset: any) => `"${asset.name}"`)
      .join(', ')
    core.error(`❌ No exact match found for "${name}"`)
    core.error(`💡 Available assets: ${suggestions}`)

    throw new Error(
      `No exact match found for "${name}". Available assets: ${suggestions}`
    )
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        throw new Error(
          'Authentication failed. Check if your forum cookie is valid.'
        )
      } else if (error.response?.status === 403) {
        throw new Error(
          'Access denied. Make sure you have permission to view assets.'
        )
      }
      core.error(
        `API Error: ${error.response?.status} ${error.response?.statusText}`
      )
    }
    throw error
  }
}

export function getUrl(
  type: keyof typeof Urls,
  params?: Record<string, string | number>
): string {
  let url = Urls.API + Urls[type]
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`{${key}}`, String(value))
    }
  }
  return url
}

type TreeNode = string | Record<string, TreeNode[]> | null

function buildTree(currentPath: string): TreeNode {
  const stats = fs.statSync(currentPath)

  if (stats.isFile()) {
    return path.basename(currentPath)
  }

  if (stats.isDirectory()) {
    const children = fs.readdirSync(currentPath)
    return {
      [path.basename(currentPath)]: children.map((child: string) =>
        buildTree(path.join(currentPath, child))
      )
    }
  }

  return null
}

export function getEnv(name: string): string {
  if (process.env[name] === undefined) {
    throw new Error(`Environment variable ${name} is not set.`)
  }

  return process.env[name]
}

export async function zipAsset(assetName: string): Promise<string> {
  core.debug('Zipping asset...')

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const outputZipPath = assetName + '.zip'
  const zipfile = new yazl.ZipFile()

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        core.debug(`Entering directory ${fullPath}...`)
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        core.debug(`Adding file ${fullPath} as ${entryZipPath}...`)
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  core.debug('Adding files to zip...')
  addDirectoryToZip(workspacePath, assetName)

  core.debug(
    'Zip content: ' + JSON.stringify(buildTree(workspacePath), null, 2)
  )
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        console.log(`Asset zipped to ${outputZipPath}`)
        resolve(path.resolve(outputZipPath))
      })
      .on('error', reject)
  })
}

export function deleteIfExists(_path: string): void {
  _path = path.join(getEnv('GITHUB_WORKSPACE'), _path)

  try {
    if (fs.existsSync(_path)) {
      core.debug(`Deleting ${_path}...`)
      const stats = fs.lstatSync(_path)

      if (stats.isDirectory()) {
        fs.rmSync(_path, { recursive: true, force: true })
      } else if (stats.isFile()) {
        fs.unlinkSync(_path)
      }
    } else {
      core.debug(`${_path} does not exist, skipping`)
    }
  } catch (error) {
    core.debug(`Skipping ${_path} deletion due to error: ${error as string}`)
  }
}

/**
 * Builds web and DUI if they exist
 */
async function buildWebAndDui(): Promise<void> {
  const workspacePath = getEnv('GITHUB_WORKSPACE')

  const webPath = path.join(workspacePath, 'web')
  if (fs.existsSync(webPath)) {
    core.info('🔨 Building web files...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const buildProcess = spawn('pnpm', ['install'], {
        cwd: webPath,
        stdio: 'inherit',
        shell: true
      })

      buildProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: webPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              core.info('✅ Web build completed')
              resolve()
            } else {
              reject(new Error(`Web build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`Web install failed with code ${code}`))
        }
      })
    })
  }

  const duiPath = path.join(workspacePath, 'dui')
  if (fs.existsSync(duiPath)) {
    core.info('🔨 Building DUI files...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn('pnpm', ['install'], {
        cwd: duiPath,
        stdio: 'inherit',
        shell: true
      })

      installProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: duiPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              // Copy DUI build files
              const duiBuildPath = path.join(duiPath, 'build')
              const targetDuiBuildPath = path.join(
                workspacePath,
                'dui',
                'build'
              )

              if (fs.existsSync(duiBuildPath)) {
                if (!fs.existsSync(targetDuiBuildPath)) {
                  fs.mkdirSync(targetDuiBuildPath, { recursive: true })
                }
                copyRecursively(duiBuildPath, targetDuiBuildPath)
              }

              core.info('✅ DUI build completed')
              resolve()
            } else {
              reject(new Error(`DUI build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`DUI install failed with code ${code}`))
        }
      })
    })
  }
}

/**
 * Checkout a specific branch
 * @param branchName The name of the branch to checkout
 */
async function checkoutBranch(branchName: string): Promise<void> {
  const workspacePath = getEnv('GITHUB_WORKSPACE')
  core.info(`🔀 Checking out branch: ${branchName}`)

  const { spawn } = require('child_process')

  // Reset any local changes first
  await new Promise<void>((resolve, reject) => {
    const resetProcess = spawn('git', ['reset', '--hard'], {
      cwd: workspacePath,
      stdio: 'inherit',
      shell: true
    })

    resetProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Git reset failed with code ${code}`))
      }
    })
  })

  // Clean untracked files
  await new Promise<void>((resolve, reject) => {
    const cleanProcess = spawn('git', ['clean', '-fd'], {
      cwd: workspacePath,
      stdio: 'inherit',
      shell: true
    })

    cleanProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        // Clean can fail if there's nothing to clean, that's ok
        resolve()
      }
    })
  })

  // Fetch the branch
  await new Promise<void>((resolve, reject) => {
    const gitProcess = spawn('git', ['fetch', 'origin', branchName], {
      cwd: workspacePath,
      stdio: 'inherit',
      shell: true
    })

    gitProcess.on('close', (code: number | null) => {
      if (code === 0) {
        const checkoutProcess = spawn('git', ['checkout', branchName], {
          cwd: workspacePath,
          stdio: 'inherit',
          shell: true
        })

        checkoutProcess.on('close', (checkoutCode: number | null) => {
          if (checkoutCode === 0) {
            core.info(`✅ Checked out branch: ${branchName}`)
            resolve()
          } else {
            reject(new Error(`Git checkout failed with code ${checkoutCode}`))
          }
        })
      } else {
        reject(new Error(`Git fetch failed with code ${code}`))
      }
    })
  })
}

/**
 * Creates HQ version of the asset
 * @param assetName The name of the asset
 * @param branch The branch to checkout (defaults to 'main')
 * @param ignoreFiles Optional array of files to ignore in escrow
 * @returns Path to the HQ zip file
 */
export async function createHQVersion(
  assetName: string,
  branch: string = 'main',
  ignoreFiles?: string[]
): Promise<string> {
  core.info(`📦 Creating HQ version from branch: ${branch}`)

  // Checkout the HQ branch
  await checkoutBranch(branch)

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const workspaceName = path.basename(workspacePath)
  // Save ZIP outside workspace to prevent git clean from removing it
  const zipPath = path.join(workspacePath, '..', `${workspaceName}.hq.zip`)

  // Exclude Git and unnecessary files from ZIP
  const excludePaths = [
    '.git',
    '.github',
    '.vscode',
    'node_modules',
    '.gitignore',
    '.gitattributes'
  ]
  await zipDirectory(workspacePath, zipPath, workspaceName, excludePaths)
  core.info(`✅ HQ version created: ${zipPath}`)

  return zipPath
}

/**
 * Creates LQ version of the asset
 * @param assetName The name of the asset
 * @param branch The branch to checkout (defaults to 'low-quality')
 * @param ignoreFiles Optional array of files to ignore in escrow
 * @returns Path to the LQ zip file
 */
export async function createLQVersion(
  assetName: string,
  branch: string = 'low-quality',
  ignoreFiles?: string[]
): Promise<string> {
  core.info(`📦 Creating LQ version from branch: ${branch}`)

  await checkoutBranch(branch)

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const workspaceName = path.basename(workspacePath)
  const zipPath = path.join(workspacePath, '..', `${workspaceName}.lq.zip`)

  const excludePaths = [
    '.git',
    '.github',
    '.vscode',
    'node_modules',
    '.gitignore',
    '.gitattributes'
  ]
  await zipDirectory(workspacePath, zipPath, workspaceName, excludePaths)
  core.info(`✅ LQ version created: ${zipPath}`)

  return zipPath
}

/**
 * Creates escrowed version of the asset
 * @param assetName The name of the asset
 * @param ignoreFiles Optional array of files to ignore in escrow
 * @returns Path to the escrowed zip file
 */
export async function createEscrowedVersion(
  assetName: string,
  ignoreFiles?: string[]
): Promise<string> {
  core.info('Creating escrowed version...')

  await buildWebAndDui()

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const escrowedDir = path.join(workspacePath, 'escrowed')

  await createDirectory(escrowedDir)
  await createDirectory(path.join(escrowedDir, 'web', 'build'))

  const foldersToInclude = ['client', 'shared', 'locales', 'server', 'data']
  const filesToInclude = ['fxmanifest.lua', 'init.lua']

  for (const folder of foldersToInclude) {
    const srcPath = path.join(workspacePath, folder)
    if (fs.existsSync(srcPath)) {
      copyRecursively(srcPath, path.join(escrowedDir, folder))
    }
  }

  for (const file of filesToInclude) {
    const srcPath = path.join(workspacePath, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(escrowedDir, file))
    }
  }

  const webBuildPath = path.join(workspacePath, 'web', 'build')
  if (fs.existsSync(webBuildPath)) {
    copyRecursively(webBuildPath, path.join(escrowedDir, 'web', 'build'))
  }

  const fxmanifestPath = path.join(escrowedDir, 'fxmanifest.lua')
  updateFxManifestMetadata(
    fxmanifestPath,
    path.basename(getEnv('GITHUB_WORKSPACE'))
  )

  if (fs.existsSync(fxmanifestPath)) {
    const filesToIgnore = ignoreFiles || [
      'init.lua',
      'shared/config.lua',
      'shared/utils.lua',
      'shared/startheist.lua'
    ]
    const ignoreEntries = filesToIgnore
      .map((file: string) => `  '${file}',`)
      .join('\n')
    const escrowIgnore = `\nescrow_ignore {\n${ignoreEntries}\n}\n`
    fs.appendFileSync(fxmanifestPath, escrowIgnore)
  }

  const workspaceName = path.basename(getEnv('GITHUB_WORKSPACE'))
  const zipPath = `${workspaceName}.escrowed.zip`
  return await zipDirectory(escrowedDir, zipPath, workspaceName)
}

/**
 * Creates open source version of the asset
 * @param assetName The name of the asset
 * @returns Path to the open source zip file
 */
export async function createOpenSourceVersion(
  assetName: string
): Promise<string> {
  core.info('Creating open-source version...')

  await buildWebAndDui()

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const openSourceDir = path.join(workspacePath, 'open-source')

  await createDirectory(openSourceDir)
  await createDirectory(path.join(openSourceDir, 'web'))

  const foldersToInclude = ['client', 'shared', 'locales', 'server', 'data']
  const filesToInclude = ['fxmanifest.lua', 'init.lua']

  for (const folder of foldersToInclude) {
    const srcPath = path.join(workspacePath, folder)
    if (fs.existsSync(srcPath)) {
      copyRecursively(srcPath, path.join(openSourceDir, folder))
    }
  }

  for (const file of filesToInclude) {
    const srcPath = path.join(workspacePath, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(openSourceDir, file))
    }
  }

  const webPath = path.join(workspacePath, 'web')
  if (fs.existsSync(webPath)) {
    copyRecursively(webPath, path.join(openSourceDir, 'web'), ['node_modules'])
  }

  const fxmanifestPath = path.join(openSourceDir, 'fxmanifest.lua')
  updateFxManifestMetadata(
    fxmanifestPath,
    path.basename(getEnv('GITHUB_WORKSPACE'))
  )

  if (fs.existsSync(fxmanifestPath)) {
    const escrowIgnore = `
escrow_ignore {
  '/*',
  '/**/*',
  '/**/**/*',
}
`
    fs.appendFileSync(fxmanifestPath, escrowIgnore)
  }

  const workspaceName = path.basename(getEnv('GITHUB_WORKSPACE'))
  const zipPath = `${workspaceName}.opensource.zip`
  return await zipDirectory(openSourceDir, zipPath, workspaceName)
}

/**
 * Updates fxmanifest.lua with repository metadata
 * @param fxmanifestPath Path to fxmanifest.lua file
 * @param resourceName Name of the resource (from workspace folder)
 */
function updateFxManifestMetadata(
  fxmanifestPath: string,
  resourceName: string
): void {
  if (!fs.existsSync(fxmanifestPath)) {
    return
  }

  let content = fs.readFileSync(fxmanifestPath, 'utf8')

  const tagName = process.env.GITHUB_REF_NAME || '1.0.0'
  const displayName = resourceName.toUpperCase().replace(/-/g, ' ')

  const descriptionMatch = content.match(
    /^\s*description\s+(['"`])([^'"`]*)\1/m
  )
  const existingDescription = descriptionMatch
    ? descriptionMatch[2]
    : `${resourceName} - FiveM Resource`

  const updates = [
    { field: 'name', value: `'${displayName}'` },
    { field: 'author', value: `'Koja Scripts'` },
    { field: 'version', value: `'${tagName}'` },
    { field: 'description', value: `'${existingDescription}'` }
  ]

  for (const { field, value } of updates) {
    const regex = new RegExp(`^\\s*${field}\\s+[^\\n]*`, 'm')
    const replacement = `${field} ${value}`

    if (regex.test(content)) {
      content = content.replace(regex, replacement)
    } else {
      const fxVersionRegex = /^(\s*fx_version\s+[^\n]*\n)/m
      if (fxVersionRegex.test(content)) {
        content = content.replace(fxVersionRegex, `$1${replacement}\n`)
      } else {
        content = `${replacement}\n${content}`
      }
    }
  }

  fs.writeFileSync(fxmanifestPath, content, 'utf8')
}

/**
 * Creates directory recursively
 * @param dirPath Path to directory
 */
async function createDirectory(dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Copies files and directories recursively
 * @param src Source path
 * @param dest Destination path
 * @param excludeDirs Directories to exclude
 */
function copyRecursively(
  src: string,
  dest: string,
  excludeDirs: string[] = []
): void {
  const stats = fs.statSync(src)

  if (stats.isDirectory()) {
    if (excludeDirs.includes(path.basename(src))) {
      return
    }

    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }

    const entries = fs.readdirSync(src)
    for (const entry of entries) {
      if (excludeDirs.includes(entry)) {
        continue
      }
      copyRecursively(
        path.join(src, entry),
        path.join(dest, entry),
        excludeDirs
      )
    }
  } else if (stats.isFile()) {
    fs.copyFileSync(src, dest)
  }
}

/**
 * Creates a zip file from a directory
 * @param sourceDir Source directory to zip
 * @param zipPath Output zip file path
 * @param rootFolderName Name of the root folder in the zip
 * @returns Promise resolving to the absolute path of the created zip file
 */
async function zipDirectory(
  sourceDir: string,
  zipPath: string,
  rootFolderName: string,
  excludePaths: string[] = []
): Promise<string> {
  const zipfile = new yazl.ZipFile()
  const outputZipPath = path.resolve(zipPath)

  const normalizedExcludes = excludePaths.map(p => path.normalize(p))

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(sourceDir, fullPath)

      const shouldExclude = normalizedExcludes.some(exclude => {
        const normalized = path.normalize(relativePath)
        return (
          normalized === exclude || normalized.startsWith(exclude + path.sep)
        )
      })

      if (shouldExclude) {
        core.debug(`Excluding from ZIP: ${relativePath}`)
        continue
      }

      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  addDirectoryToZip(sourceDir, '')
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        core.info(`Directory zipped to ${outputZipPath}`)
        resolve(outputZipPath)
      })
      .on('error', reject)
  })
}

/**
 * Creates both escrowed and open source versions based on options
 * @param options Build options
 * @param assetName Base asset name
 * @returns Object containing paths to created zip files
 */
export async function createVersions(
  options: BuildOptions,
  assetName: string
): Promise<ZipPaths> {
  const zipPaths: ZipPaths = {}

  deleteIfExists('escrowed/')
  deleteIfExists('open-source/')

  if (options.createEscrowed) {
    const escrowIgnoreFiles = options.escrowedConfig?.escrow_ignore
    const escrowedName =
      options.escrowedConfig?.asset_name || `${assetName}-escrowed`

    zipPaths.escrowed = await createEscrowedVersion(
      escrowedName,
      escrowIgnoreFiles
    )
  }

  if (options.createOpenSource) {
    const openSourceName =
      options.openSourceConfig?.asset_name || `${assetName}-source`
    zipPaths.openSource = await createOpenSourceVersion(openSourceName)
  }

  return zipPaths
}
