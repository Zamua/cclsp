import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import {
  changeQuoteTool,
  eliminateDotImportTool,
  fillStructTool,
  fillSwitchTool,
  joinLinesTool,
  moveParamTool,
  moveToNewFileTool,
  removeUnusedParamTool,
  splitLinesTool,
} from './tools/refactoring.js';
import { pathToUri } from './utils.js';

const GO_FILE = join(tmpdir(), 'pkg', 'main.go');

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
const asClient = (m: MockLSPClient) => m as unknown as LSPClient;

function inlineEditAction(kind: string, title: string) {
  return {
    title,
    kind,
    edit: {
      changes: {
        [pathToUri(GO_FILE)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            newText: '// edited\n',
          },
        ],
      },
    },
  };
}

describe('gopls-specific refactoring tools', () => {
  let mock: MockLSPClient;
  beforeEach(() => {
    mock = createMockClient();
  });

  it.each([
    ['fill_struct', fillStructTool, 'refactor.rewrite.fillStruct', 'Fill S'],
    ['fill_switch', fillSwitchTool, 'refactor.rewrite.fillSwitch', 'Fill switch'],
    ['change_quote', changeQuoteTool, 'refactor.rewrite.changeQuote', 'Convert to backticks'],
    ['join_lines', joinLinesTool, 'refactor.rewrite.joinLines', 'Join lines'],
    ['split_lines', splitLinesTool, 'refactor.rewrite.splitLines', 'Split lines'],
    [
      'eliminate_dot_import',
      eliminateDotImportTool,
      'refactor.rewrite.eliminateDotImport',
      'Eliminate dot import',
    ],
    [
      'remove_unused_param',
      removeUnusedParamTool,
      'refactor.rewrite.removeUnusedParam',
      'Remove unused parameter',
    ],
    ['move_to_new_file', moveToNewFileTool, 'refactor.extract.toNewFile', 'Move to new file'],
  ])('%s requests the correct kind at the cursor', async (_name, tool, kind, title) => {
    mock.getCodeActions.mockResolvedValue([inlineEditAction(kind, title)]);
    const result = await tool.handler(
      { file_path: GO_FILE, line: 3, character: 5, dry_run: true },
      asClient(mock)
    );
    const call = mock.getCodeActions.mock.calls[0];
    expect(call?.[0]).toBe(resolve(GO_FILE));
    expect(call?.[2]).toContain(kind);
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });

  it('move_param routes "left" and "right" to distinct kinds', async () => {
    mock.getCodeActions.mockResolvedValue([
      inlineEditAction('refactor.rewrite.moveParamLeft', 'Move left'),
    ]);
    await moveParamTool.handler(
      { file_path: GO_FILE, line: 3, character: 5, direction: 'left', dry_run: true },
      asClient(mock)
    );
    expect(mock.getCodeActions.mock.calls[0]?.[2]).toContain('refactor.rewrite.moveParamLeft');

    mock.getCodeActions.mockClear();
    mock.getCodeActions.mockResolvedValue([
      inlineEditAction('refactor.rewrite.moveParamRight', 'Move right'),
    ]);
    await moveParamTool.handler(
      { file_path: GO_FILE, line: 3, character: 5, direction: 'right', dry_run: true },
      asClient(mock)
    );
    expect(mock.getCodeActions.mock.calls[0]?.[2]).toContain('refactor.rewrite.moveParamRight');
  });

  it('resolves the action when the server returns one without an inline edit', async () => {
    const stub = {
      title: 'Fill S',
      kind: 'refactor.rewrite.fillStruct',
      data: { server: 'gopls', bookkeeping: 42 },
    };
    mock.getCodeActions.mockResolvedValue([stub]);
    mock.resolveCodeAction.mockResolvedValue({
      ...stub,
      edit: {
        changes: {
          [pathToUri(GO_FILE)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: '{A: 0, B: ""}',
            },
          ],
        },
      },
    });
    const result = await fillStructTool.handler(
      { file_path: GO_FILE, line: 3, character: 5, dry_run: true },
      asClient(mock)
    );
    expect(mock.resolveCodeAction).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain('{A: 0, B: ""}');
  });
});
