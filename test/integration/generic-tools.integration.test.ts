/**
 * Integration coverage for the two generic escape-hatch tools:
 *   - code_action: list or apply any code action by index
 *   - execute_command: raw workspace/executeCommand passthrough
 *
 * Proves the plumbing for tools that cover actions we haven't typed yet.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { codeActionTool, executeCommandTool } from '../../src/tools/refactoring.ts';
import { pathToUri } from '../../src/utils.ts';
import { getSession } from './session.ts';

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('generic escape-hatch tools (jdtls)', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    const session = await getSession();
    await Promise.all(created.map((p) => session.disposeFile(p)));
  });

  test('code_action lists the source actions jdtls offers on a plain class', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    const source = `package ${pkg};

public class Listed {
    private String name;
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/Listed.java`, source);
    created.push(file);

    const result = await codeActionTool.handler(
      {
        file_path: file,
        start_line: 1,
        start_character: 1,
        end_line: 5,
        end_character: 1,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    // We don't assume a specific set — jdtls's offered actions vary by
    // position and project state. We just assert we got a non-empty listing.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/Code actions|No code actions/);
  });

  test('execute_command returns a structured response (no crash) on an unknown command', async () => {
    // We don't rely on a specific jdtls-only command producing a WorkspaceEdit
    // (e.g. java.edit.organizeImports accepts different arg shapes depending
    // on project state). Instead we verify the tool's error/empty-result paths
    // handle an arbitrary command gracefully -- the plumbing is what matters,
    // and organize_imports already proves the WorkspaceEdit application path.
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    const source = `package ${pkg};
public class ExecCmdProbe {}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/ExecCmdProbe.java`, source);
    created.push(file);

    const result = await executeCommandTool.handler(
      {
        file_path: file,
        command: 'cclsp.integration.probe.nonexistent',
        arguments: [pathToUri(file)],
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    // Either the server rejected it (error) or it returned no edit — both are
    // legal responses that prove the tool didn't crash.
    expect(text).toMatch(/Error executing command|returned no WorkspaceEdit/);
  });
});
