/**
 * Integration test harness for gopls.
 *
 * Sibling to session.ts (which hosts jdtls). Same singleton pattern: one
 * gopls process for the `bun test` run, one Go module, tests share them.
 *
 * gopls is resolved in this order:
 *   1. $CCLSP_GOPLS_BIN — path to a gopls binary.
 *   2. Auto-installed to ~/.cache/cclsp-integration/go-bin/gopls via
 *      `go install golang.org/x/tools/gopls@latest` on first run.
 *
 * The harness also runs `go mod init` in the workspace root because most
 * gopls refactorings require an in-module context.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LSPClient } from '../../src/lsp-client.ts';

const CACHE_ROOT = join(homedir(), '.cache', 'cclsp-integration');
const GO_BIN_DIR = join(CACHE_ROOT, 'go-bin');
const GOPLS_BIN = join(GO_BIN_DIR, 'gopls');

export interface GoIntegrationSession {
  client: LSPClient;
  workspaceRoot: string;
  writeGoFile(relPath: string, content: string): Promise<string>;
  disposeFile(absPath: string): Promise<void>;
  uniquePackage(): string;
}

let cached: Promise<GoIntegrationSession> | null = null;
let counter = 0;

export function getGoSession(): Promise<GoIntegrationSession> {
  if (!cached) {
    cached = buildSession().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function buildSession(): Promise<GoIntegrationSession> {
  mkdirSync(CACHE_ROOT, { recursive: true });

  const goplsBin = await resolveGopls();

  // Fresh workspace per test run.
  const workspaceRoot = join(tmpdir(), `cclsp-gopls-integration-${process.pid}-${Date.now()}`);
  mkdirSync(workspaceRoot, { recursive: true });

  // gopls needs a go.mod to offer most refactorings.
  const modInit = spawnSync('go', ['mod', 'init', 'cclsp.test'], {
    cwd: workspaceRoot,
    stdio: 'pipe',
  });
  if (modInit.status !== 0) {
    throw new Error(
      `go mod init failed (exit ${modInit.status}): ${modInit.stderr?.toString() ?? ''}`
    );
  }

  const configPath = join(workspaceRoot, 'cclsp.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            extensions: ['go'],
            command: [goplsBin],
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

  // Prime gopls with a stub file so the first real test doesn't pay the
  // "init + index the module" cost.
  const stubPath = join(workspaceRoot, 'stub.go');
  writeFileSync(stubPath, 'package main\n\nfunc boot() {}\n');
  await client.getDiagnostics(stubPath);

  return {
    client,
    workspaceRoot,
    async writeGoFile(relPath, content) {
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
    },
    uniquePackage() {
      counter += 1;
      const suffix = Math.random().toString(36).slice(2, 8);
      return `pkg${counter}_${suffix}`;
    },
  };
}

async function resolveGopls(): Promise<string> {
  const env = process.env.CCLSP_GOPLS_BIN;
  if (env) {
    if (!existsSync(env)) {
      throw new Error(`CCLSP_GOPLS_BIN="${env}" does not exist.`);
    }
    return env;
  }

  if (existsSync(GOPLS_BIN)) return GOPLS_BIN;

  console.log(`[integration] installing gopls to ${GOPLS_BIN} (one-time)...`);
  mkdirSync(GO_BIN_DIR, { recursive: true });

  // Use a dedicated GOPATH/GOBIN so we don't touch the user's env.
  const result = spawnSync('go', ['install', 'golang.org/x/tools/gopls@latest'], {
    env: {
      ...process.env,
      GOBIN: GO_BIN_DIR,
      GOPATH: join(CACHE_ROOT, 'go-path'),
      GOMODCACHE: join(CACHE_ROOT, 'go-mod-cache'),
    },
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(
      `go install gopls failed (exit ${result.status}):\n${result.stderr?.toString() ?? ''}`
    );
  }
  if (!existsSync(GOPLS_BIN)) {
    throw new Error(
      `go install reported success but ${GOPLS_BIN} is missing. Check GOBIN handling.`
    );
  }
  chmodSync(GOPLS_BIN, 0o755);
  console.log('[integration] gopls installed.');
  return GOPLS_BIN;
}
