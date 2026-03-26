import { cp, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const sourceSkillDir = path.join(projectRoot, ".agents", "skills", "cbrowse");
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const targetSkillDir = path.join(codexHome, "skills", "cbrowse");

async function ensureSourceSkillExists(): Promise<void> {
  await stat(sourceSkillDir);
}

async function install(): Promise<void> {
  await ensureSourceSkillExists();
  await mkdir(path.dirname(targetSkillDir), { recursive: true });
  await cp(sourceSkillDir, targetSkillDir, {
    recursive: true,
    force: true,
  });

  console.log(`Installed Codex skill to ${targetSkillDir}`);
}

install().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
