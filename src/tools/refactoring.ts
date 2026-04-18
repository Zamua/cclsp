import { applyWorkspaceEdit } from '../file-editor.js';
import { normalizeWorkspaceEdit } from '../lsp/operations.js';
import { uriToPath } from '../utils.js';
import {
  FILE_TOP_RANGE,
  applyCodeAction,
  oneIndexedPositionToLspRange,
  oneIndexedRangeToLsp,
} from './code-action-helper.js';
import { resolvePath, textResult, withWarning } from './helpers.js';
import type { ToolDefinition } from './registry.js';

// -------------------------------------------------------------------
// Rename (pre-existing tools, unchanged)
// -------------------------------------------------------------------

export const renameSymbolTool: ToolDefinition = {
  name: 'rename_symbol',
  description:
    'Rename a symbol by name and kind in a file. If multiple symbols match, returns candidate positions and suggests using rename_symbol_strict. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      symbol_name: { type: 'string', description: 'The name of the symbol' },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
      new_name: { type: 'string', description: 'The new name for the symbol' },
      dry_run: {
        type: 'boolean',
        description: 'If true, only preview the changes without applying them (default: false)',
      },
    },
    required: ['file_path', 'symbol_name', 'new_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      new_name,
      dry_run = false,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      new_name: string;
      dry_run?: boolean;
    };
    const absolutePath = resolvePath(file_path);

    const result = await client.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
    const { matches: symbolMatches, warning } = result;

    if (symbolMatches.length === 0) {
      return textResult(
        withWarning(
          warning,
          `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
        )
      );
    }

    if (symbolMatches.length > 1) {
      const candidatesList = symbolMatches
        .map(
          (match) =>
            `- ${match.name} (${client.symbolKindToString(match.kind)}) at line ${match.position.line + 1}, character ${match.position.character + 1}`
        )
        .join('\n');

      return textResult(
        withWarning(
          warning,
          `Multiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`
        )
      );
    }

    const match = symbolMatches[0];
    if (!match) throw new Error('Unexpected error: no match found');

    try {
      const workspaceEdit = await client.renameSymbol(absolutePath, match.position, new_name);

      if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
        const changes: string[] = [];
        for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
          const filePath = uriToPath(uri);
          changes.push(`File: ${filePath}`);
          for (const edit of edits) {
            const { start, end } = edit.range;
            changes.push(
              `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
            );
          }
        }

        if (!dry_run) {
          const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient: client });
          if (!editResult.success) return textResult(`Failed to apply rename: ${editResult.error}`);
          return textResult(
            withWarning(
              warning,
              `Successfully renamed ${match.name} (${client.symbolKindToString(match.kind)}) to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
            )
          );
        }
        return textResult(
          withWarning(
            warning,
            `[DRY RUN] Would rename ${match.name} (${client.symbolKindToString(match.kind)}) to "${new_name}":\n${changes.join('\n')}`
          )
        );
      }
      return textResult(
        withWarning(
          warning,
          `No rename edits available for ${match.name} (${client.symbolKindToString(match.kind)}). The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`
        )
      );
    } catch (error) {
      return textResult(
        `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const renameSymbolStrictTool: ToolDefinition = {
  name: 'rename_symbol_strict',
  description:
    'Rename a symbol at a specific position in a file. Use this when rename_symbol returns multiple candidates. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position in the line (1-indexed)' },
      new_name: { type: 'string', description: 'The new name for the symbol' },
      dry_run: {
        type: 'boolean',
        description: 'If true, only preview the changes without applying them (default: false)',
      },
    },
    required: ['file_path', 'line', 'character', 'new_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      line,
      character,
      new_name,
      dry_run = false,
    } = args as {
      file_path: string;
      line: number;
      character: number;
      new_name: string;
      dry_run?: boolean;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const workspaceEdit = await client.renameSymbol(
        absolutePath,
        { line: line - 1, character: character - 1 },
        new_name
      );

      if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
        const changes: string[] = [];
        for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
          const filePath = uriToPath(uri);
          changes.push(`File: ${filePath}`);
          for (const edit of edits) {
            const { start, end } = edit.range;
            changes.push(
              `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
            );
          }
        }

        if (!dry_run) {
          const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient: client });
          if (!editResult.success) return textResult(`Failed to apply rename: ${editResult.error}`);
          return textResult(
            `Successfully renamed symbol at line ${line}, character ${character} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
          );
        }
        return textResult(
          `[DRY RUN] Would rename symbol at line ${line}, character ${character} to "${new_name}":\n${changes.join('\n')}`
        );
      }
      return textResult(
        `No rename edits available at line ${line}, character ${character}. Please verify the symbol location and ensure the language server is properly configured.`
      );
    } catch (error) {
      return textResult(
        `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

// -------------------------------------------------------------------
// Shared schemas
// -------------------------------------------------------------------

const FILE_PATH_PROP = {
  file_path: { type: 'string', description: 'The path to the file' },
};
const DRY_RUN_PROP = {
  dry_run: {
    type: 'boolean',
    description: 'If true, preview the edit without writing to disk (default: false).',
  },
};
const POSITION_PROPS = {
  line: { type: 'number', description: 'Line (1-indexed) of the cursor inside the target' },
  character: {
    type: 'number',
    description: 'Character (1-indexed) of the cursor inside the target',
  },
};
const RANGE_PROPS = {
  start_line: { type: 'number', description: 'Start line (1-indexed)' },
  start_character: { type: 'number', description: 'Start character (1-indexed)' },
  end_line: { type: 'number', description: 'End line (1-indexed)' },
  end_character: { type: 'number', description: 'End character (1-indexed)' },
};

interface FileArgs {
  file_path: string;
  dry_run?: boolean;
}
interface PositionArgs extends FileArgs {
  line: number;
  character: number;
}
interface RangeArgs extends FileArgs {
  start_line: number;
  start_character: number;
  end_line: number;
  end_character: number;
}

// -------------------------------------------------------------------
// Group A — file-scope source actions
// -------------------------------------------------------------------

function fileScopeTool(
  name: string,
  description: string,
  verb: string,
  kinds: string[],
  titleMatch?: string
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PATH_PROP, ...DRY_RUN_PROP },
      required: ['file_path'],
    },
    handler: async (args, client) => {
      const { file_path, dry_run = false } = args as unknown as FileArgs;
      return applyCodeAction({
        client,
        filePath: resolvePath(file_path),
        range: FILE_TOP_RANGE,
        only: kinds,
        dryRun: dry_run,
        description: verb,
        titleMatch,
      });
    },
  };
}

export const organizeImportsTool = fileScopeTool(
  'organize_imports',
  "Organize imports in a file: removes unused imports and sorts the remaining ones according to the language server's rules. Works for any server that advertises source.organizeImports (jdtls, pylsp, ruff, tsserver, etc). Use dry_run to preview.",
  'organize imports',
  ['source.organizeImports']
);

export const generateToStringTool = fileScopeTool(
  'generate_tostring',
  'Generate a toString() method for the class in the given Java file. Backed by jdtls source.generate.toString code action.',
  'generate toString()',
  ['source.generate.toString']
);

export const generateHashCodeEqualsTool = fileScopeTool(
  'generate_hashcode_equals',
  'Generate hashCode() and equals() for the class in the given Java file. Backed by jdtls source.generate.hashCodeEquals.',
  'generate hashCode()/equals()',
  ['source.generate.hashCodeEquals']
);

export const generateConstructorsTool = fileScopeTool(
  'generate_constructors',
  "Generate constructors from the class's fields. Backed by jdtls source.generate.constructors.",
  'generate constructors',
  ['source.generate.constructors']
);

export const generateGettersSettersTool = fileScopeTool(
  'generate_getters_setters',
  "Generate getters and setters for the class's fields. Tries source.generate.accessors then source.generate.gettersSetters.",
  'generate getters/setters',
  ['source.generate.accessors', 'source.generate.gettersSetters']
);

export const generateDelegateMethodsTool = fileScopeTool(
  'generate_delegate_methods',
  'Generate delegate methods for a field. Backed by jdtls source.generate.delegateMethods.',
  'generate delegate methods',
  ['source.generate.delegateMethods']
);

export const overrideMethodsTool = fileScopeTool(
  'override_methods',
  'Generate stubs that override/implement inherited methods. Backed by jdtls source.overrideMethods.',
  'override/implement methods',
  ['source.overrideMethods']
);

// -------------------------------------------------------------------
// Group B — quickfixes (position + quickfix kind)
// -------------------------------------------------------------------

function positionQuickfixTool(
  name: string,
  description: string,
  verb: string,
  titleMatch: string
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PATH_PROP, ...POSITION_PROPS, ...DRY_RUN_PROP },
      required: ['file_path', 'line', 'character'],
    },
    handler: async (args, client) => {
      const { file_path, line, character, dry_run = false } = args as unknown as PositionArgs;
      return applyCodeAction({
        client,
        filePath: resolvePath(file_path),
        range: oneIndexedPositionToLspRange(line, character),
        only: ['quickfix'],
        dryRun: dry_run,
        description: verb,
        titleMatch,
      });
    },
  };
}

export const addMissingImportsTool: ToolDefinition = {
  name: 'add_missing_imports',
  description:
    'Resolve an unresolved identifier at the given position by adding the appropriate import (jdtls quickfix). If multiple candidates exist, the first is applied; use dry_run to preview.',
  inputSchema: {
    type: 'object',
    properties: { ...FILE_PATH_PROP, ...POSITION_PROPS, ...DRY_RUN_PROP },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const { file_path, line, character, dry_run = false } = args as unknown as PositionArgs;
    return applyCodeAction({
      client,
      filePath: resolvePath(file_path),
      range: oneIndexedPositionToLspRange(line, character),
      only: ['quickfix'],
      dryRun: dry_run,
      description: 'add missing import',
      titleMatch: 'import',
    });
  },
};

export const removeUnusedImportsTool = positionQuickfixTool(
  'remove_unused_imports',
  'Remove a single unused import at the given position (jdtls quickfix). For a bulk cleanup, use organize_imports instead.',
  'remove unused import',
  'remove'
);

export const addMissingMethodTool = positionQuickfixTool(
  'add_missing_method',
  'Create a method stub from a call site whose target does not yet exist (jdtls quickfix).',
  'add missing method',
  'create method'
);

export const addMissingFieldTool = positionQuickfixTool(
  'add_missing_field',
  'Create a field from a reference whose target does not yet exist (jdtls quickfix).',
  'add missing field',
  'create field'
);

export const addOverrideAnnotationTool = positionQuickfixTool(
  'add_override_annotation',
  'Add an @Override annotation to a method that overrides/implements an inherited method (jdtls quickfix).',
  'add @Override',
  'override'
);

export const surroundWithTryCatchTool = positionQuickfixTool(
  'surround_with_try_catch',
  'Surround a statement that throws a checked exception with try/catch (jdtls quickfix).',
  'surround with try/catch',
  'surround'
);

export const addMissingReturnTool = positionQuickfixTool(
  'add_missing_return',
  'Add a return statement to a method that is missing one (jdtls quickfix).',
  'add missing return',
  'return'
);

// -------------------------------------------------------------------
// Group C — selection-range extractions
// -------------------------------------------------------------------

function rangeRefactoringTool(
  name: string,
  description: string,
  verb: string,
  kinds: string[]
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PATH_PROP, ...RANGE_PROPS, ...DRY_RUN_PROP },
      required: ['file_path', 'start_line', 'start_character', 'end_line', 'end_character'],
    },
    handler: async (args, client) => {
      const {
        file_path,
        start_line,
        start_character,
        end_line,
        end_character,
        dry_run = false,
      } = args as unknown as RangeArgs;
      return applyCodeAction({
        client,
        filePath: resolvePath(file_path),
        range: oneIndexedRangeToLsp(start_line, start_character, end_line, end_character),
        only: kinds,
        dryRun: dry_run,
        description: verb,
      });
    },
  };
}

export const extractVariableTool = rangeRefactoringTool(
  'extract_variable',
  'Extract the selected expression into a local variable. Backed by refactor.extract.variable.',
  'extract variable',
  ['refactor.extract.variable']
);

export const extractConstantTool = rangeRefactoringTool(
  'extract_constant',
  'Extract the selected expression into a constant. Backed by refactor.extract.constant.',
  'extract constant',
  ['refactor.extract.constant']
);

export const extractMethodTool = rangeRefactoringTool(
  'extract_method',
  'Extract the selected block into a new method. Backed by refactor.extract.method. The new method name is chosen by the language server (usually "extracted"); rename afterwards with rename_symbol.',
  'extract method',
  ['refactor.extract.method', 'refactor.extract.function']
);

export const extractFieldTool = rangeRefactoringTool(
  'extract_field',
  'Extract the selected expression into a field. Backed by refactor.extract.field.',
  'extract field',
  ['refactor.extract.field']
);

// -------------------------------------------------------------------
// Group C.5 — position-based refactorings (inline, introduce parameter)
// -------------------------------------------------------------------

function positionRefactoringTool(
  name: string,
  description: string,
  verb: string,
  kinds: string[]
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PATH_PROP, ...POSITION_PROPS, ...DRY_RUN_PROP },
      required: ['file_path', 'line', 'character'],
    },
    handler: async (args, client) => {
      const { file_path, line, character, dry_run = false } = args as unknown as PositionArgs;
      return applyCodeAction({
        client,
        filePath: resolvePath(file_path),
        range: oneIndexedPositionToLspRange(line, character),
        only: kinds,
        dryRun: dry_run,
        description: verb,
      });
    },
  };
}

export const inlineTool = positionRefactoringTool(
  'inline',
  'Inline the variable/method/constant at the cursor. The server infers which from the symbol kind. Backed by refactor.inline.',
  'inline',
  ['refactor.inline']
);

export const introduceParameterTool = positionRefactoringTool(
  'introduce_parameter',
  'Convert a local variable into a method parameter. Backed by refactor.introduce.parameter.',
  'introduce parameter',
  ['refactor.introduce.parameter']
);

// -------------------------------------------------------------------
// Group D — rewrite-in-place actions
// -------------------------------------------------------------------
// jdtls surfaces most rewrite refactorings under the generic `refactor` or
// `refactor.rewrite` kind and identifies each by title. We request the broad
// kinds and filter by title.

function rewriteTool(
  name: string,
  description: string,
  verb: string,
  titleMatch: string
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...FILE_PATH_PROP, ...POSITION_PROPS, ...DRY_RUN_PROP },
      required: ['file_path', 'line', 'character'],
    },
    handler: async (args, client) => {
      const { file_path, line, character, dry_run = false } = args as unknown as PositionArgs;
      return applyCodeAction({
        client,
        filePath: resolvePath(file_path),
        range: oneIndexedPositionToLspRange(line, character),
        only: ['refactor', 'refactor.rewrite'],
        dryRun: dry_run,
        description: verb,
        kindMatch: ['refactor', 'refactor.rewrite'],
        titleMatch,
      });
    },
  };
}

export const convertForLoopTool = rewriteTool(
  'convert_for_loop',
  'Convert between classic for-loops and enhanced (for-each) loops at the cursor. Title-matched.',
  'convert for-loop',
  'for'
);

export const invertBooleanOrConditionTool = rewriteTool(
  'invert_boolean_or_condition',
  'Invert the boolean expression, condition, or boolean variable at the cursor. Title-matched on "invert".',
  'invert',
  'invert'
);

export const convertLambdaAnonymousTool = rewriteTool(
  'convert_lambda_anonymous',
  'Convert between a lambda expression and an anonymous inner class at the cursor.',
  'convert lambda/anonymous',
  'anonymous'
);

export const convertMethodReferenceLambdaTool = rewriteTool(
  'convert_method_reference_lambda',
  'Convert between a method reference and a lambda expression at the cursor.',
  'convert method-reference/lambda',
  'method reference'
);

export const convertAnonymousToNestedTool = rewriteTool(
  'convert_anonymous_to_nested',
  'Convert an anonymous inner class at the cursor into a named nested class.',
  'convert anonymous to nested',
  'nested'
);

// -------------------------------------------------------------------
// Group E — cross-file moves and promotions
// -------------------------------------------------------------------

export const moveMemberTool = positionRefactoringTool(
  'move_member',
  'Move the method or field at the cursor to another class. jdtls may require target selection; if the server returns an ambiguous command the caller should use execute_command directly for full control.',
  'move member',
  ['refactor.move', 'refactor.move.static', 'refactor.move.instanceMethod']
);

export const moveInnerToTopLevelTool = positionRefactoringTool(
  'move_inner_to_top_level',
  'Promote a nested class to its own top-level file. Backed by refactor.move.innerToOuter / jdtls MoveInnerToTopRefactoring.',
  'move inner class to top-level',
  ['refactor.move', 'refactor.move.innerToOuter', 'refactor.rewrite.moveTypeToNewFile']
);

export const extractInterfaceTool = positionRefactoringTool(
  'extract_interface',
  'Extract an interface from the class at the cursor. Backed by refactor.extract.interface.',
  'extract interface',
  ['refactor.extract.interface']
);

export const extractSuperclassTool = positionRefactoringTool(
  'extract_superclass',
  'Extract a superclass from the class at the cursor. Backed by refactor.extract.superclass or refactor.extract.class.',
  'extract superclass',
  ['refactor.extract.superclass', 'refactor.extract.class']
);

// -------------------------------------------------------------------
// Group F — generic escape hatches
// -------------------------------------------------------------------

export const codeActionTool: ToolDefinition = {
  name: 'code_action',
  description:
    'Generic escape hatch: list the code actions the language server offers at a given range/position, optionally filtered by kind prefix. If `apply_index` is given, the matching action is executed (like the specific refactoring tools). Useful when no dedicated tool exists yet.',
  inputSchema: {
    type: 'object',
    properties: {
      ...FILE_PATH_PROP,
      ...RANGE_PROPS,
      kind_prefix: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of LSP code-action kind prefixes (e.g. ["refactor.rewrite"]). If omitted, all kinds are returned.',
      },
      apply_index: {
        type: 'number',
        description: 'If set, apply the action at this (0-based) index of the returned list.',
      },
      ...DRY_RUN_PROP,
    },
    required: ['file_path', 'start_line', 'start_character', 'end_line', 'end_character'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      start_line,
      start_character,
      end_line,
      end_character,
      kind_prefix,
      apply_index,
      dry_run = false,
    } = args as unknown as RangeArgs & { kind_prefix?: string[]; apply_index?: number };

    const filePath = resolvePath(file_path);
    const range = oneIndexedRangeToLsp(start_line, start_character, end_line, end_character);

    try {
      const actions = await client.getCodeActions(filePath, range, kind_prefix);

      if (apply_index === undefined) {
        if (actions.length === 0) {
          return textResult(
            `No code actions available at ${file_path}:${start_line}:${start_character}.`
          );
        }
        const lines = actions
          .map(
            (a, i) =>
              `${i}: "${a.title}" (kind=${a.kind ?? 'unknown'}, hasEdit=${!!a.edit}, hasCommand=${!!a.command})`
          )
          .join('\n');
        return textResult(
          `Code actions at ${file_path}:${start_line}:${start_character}:\n${lines}`
        );
      }

      if (apply_index < 0 || apply_index >= actions.length) {
        return textResult(
          `apply_index=${apply_index} is out of range (0..${Math.max(0, actions.length - 1)}).`
        );
      }
      const chosen = actions[apply_index];
      if (!chosen) return textResult(`No action at index ${apply_index}`);

      return applyCodeAction({
        client,
        filePath,
        range,
        only: chosen.kind ? [chosen.kind] : [],
        dryRun: dry_run,
        description: `apply action "${chosen.title}"`,
        kindMatch: chosen.kind ? [chosen.kind] : [''],
        titleMatch: chosen.title,
      });
    } catch (error) {
      return textResult(
        `Error listing/applying code actions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const executeCommandTool: ToolDefinition = {
  name: 'execute_command',
  description:
    'Generic escape hatch: call workspace/executeCommand directly with the given command ID and arguments. If the command returns a WorkspaceEdit, it is applied. For jdtls this covers any java.edit.* / java.action.* command not exposed by a dedicated tool.',
  inputSchema: {
    type: 'object',
    properties: {
      ...FILE_PATH_PROP,
      command: {
        type: 'string',
        description: 'The LSP command ID (e.g. "java.edit.organizeImports")',
      },
      arguments: {
        type: 'array',
        description: 'Arguments to forward to the command',
      },
      ...DRY_RUN_PROP,
    },
    required: ['file_path', 'command'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      command,
      arguments: commandArgs = [],
      dry_run = false,
    } = args as {
      file_path: string;
      command: string;
      arguments?: unknown[];
      dry_run?: boolean;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const result = await client.executeCommand(absolutePath, command, commandArgs);
      const normalized = normalizeWorkspaceEdit(result);

      if (Object.keys(normalized.changes).length === 0) {
        const serialized =
          result === undefined || result === null ? 'null' : JSON.stringify(result).slice(0, 300);
        return textResult(
          `Command "${command}" returned no WorkspaceEdit. Raw result (truncated): ${serialized}`
        );
      }

      const changeLines: string[] = [];
      for (const [uri, edits] of Object.entries(normalized.changes)) {
        changeLines.push(`File: ${uriToPath(uri)}`);
        for (const e of edits) {
          const { start, end } = e.range;
          const preview = e.newText.replace(/\n/g, '\\n').slice(0, 120);
          changeLines.push(
            `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${preview}"`
          );
        }
      }

      if (dry_run) {
        return textResult(
          `[DRY RUN] Would apply result of "${command}":\n${changeLines.join('\n')}`
        );
      }

      const editResult = await applyWorkspaceEdit(normalized, { lspClient: client });
      if (!editResult.success)
        return textResult(`Failed to apply command result: ${editResult.error}`);
      return textResult(
        `Executed "${command}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
      );
    } catch (error) {
      return textResult(
        `Error executing command "${command}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

// -------------------------------------------------------------------
// Export registry
// -------------------------------------------------------------------

export const refactoringTools: ToolDefinition[] = [
  // Rename (pre-existing)
  renameSymbolTool,
  renameSymbolStrictTool,
  // Group A
  organizeImportsTool,
  generateToStringTool,
  generateHashCodeEqualsTool,
  generateConstructorsTool,
  generateGettersSettersTool,
  generateDelegateMethodsTool,
  overrideMethodsTool,
  // Group B
  addMissingImportsTool,
  removeUnusedImportsTool,
  addMissingMethodTool,
  addMissingFieldTool,
  addOverrideAnnotationTool,
  surroundWithTryCatchTool,
  addMissingReturnTool,
  // Group C
  extractVariableTool,
  extractConstantTool,
  extractMethodTool,
  extractFieldTool,
  inlineTool,
  introduceParameterTool,
  // Group D
  convertForLoopTool,
  invertBooleanOrConditionTool,
  convertLambdaAnonymousTool,
  convertMethodReferenceLambdaTool,
  convertAnonymousToNestedTool,
  // Group E
  moveMemberTool,
  moveInnerToTopLevelTool,
  extractInterfaceTool,
  extractSuperclassTool,
  // Group F
  codeActionTool,
  executeCommandTool,
];
