import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixtures: string[] = [];
const scriptPath = join(import.meta.dir, "../deploy.sh");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(installed: string | null = "original\n", testBody = "exit 0\n") {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "omp-mem-deploy-"));
  fixtures.push(base);
  const workspace = join(base, "workspace");
  const agent = join(base, "agent");
  const target = join(agent, "hooks/pre/claude-mem.ts");
  for (const dir of [join(workspace, "src"), join(workspace, "upstream"), join(workspace, "tests"), dirname(target), join(base, "bin")]) mkdirSync(dir, { recursive: true });
  copyFileSync(scriptPath, join(workspace, "deploy.sh"));
  writeFileSync(join(workspace, "src/claude-mem.ts"), "modified\n");
  writeFileSync(join(workspace, "upstream/claude-mem.ts"), "original\n");
  if (installed !== null) writeFileSync(target, installed);
  const stub = join(base, "bin/bun");
  writeFileSync(stub, `#!/usr/bin/env bash\n[[ "$*" = 'test tests' ]] || exit 99\n${testBody}`);
  chmodSync(stub, 0o755);
  return {
    base, workspace, agent, target,
    run: () => Bun.spawnSync(["bash", join(workspace, "deploy.sh")], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${join(base, "bin")}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    }),
    backups: () => existsSync(join(workspace, "backups")) ? readdirSync(join(workspace, "backups")) : [],
  };
}

afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("guarded deployment", () => {
  test("backs up baseline bytes and permissions, installs normal file and records checksum", () => {
    const f = fixture();
    chmodSync(f.target, 0o640);
    const result = f.run();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe("modified\n");
    expect(lstatSync(f.target).isSymbolicLink()).toBe(false);
    expect(f.backups()).toHaveLength(1);
    const backup = join(f.workspace, "backups", f.backups()[0]);
    expect(readFileSync(backup, "utf8")).toBe("original\n");
    expect(statSync(backup).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(f.workspace, ".last-deployed.sha256"), "utf8").trim()).toBe(hash("modified\n"));
    expect(readFileSync(join(f.workspace, "reports/deployment-latest.txt"), "utf8")).toContain(hash("modified\n"));
    expect(f.run().exitCode).toBe(0);
    expect(f.backups()).toHaveLength(1);
  });

  test("accepts a previously deployed version and creates a distinct backup", () => {
    const f = fixture("previous\n");
    writeFileSync(join(f.workspace, ".last-deployed.sha256"), `${hash("previous\n")}\n`);
    expect(f.run().exitCode).toBe(0);
    expect(readFileSync(join(f.workspace, "backups", f.backups()[0]), "utf8")).toBe("previous\n");
  });

  test("accepts a later recorded upstream original and backs it up", () => {
    const f = fixture("official v2\n");
    mkdirSync(join(f.workspace, "upstream/v2"));
    writeFileSync(join(f.workspace, "upstream/v2/claude-mem.ts"), "official v2\n");
    expect(f.run().exitCode).toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe("modified\n");
    expect(readFileSync(join(f.workspace, "backups", f.backups()[0]), "utf8")).toBe("official v2\n");
  });

  test("a symlinked later upstream original is refused", () => {
    const f = fixture("original\n");
    mkdirSync(join(f.workspace, "upstream/v2"));
    symlinkSync(join(f.workspace, "src/claude-mem.ts"), join(f.workspace, "upstream/v2/claude-mem.ts"));
    expect(f.run().exitCode).not.toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe("original\n");
  });

  test("fresh installation needs no backup", () => {
    const f = fixture(null);
    expect(f.run().exitCode).toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe("modified\n");
    expect(f.backups()).toHaveLength(0);
  });

  test("unknown installed edits are preserved", () => {
    const f = fixture("unknown\n");
    const result = f.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown changes");
    expect(readFileSync(f.target, "utf8")).toBe("unknown\n");
    expect(f.backups()).toHaveLength(0);
  });

  test("failed tests cannot replace the installed hook", () => {
    const f = fixture("original\n", "exit 42\n");
    expect(f.run().exitCode).toBe(42);
    expect(readFileSync(f.target, "utf8")).toBe("original\n");
    expect(f.backups()).toHaveLength(0);
  });

  test("a target changed during tests is preserved", () => {
    const f = fixture("original\n", 'printf "concurrent edit\\n" > "$PI_CODING_AGENT_DIR/hooks/pre/claude-mem.ts"\n');
    const result = f.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("changed during checks");
    expect(readFileSync(f.target, "utf8")).toBe("concurrent edit\n");
    expect(f.backups()).toHaveLength(0);
  });

  test("source changed during tests cannot install untested bytes", () => {
    const f = fixture("original\n", 'printf "untested edit\\n" > src/claude-mem.ts\n');
    expect(f.run().exitCode).not.toBe(0);
    expect(readFileSync(f.target, "utf8")).toBe("original\n");
  });

  test("rejects symlink and non-file destinations", () => {
    for (const kind of ["target", "ancestor", "directory"] as const) {
      const f = fixture(null);
      if (kind === "target") symlinkSync(join(f.workspace, "src/claude-mem.ts"), f.target);
      if (kind === "ancestor") {
        rmSync(join(f.agent, "hooks"), { recursive: true });
        mkdirSync(join(f.base, "elsewhere/pre"), { recursive: true });
        symlinkSync(join(f.base, "elsewhere"), join(f.agent, "hooks"));
      }
      if (kind === "directory") mkdirSync(f.target);
      expect(f.run().exitCode).not.toBe(0);
      expect(readFileSync(join(f.workspace, "src/claude-mem.ts"), "utf8")).toBe("modified\n");
      expect(f.backups()).toHaveLength(0);
    }
  });
});
