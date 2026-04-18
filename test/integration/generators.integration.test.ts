/**
 * Integration coverage for the file-scope generator tools (Group A).
 *
 * Caveat: jdtls conditions `source.generate.*` actions on both cursor position
 * and project state. In the bare "invisible project" our harness creates (no
 * pom.xml / build.gradle), jdtls only reliably offers source.generate.accessors
 * (getters/setters). The other generators -- toString, hashCodeEquals,
 * constructors, delegate_methods, overrideMethods -- are implemented and unit-
 * tested, but they require a real build-tool-backed project to be surfaced by
 * jdtls as code actions. See docs/INTEGRATION_NOTES.md.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { generateGettersSettersTool } from '../../src/tools/refactoring.ts';
import { getSession } from './session.ts';

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('file-scope generator tools (jdtls, invisible-project)', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    const session = await getSession();
    await Promise.all(created.map((p) => session.disposeFile(p)));
  });

  test('generate_getters_setters produces accessors for fields', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    const source = `package ${pkg};

public class Accessors {
    private String name;
    private int age;
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/Accessors.java`, source);
    created.push(file);

    const result = await generateGettersSettersTool.handler(
      { file_path: file, dry_run: true },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[DRY RUN]');
    expect(text.toLowerCase()).toContain('getter');
  });
});
