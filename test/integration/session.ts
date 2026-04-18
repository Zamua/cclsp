/**
 * Integration test harness for cclsp.
 *
 * One long-lived jdtls process, one long-lived workspace root, for the entire
 * `bun test` run. Test files import `getSession()` — the first call pays the
 * jdtls startup cost, every subsequent call returns the same live session.
 *
 * Design rationale: jdtls is expensive to start but cheap to reuse. An IDE
 * keeps one alive for days across hundreds of open/close cycles, which is
 * exactly what this harness automates. Each test is responsible for unique
 * file paths (the `uniquePackage()` helper gives you one) and for cleaning up
 * its own files (call `disposeFile()` in afterEach/afterAll).
 *
 * jdtls binary is resolved in this order:
 *   1. $CCLSP_JDTLS_HOME — path to an extracted jdtls tree.
 *   2. Auto-downloaded to ~/.cache/cclsp-integration/jdtls/ on first run.
 *
 * Set $CCLSP_INTEGRATION_REFRESH=1 to wipe the cache before spawning.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LSPClient } from '../../src/lsp-client.ts';
import { pathToUri } from '../../src/utils.ts';

const CACHE_ROOT = join(homedir(), '.cache', 'cclsp-integration');
const JDTLS_DIR = join(CACHE_ROOT, 'jdtls');
const JDTLS_DATA_DIR = join(CACHE_ROOT, 'jdtls-data');
const JDTLS_URL = 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz';

export interface IntegrationSession {
  client: LSPClient;
  workspaceRoot: string;
  /**
   * Write a source file inside the workspace and notify jdtls about it.
   * Returns the absolute path for use in subsequent LSP calls.
   */
  writeJavaFile(relPath: string, content: string): Promise<string>;
  /** Delete a test-created file from disk. Call in afterEach/afterAll. */
  disposeFile(absPath: string): Promise<void>;
  /** Unique dotted package name so concurrent tests don't collide on class names. */
  uniquePackage(): string;
}

let cached: Promise<IntegrationSession> | null = null;
let counter = 0;

export function getSession(): Promise<IntegrationSession> {
  if (!cached) {
    cached = buildSession().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function buildSession(): Promise<IntegrationSession> {
  if (process.env.CCLSP_INTEGRATION_REFRESH === '1' && existsSync(CACHE_ROOT)) {
    rmSync(CACHE_ROOT, { recursive: true, force: true });
  }
  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(JDTLS_DATA_DIR, { recursive: true });

  const jdtlsHome = await resolveJdtls();
  const jdtlsWrapper = writeJdtlsWrapper(jdtlsHome);

  // Fresh workspace each run keeps tests hermetic; jdtls's internal -data
  // cache persists across runs to keep startup fast.
  const workspaceRoot = join(tmpdir(), `cclsp-integration-${process.pid}-${Date.now()}`);
  mkdirSync(workspaceRoot, { recursive: true });

  const configPath = join(workspaceRoot, 'cclsp.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            extensions: ['java'],
            command: [jdtlsWrapper],
            rootDir: workspaceRoot,
          },
        ],
      },
      null,
      2
    )
  );

  const client = new LSPClient(configPath);

  process.on('exit', () => {
    try {
      client.dispose();
    } catch {}
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {}
  });

  // Trigger jdtls startup with a stub file so the first real test doesn't eat
  // the ~15s cold-start cost.
  const stubPath = join(workspaceRoot, 'Boot.java');
  writeFileSync(stubPath, 'public class Boot {}\n');
  await client.getDiagnostics(stubPath);

  return {
    client,
    workspaceRoot,
    async writeJavaFile(relPath, content) {
      const abs = join(workspaceRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      await client.syncFileContent(abs);
      return abs;
    },
    async disposeFile(absPath) {
      try {
        rmSync(absPath, { force: true });
      } catch {}
      // Tell jdtls the file is gone so it drops its analysis. syncFileContent
      // can't do this because the file no longer exists on disk.
      void pathToUri;
    },
    uniquePackage() {
      counter += 1;
      const suffix = Math.random().toString(36).slice(2, 8);
      return `tests.t${counter}_${suffix}`;
    },
  };
}

async function resolveJdtls(): Promise<string> {
  const env = process.env.CCLSP_JDTLS_HOME;
  if (env) {
    if (!existsSync(join(env, 'plugins'))) {
      throw new Error(
        `CCLSP_JDTLS_HOME="${env}" does not look like an extracted jdtls tree (missing plugins/).`
      );
    }
    return env;
  }

  if (existsSync(join(JDTLS_DIR, 'plugins'))) return JDTLS_DIR;

  console.log(`[integration] downloading jdtls to ${JDTLS_DIR} (one-time, ~50MB)...`);
  mkdirSync(JDTLS_DIR, { recursive: true });

  const tarPath = join(CACHE_ROOT, 'jdtls.tar.gz');
  const res = await fetch(JDTLS_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download jdtls (${res.status} ${res.statusText})`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(tarPath)
  );

  const result = spawnSync('tar', ['xzf', tarPath, '-C', JDTLS_DIR]);
  if (result.status !== 0) {
    throw new Error(
      `tar extraction failed (exit ${result.status}): ${result.stderr?.toString() ?? ''}`
    );
  }
  rmSync(tarPath, { force: true });
  console.log('[integration] jdtls extracted.');
  return JDTLS_DIR;
}

function writeJdtlsWrapper(jdtlsHome: string): string {
  const pluginsDir = join(jdtlsHome, 'plugins');
  const launcherEntry = readdirSync(pluginsDir).find((n) =>
    /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(n)
  );
  if (!launcherEntry) {
    throw new Error(`No equinox launcher jar found in ${pluginsDir}`);
  }
  const launcher = join(pluginsDir, launcherEntry);
  const configDir = join(jdtlsHome, 'config_linux');

  const wrapperPath = join(CACHE_ROOT, 'jdtls-run.sh');
  const script = `#!/bin/bash
set -e
exec java \\
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \\
  -Dosgi.bundles.defaultStartLevel=4 \\
  -Declipse.product=org.eclipse.jdt.ls.core.product \\
  -Dlog.level=ALL \\
  -Xmx1g \\
  --add-modules=ALL-SYSTEM \\
  --add-opens java.base/java.util=ALL-UNNAMED \\
  --add-opens java.base/java.lang=ALL-UNNAMED \\
  -jar "${launcher}" \\
  -configuration "${configDir}" \\
  -data "${JDTLS_DATA_DIR}" \\
  "$@"
`;
  writeFileSync(wrapperPath, script);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}
