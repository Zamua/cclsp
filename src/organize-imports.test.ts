import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import { organizeImportsTool } from './tools/refactoring.js';
import { pathToUri } from './utils.js';

const JAVA_FILE = join(tmpdir(), 'src', 'Example.java');

type MockLSPClient = {
  getCodeActions: ReturnType<typeof jest.fn>;
  resolveCodeAction: ReturnType<typeof jest.fn>;
  executeCommand: ReturnType<typeof jest.fn>;
  syncFileContent: ReturnType<typeof jest.fn>;
};

function createMockClient(): MockLSPClient {
  return {
    getCodeActions: jest.fn(),
    resolveCodeAction: jest.fn((_path: string, action: unknown) => Promise.resolve(action)),
    executeCommand: jest.fn(),
    syncFileContent: jest.fn().mockResolvedValue(undefined),
  };
}

function asClient(mock: MockLSPClient): LSPClient {
  return mock as unknown as LSPClient;
}

describe('organize_imports MCP tool', () => {
  let mockClient: MockLSPClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('requests code actions with only=["source.organizeImports"]', async () => {
    mockClient.getCodeActions.mockResolvedValue([]);

    await organizeImportsTool.handler({ file_path: JAVA_FILE }, asClient(mockClient));

    expect(mockClient.getCodeActions).toHaveBeenCalledWith(
      resolve(JAVA_FILE),
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      ['source.organizeImports']
    );
  });

  it('returns a helpful message when no organize action is offered', async () => {
    mockClient.getCodeActions.mockResolvedValue([]);

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('No action available to organize imports');
    expect(mockClient.executeCommand).not.toHaveBeenCalled();
  });

  it('applies the edit inline when the action carries one (dry_run preview)', async () => {
    mockClient.getCodeActions.mockResolvedValue([
      {
        title: 'Organize imports',
        kind: 'source.organizeImports',
        edit: {
          changes: {
            [pathToUri(JAVA_FILE)]: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 2, character: 0 },
                },
                newText: 'import java.util.List;\nimport java.util.Map;\n',
              },
            ],
          },
        },
      },
    ]);

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE, dry_run: true },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain('Would organize imports');
    expect(result.content[0]?.text).toContain('import java.util.List;\\nimport java.util.Map;');
    expect(mockClient.executeCommand).not.toHaveBeenCalled();
  });

  it('executes the command when the action has no inline edit (jdtls pattern)', async () => {
    const action = {
      title: 'Organize imports',
      kind: 'source.organizeImports',
      command: {
        title: 'Organize Imports',
        command: 'java.edit.organizeImports',
        arguments: [pathToUri(JAVA_FILE)],
      },
    };
    mockClient.getCodeActions.mockResolvedValue([action]);
    mockClient.executeCommand.mockResolvedValue({
      changes: {
        [pathToUri(JAVA_FILE)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 3, character: 0 },
            },
            newText: 'import java.util.List;\n',
          },
        ],
      },
    });

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE, dry_run: true },
      asClient(mockClient)
    );

    expect(mockClient.executeCommand).toHaveBeenCalledWith(
      resolve(JAVA_FILE),
      'java.edit.organizeImports',
      [pathToUri(JAVA_FILE)]
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain(JAVA_FILE);
  });

  it('normalizes documentChanges from the command result', async () => {
    mockClient.getCodeActions.mockResolvedValue([
      {
        title: 'Organize imports',
        kind: 'source.organizeImports',
        command: {
          title: 'Organize Imports',
          command: 'java.edit.organizeImports',
          arguments: [pathToUri(JAVA_FILE)],
        },
      },
    ]);
    mockClient.executeCommand.mockResolvedValue({
      documentChanges: [
        {
          textDocument: { uri: pathToUri(JAVA_FILE), version: 1 },
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 1, character: 0 },
              },
              newText: 'import java.util.List;\n',
            },
          ],
        },
      ],
    });

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE, dry_run: true },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain('import java.util.List;');
  });

  it('reports "no changes" when both edit and command produce nothing', async () => {
    mockClient.getCodeActions.mockResolvedValue([
      {
        title: 'Organize imports',
        kind: 'source.organizeImports',
      },
    ]);

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('produced no changes');
  });

  it('reports errors thrown by the LSP layer', async () => {
    mockClient.getCodeActions.mockRejectedValue(new Error('jdtls not ready'));

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('Error running organize imports: jdtls not ready');
  });

  it('matches sub-kinds of source.organizeImports', async () => {
    mockClient.getCodeActions.mockResolvedValue([
      {
        title: 'Organize imports (Java)',
        kind: 'source.organizeImports.java',
        edit: {
          changes: {
            [pathToUri(JAVA_FILE)]: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 2, character: 0 },
                },
                newText: 'import java.util.List;\n',
              },
            ],
          },
        },
      },
    ]);

    const result = await organizeImportsTool.handler(
      { file_path: JAVA_FILE, dry_run: true },
      asClient(mockClient)
    );

    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });
});
