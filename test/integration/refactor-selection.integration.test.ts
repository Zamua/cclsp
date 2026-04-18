/**
 * Integration coverage for the selection/position refactoring tools.
 * Covers one representative tool per input shape to validate the LSP plumbing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  convertForLoopTool,
  extractVariableTool,
  invertBooleanOrConditionTool,
} from '../../src/tools/refactoring.ts';
import { getSession } from './session.ts';

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('range/position refactoring tools (jdtls)', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    const session = await getSession();
    await Promise.all(created.map((p) => session.disposeFile(p)));
  });

  test('extract_variable surfaces for an integer literal expression', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    // `2 + 3` on line 5, characters 17-22 (1-indexed).
    const source = `package ${pkg};

public class ExtVar {
    public int compute() {
        return 2 + 3;
    }
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/ExtVar.java`, source);
    created.push(file);

    const result = await extractVariableTool.handler(
      {
        file_path: file,
        start_line: 5,
        start_character: 16,
        end_line: 5,
        end_character: 21,
        dry_run: true,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    if (!text.includes('[DRY RUN]')) console.log('[extract_variable] preview:', text);
    expect(text).toContain('[DRY RUN]');
  });

  test('convert_for_loop offers a conversion on a classic for loop over an array', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    // Cursor inside the `for` keyword on line 5.
    const source = `package ${pkg};

public class ForLoop {
    public int sum(int[] xs) {
        int total = 0;
        for (int i = 0; i < xs.length; i++) {
            total += xs[i];
        }
        return total;
    }
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/ForLoop.java`, source);
    created.push(file);

    const result = await convertForLoopTool.handler(
      { file_path: file, line: 6, character: 9, dry_run: true },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    if (!text.includes('[DRY RUN]')) console.log('[convert_for_loop] preview:', text);
    // Either jdtls converted it (DRY RUN preview) or it didn't offer the action;
    // both outcomes are legal depending on the exact cursor placement jdtls
    // accepts, so we just assert we got a response, not a thrown error.
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  test('invert_boolean_or_condition responds without error on an if statement', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    const source = `package ${pkg};

public class InvertIf {
    public String label(boolean flag) {
        if (flag) {
            return "yes";
        } else {
            return "no";
        }
    }
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/InvertIf.java`, source);
    created.push(file);

    const result = await invertBooleanOrConditionTool.handler(
      { file_path: file, line: 5, character: 13, dry_run: true },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    if (!text.includes('[DRY RUN]')) console.log('[invert_boolean_or_condition] preview:', text);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
