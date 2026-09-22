import * as assert from 'assert'
import * as path from 'path'
import * as vscode from 'vscode'
import { DevContainerFileSystemProvider } from '../devcontainerFs'
import { execDocker } from '../docker'

const SCHEME = 'devc-vscode'

function uri(container: string, p: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: container, path: p })
}

async function dockerPsIds(args: string[]): Promise<string[]> {
  let res
  try {
    res = await execDocker(['ps', '-q', ...args])
  } catch {
    // No docker CLI at all (e.g. developing inside a dev container with no
    // socket). Treated as "no containers" so the suite skips rather than errors.
    return []
  }
  if (res.exitCode !== 0) {
    return []
  }
  return res.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Pick a running dev container to test against: explicit env override, else the
 * container for this repository (devcontainer.local_folder label), else any
 * running dev container. Returns undefined (suite is skipped) when there is
 * nothing to talk to.
 */
async function findTestContainer(): Promise<string | undefined> {
  if (process.env.DEVCONTAINER_FILETREE_TEST_CONTAINER) {
    return process.env.DEVCONTAINER_FILETREE_TEST_CONTAINER
  }
  const repoRoot = path.resolve(__dirname, '..', '..')
  const own = await dockerPsIds([
    '--filter',
    `label=devcontainer.local_folder=${repoRoot}`,
  ])
  if (own.length > 0) {
    return own[0]
  }
  const any = await dockerPsIds(['--filter', 'label=devcontainer.config_file'])
  return any[0]
}

async function assertFsError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise
  } catch (err) {
    assert.ok(
      err instanceof vscode.FileSystemError,
      `expected FileSystemError(${code}), got: ${err}`,
    )
    assert.strictEqual((err as vscode.FileSystemError).code, code)
    return
  }
  assert.fail(`expected FileSystemError(${code}), but the operation succeeded`)
}

