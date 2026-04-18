import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import {
  addMissingImportsTool,
  codeActionTool,
  convertForLoopTool,
  executeCommandTool,
  extractMethodTool,
  extractVariableTool,
  generateConstructorsTool,
  generateDelegateMethodsTool,
  generateGettersSettersTool,
  generateHashCodeEqualsTool,
  generateToStringTool,
  inlineTool,
  invertBooleanOrConditionTool,
  overrideMethodsTool,
} from './tools/refactoring.js';
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

const asClient = (m: MockLSPClient) => m as unknown as LSPClient;

function inlineEditAction(kind: string, title = 'Stub action') {
  return {
    title,
    kind,
    edit: {
      changes: {
        [pathToUri(JAVA_FILE)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            newText: '// edited\n',
          },
        ],
      },
    },
  };
}

describe('file-scope refactoring tools', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it.each([
    ['generate_tostring', generateToStringTool, 'source.generate.toString'],
    ['generate_hashcode_equals', generateHashCodeEqualsTool, 'source.generate.hashCodeEquals'],
    ['generate_constructors', generateConstructorsTool, 'source.generate.constructors'],
    ['generate_getters_setters', generateGettersSettersTool, 'source.generate.accessors'],
    ['generate_delegate_methods', generateDelegateMethodsTool, 'source.generate.delegateMethods'],
    ['override_methods', overrideMethodsTool, 'source.overrideMethods'],
  ])('%s requests the correct kind with full-file range', async (_name, tool, kind) => {
    mock.getCodeActions.mockResolvedValue([inlineEditAction(kind, `match-${kind}`)]);
    const result = await tool.handler({ file_path: JAVA_FILE, dry_run: true }, asClient(mock));
    expect(mock.getCodeActions).toHaveBeenCalledTimes(1);
    const call = mock.getCodeActions.mock.calls[0];
    expect(call?.[0]).toBe(resolve(JAVA_FILE));
    expect(call?.[1]).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    expect(call?.[2]).toContain(kind);
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });

  it('returns a helpful message when no matching action offered', async () => {
    mock.getCodeActions.mockResolvedValue([inlineEditAction('source.generate.other')]);
    const result = await generateToStringTool.handler({ file_path: JAVA_FILE }, asClient(mock));
    expect(result.content[0]?.text).toContain('No action available to generate toString');
    expect(result.content[0]?.text).toContain('source.generate.other');
  });

  it('executes command when action has no inline edit', async () => {
    const commandArgs = [pathToUri(JAVA_FILE)];
    mock.getCodeActions.mockResolvedValue([
      {
        title: 'Generate toString',
        kind: 'source.generate.toString',
        command: { title: 'x', command: 'java.edit.stringSubstitution', arguments: commandArgs },
      },
    ]);
    mock.executeCommand.mockResolvedValue({
      changes: {
        [pathToUri(JAVA_FILE)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'public String toString() { return ""; }',
          },
        ],
      },
    });

    const result = await generateToStringTool.handler(
      { file_path: JAVA_FILE, dry_run: true },
      asClient(mock)
    );
    expect(mock.executeCommand).toHaveBeenCalledWith(
      resolve(JAVA_FILE),
      'java.edit.stringSubstitution',
      commandArgs
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });
});

describe('position-based refactoring tools', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it('converts 1-indexed position to zero-width range for inline tool', async () => {
    mock.getCodeActions.mockResolvedValue([inlineEditAction('refactor.inline')]);
    await inlineTool.handler(
      { file_path: JAVA_FILE, line: 5, character: 10, dry_run: true },
      asClient(mock)
    );
    const range = mock.getCodeActions.mock.calls[0]?.[1];
    expect(range?.start).toEqual({ line: 4, character: 9 });
    expect(range?.end).toEqual({ line: 4, character: 9 });
  });

  it('convert_for_loop accepts either enhanced or classic kind', async () => {
    mock.getCodeActions.mockResolvedValue([
      inlineEditAction('refactor.rewrite.convertToEnhancedForLoop', 'To enhanced for'),
    ]);
    const result = await convertForLoopTool.handler(
      { file_path: JAVA_FILE, line: 1, character: 1, dry_run: true },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });

  it('invert_boolean_or_condition matches any of the three invert kinds', async () => {
    mock.getCodeActions.mockResolvedValue([
      inlineEditAction('refactor.rewrite.invertCondition', 'Invert "if" statement'),
    ]);
    const result = await invertBooleanOrConditionTool.handler(
      { file_path: JAVA_FILE, line: 1, character: 1, dry_run: true },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });
});

describe('range-based refactoring tools', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it('extract_variable passes through 1->0 indexed range', async () => {
    mock.getCodeActions.mockResolvedValue([inlineEditAction('refactor.extract.variable')]);
    await extractVariableTool.handler(
      {
        file_path: JAVA_FILE,
        start_line: 3,
        start_character: 5,
        end_line: 3,
        end_character: 20,
        dry_run: true,
      },
      asClient(mock)
    );
    const range = mock.getCodeActions.mock.calls[0]?.[1];
    expect(range).toEqual({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 19 },
    });
  });

  it('extract_method accepts both method and function kind (server-agnostic)', async () => {
    mock.getCodeActions.mockResolvedValue([
      inlineEditAction('refactor.extract.function', 'Extract function'),
    ]);
    const result = await extractMethodTool.handler(
      {
        file_path: JAVA_FILE,
        start_line: 1,
        start_character: 1,
        end_line: 2,
        end_character: 1,
        dry_run: true,
      },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });
});

