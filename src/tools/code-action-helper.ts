import { applyWorkspaceEdit } from '../file-editor.js';
import type { LSPClient } from '../lsp-client.js';
import { type CodeAction, normalizeWorkspaceEdit } from '../lsp/operations.js';
import type { Position } from '../lsp/types.js';
import { uriToPath } from '../utils.js';
import { textResult } from './helpers.js';
import type { ToolResult } from './registry.js';

export interface ApplyCodeActionOptions {
  client: LSPClient;
  filePath: string;
  range: { start: Position; end: Position };
  only: string[];
  dryRun: boolean;
  /** Short verb for messages, e.g. "organize imports", "generate toString()". */
  description: string;
  /**
   * Optional exact-match filter on the action's `kind`. If provided, the
   * helper only picks actions whose kind equals or starts with one of these
   * strings (e.g. ["source.organizeImports", "source.organizeImports.java"]).
   * Defaults to `only`.
   */
  kindMatch?: string[];
  /**
   * Optional filter on the action's title (substring, case-insensitive).
   * Useful when many actions share the same kind and the server identifies
   * them only by title (e.g. "Override/implement Methods..." vs "Add missing...").
   */
  titleMatch?: string;
}

/**
 * The common shape of all code-action-backed refactoring tools:
 *   1. Ask the server for code actions under `filePath` / `range` / `only`.
 *   2. Pick the first action that matches our kind/title filter.
 *   3. Resolve the action if the server supports lazy resolution.
 *   4. If the action has an inline WorkspaceEdit, apply it.
 *   5. Otherwise, execute its command and apply the returned WorkspaceEdit.
 *   6. Report what changed, or return a helpful "nothing to do" message.
 */
export async function applyCodeAction(opts: ApplyCodeActionOptions): Promise<ToolResult> {
  const { client, filePath, range, only, dryRun, description, kindMatch, titleMatch } = opts;
  const match = kindMatch ?? only;

  try {
    const actions = await client.getCodeActions(filePath, range, only);

    const chosen = actions.find((a) => {
      if (!matchesKind(a, match)) return false;
      if (titleMatch && !a.title.toLowerCase().includes(titleMatch.toLowerCase())) return false;
      return true;
    });

    if (!chosen) {
      const offered = actions
        .map((a) => `  - "${a.title}" (kind=${a.kind ?? 'unknown'})`)
        .join('\n');
      const detail = offered
        ? `The server offered these actions instead:\n${offered}`
        : 'The server returned no code actions at this location.';
      return textResult(`No action available to ${description} at ${filePath}. ${detail}`);
    }

    const resolved = await client.resolveCodeAction(filePath, chosen);

    let normalized = normalizeWorkspaceEdit(resolved.edit);
    if (Object.keys(normalized.changes).length === 0 && resolved.command) {
      const commandResult = await client.executeCommand(
        filePath,
        resolved.command.command,
        resolved.command.arguments
      );
      normalized = normalizeWorkspaceEdit(commandResult);
    }

    if (Object.keys(normalized.changes).length === 0) {
      return textResult(
        `Action "${chosen.title}" produced no changes for ${filePath}. The code may already be in the target state.`
      );
    }

    const changeLines = formatEditSummary(normalized);

    if (dryRun) {
      return textResult(
        `[DRY RUN] Would ${description} (action: "${chosen.title}") in ${filePath}:\n${changeLines}`
      );
    }

    const editResult = await applyWorkspaceEdit(normalized, { lspClient: client });
    if (!editResult.success) {
      return textResult(`Failed to ${description}: ${editResult.error}`);
    }

    return textResult(
      `Applied "${chosen.title}" to ${filePath}.\n\nModified files:\n${editResult.filesModified
        .map((f) => `- ${f}`)
        .join('\n')}`
    );
  } catch (error) {
    return textResult(
      `Error running ${description}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function matchesKind(action: CodeAction, prefixes: string[]): boolean {
  if (!action.kind) return prefixes.length === 0;
  return prefixes.some((p) => action.kind === p || action.kind?.startsWith(`${p}.`));
}

function formatEditSummary(edit: {
  changes: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
}): string {
  const lines: string[] = [];
  for (const [uri, edits] of Object.entries(edit.changes)) {
    lines.push(`File: ${uriToPath(uri)}`);
    for (const e of edits) {
      const { start, end } = e.range;
      const preview = e.newText.replace(/\n/g, '\\n').slice(0, 120);
      lines.push(
        `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${preview}"`
      );
    }
  }
  return lines.join('\n');
}

/** Zero-width range at the start of the file — for whole-file source actions. */
export const FILE_TOP_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/** Helper for 1-indexed input coming from tool args. */
export function oneIndexedRangeToLsp(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number
): { start: Position; end: Position } {
  return {
    start: { line: startLine - 1, character: startCharacter - 1 },
    end: { line: endLine - 1, character: endCharacter - 1 },
  };
}

/** Zero-width range at a single 1-indexed position. */
export function oneIndexedPositionToLspRange(
  line: number,
  character: number
): { start: Position; end: Position } {
  const p = { line: line - 1, character: character - 1 };
  return { start: p, end: p };
}