suite('DevContainerFileSystemProvider (live container)', function () {
  this.timeout(15000)

  let container: string
  let provider: DevContainerFileSystemProvider
  let root: string // scratch dir inside the container
  const u = (p: string) => uri(container, p)

  suiteSetup(async function () {
    this.timeout(30000)
    const found = await findTestContainer()
    if (!found) {
      // No docker / no running dev container: nothing to test against.
      this.skip()
      return
    }
    container = found
    provider = new DevContainerFileSystemProvider()
    root = `/tmp/dc-fs-test-${process.pid}`
    await provider.createDirectory(u(root))
    await provider.writeFile(
      u(`${root}/hello.txt`),
      Buffer.from('hello container fs\n'),
      { create: true, overwrite: true },
    )
  })

  suiteTeardown(async function () {
    if (!container) {
      return
    }
    await provider.delete(u(root), { recursive: true }).catch(() => {
      /* best effort */
    })
  })

  test('stat: directory', async () => {
    const s = await provider.stat(u('/'))
    assert.strictEqual(s.type, vscode.FileType.Directory)
  })

  test('stat: file has type and size', async () => {
    const s = await provider.stat(u(`${root}/hello.txt`))
    assert.strictEqual(s.type, vscode.FileType.File)
    assert.strictEqual(s.size, Buffer.byteLength('hello container fs\n'))
  })

  test('stat: missing file throws FileNotFound', async () => {
    await assertFsError(provider.stat(u(`${root}/nope.txt`)), 'FileNotFound')
  })

  test('readDirectory lists entries with types', async () => {
    await provider.createDirectory(u(`${root}/subdir`))
    const entries = await provider.readDirectory(u(root))
    const map = new Map(entries)
    assert.strictEqual(map.get('hello.txt'), vscode.FileType.File)
    assert.strictEqual(map.get('subdir'), vscode.FileType.Directory)
  })

  test('readDirectory: missing dir throws FileNotFound', async () => {
    await assertFsError(
      provider.readDirectory(u(`${root}/missing`)),
      'FileNotFound',
    )
  })

  test('readFile returns contents', async () => {
    const content = await provider.readFile(u(`${root}/hello.txt`))
    assert.strictEqual(
      Buffer.from(content).toString('utf8'),
      'hello container fs\n',
    )
  })

  test('readFile: directory throws FileIsADirectory', async () => {
    await assertFsError(provider.readFile(u(root)), 'FileIsADirectory')
  })

  test('writeFile: create=false on missing file throws FileNotFound', async () => {
    await assertFsError(
      provider.writeFile(u(`${root}/new.txt`), new Uint8Array(0), {
        create: false,
        overwrite: true,
      }),
      'FileNotFound',
    )
  })

  test('writeFile: create without overwrite on existing file throws FileExists', async () => {
    await assertFsError(
      provider.writeFile(u(`${root}/hello.txt`), new Uint8Array(0), {
        create: true,
        overwrite: false,
      }),
      'FileExists',
    )
  })

  test('writeFile overwrites and reads back', async () => {
    await provider.writeFile(u(`${root}/hello.txt`), Buffer.from('updated'), {
      create: true,
      overwrite: true,
    })
    const content = await provider.readFile(u(`${root}/hello.txt`))
    assert.strictEqual(Buffer.from(content).toString('utf8'), 'updated')
  })

  test('writeFile: binary roundtrip', async () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      bytes[i] = i
    }
    await provider.writeFile(u(`${root}/bin.dat`), bytes, {
      create: true,
      overwrite: true,
    })
    const back = await provider.readFile(u(`${root}/bin.dat`))
    assert.deepStrictEqual(Buffer.from(back), Buffer.from(bytes))
  })

  test('createDirectory: existing throws FileExists', async () => {
    await assertFsError(provider.createDirectory(u(root)), 'FileExists')
  })

  test('rename moves a file', async () => {
    await provider.writeFile(u(`${root}/mv-src.txt`), Buffer.from('x'), {
      create: true,
      overwrite: true,
    })
    await provider.rename(u(`${root}/mv-src.txt`), u(`${root}/mv-dst.txt`), {
      overwrite: false,
    })
    await assertFsError(provider.stat(u(`${root}/mv-src.txt`)), 'FileNotFound')
    const s = await provider.stat(u(`${root}/mv-dst.txt`))
    assert.strictEqual(s.type, vscode.FileType.File)
  })

  test('rename: existing target without overwrite throws FileExists', async () => {
    await provider.writeFile(u(`${root}/rn-a.txt`), Buffer.from('a'), {
      create: true,
      overwrite: true,
    })
    await assertFsError(
      provider.rename(u(`${root}/rn-a.txt`), u(`${root}/hello.txt`), {
        overwrite: false,
      }),
      'FileExists',
    )
  })

  test('delete: missing file throws FileNotFound', async () => {
    await assertFsError(
      provider.delete(u(`${root}/missing.txt`), { recursive: false }),
      'FileNotFound',
    )
  })

  test('delete: recursive removes a directory tree', async () => {
    await provider.createDirectory(u(`${root}/doomed`))
    await provider.writeFile(u(`${root}/doomed/f.txt`), Buffer.from('x'), {
      create: true,
      overwrite: true,
    })
    await provider.delete(u(`${root}/doomed`), { recursive: true })
    await assertFsError(provider.stat(u(`${root}/doomed`)), 'FileNotFound')
  })

  test('filenames with spaces roundtrip', async () => {
    await provider.writeFile(
      u(`${root}/a file with spaces.txt`),
      Buffer.from('spaces'),
      { create: true, overwrite: true },
    )
    const entries = await provider.readDirectory(u(root))
    assert.ok(entries.some(([name]) => name === 'a file with spaces.txt'))
    const content = await provider.readFile(u(`${root}/a file with spaces.txt`))
    assert.strictEqual(Buffer.from(content).toString('utf8'), 'spaces')
  })

  test('provider is registered with vscode.workspace.fs', async () => {
    // Goes through VS Code's FS routing, which activates the extension via
    // the onFileSystem activation event and uses the registered provider.
    const entries = await vscode.workspace.fs.readDirectory(u('/'))
    const names = entries.map(([name]) => name)
    assert.ok(
      names.includes('tmp'),
      `expected tmp in container root, got: ${names.join(', ')}`,
    )
    const content = await vscode.workspace.fs.readFile(u(`${root}/hello.txt`))
    assert.ok(content.length > 0)
  })
})