describe('quickfix tools (title-match filtering)', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it('add_missing_imports picks the first action whose title mentions "import"', async () => {
    mock.getCodeActions.mockResolvedValue([
      { title: 'Create constructor', kind: 'quickfix' },
      inlineEditAction('quickfix', 'Import "java.util.List"'),
    ]);
    const result = await addMissingImportsTool.handler(
      { file_path: JAVA_FILE, line: 3, character: 12, dry_run: true },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain('Import "java.util.List"');
  });

  it('reports "no action" when no quickfix matches the title filter', async () => {
    mock.getCodeActions.mockResolvedValue([{ title: 'Create constructor', kind: 'quickfix' }]);
    const result = await addMissingImportsTool.handler(
      { file_path: JAVA_FILE, line: 1, character: 1 },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('No action available to add missing import');
  });
});

describe('code_action generic tool', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it('lists code actions when apply_index is not provided', async () => {
    mock.getCodeActions.mockResolvedValue([
      { title: 'Do thing A', kind: 'refactor.rewrite.foo', edit: { changes: {} } },
      { title: 'Do thing B', kind: 'quickfix' },
    ]);
    const result = await codeActionTool.handler(
      {
        file_path: JAVA_FILE,
        start_line: 1,
        start_character: 1,
        end_line: 1,
        end_character: 1,
      },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('Do thing A');
    expect(result.content[0]?.text).toContain('Do thing B');
    expect(result.content[0]?.text).toContain('kind=refactor.rewrite.foo');
  });

  it('applies the action at apply_index when given', async () => {
    mock.getCodeActions.mockResolvedValue([
      { title: 'Not this one', kind: 'quickfix' },
      inlineEditAction('refactor.rewrite.foo', 'This one'),
    ]);
    const result = await codeActionTool.handler(
      {
        file_path: JAVA_FILE,
        start_line: 1,
        start_character: 1,
        end_line: 1,
        end_character: 1,
        apply_index: 1,
        dry_run: true,
      },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
    expect(result.content[0]?.text).toContain('This one');
  });

  it('rejects out-of-range apply_index', async () => {
    mock.getCodeActions.mockResolvedValue([{ title: 'Only one', kind: 'quickfix' }]);
    const result = await codeActionTool.handler(
      {
        file_path: JAVA_FILE,
        start_line: 1,
        start_character: 1,
        end_line: 1,
        end_character: 1,
        apply_index: 5,
      },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('out of range');
  });
});

describe('execute_command generic tool', () => {
  let mock: MockLSPClient;

  beforeEach(() => {
    mock = createMockClient();
  });

  it('passes through command + arguments and applies returned WorkspaceEdit (dry_run)', async () => {
    mock.executeCommand.mockResolvedValue({
      changes: {
        [pathToUri(JAVA_FILE)]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: '// inserted\n',
          },
        ],
      },
    });
    const result = await executeCommandTool.handler(
      {
        file_path: JAVA_FILE,
        command: 'java.edit.organizeImports',
        arguments: [pathToUri(JAVA_FILE)],
        dry_run: true,
      },
      asClient(mock)
    );
    expect(mock.executeCommand).toHaveBeenCalledWith(
      resolve(JAVA_FILE),
      'java.edit.organizeImports',
      [pathToUri(JAVA_FILE)]
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');
  });

  it('reports a non-edit result gracefully', async () => {
    mock.executeCommand.mockResolvedValue({ ok: true });
    const result = await executeCommandTool.handler(
      { file_path: JAVA_FILE, command: 'java.project.refresh' },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('returned no WorkspaceEdit');
  });

  it('reports errors thrown by the LSP layer', async () => {
    mock.executeCommand.mockRejectedValue(new Error('boom'));
    const result = await executeCommandTool.handler(
      { file_path: JAVA_FILE, command: 'java.something' },
      asClient(mock)
    );
    expect(result.content[0]?.text).toContain('Error executing command "java.something": boom');
  });
});
