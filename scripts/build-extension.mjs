import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const extensionSourceDir = path.join(projectRoot, "extension");
const buildRoot = path.join(projectRoot, ".build", "extension");
const stageDir = path.join(buildRoot, "cbrowse");
const releaseDir = path.join(projectRoot, "release");
const keyDir = path.join(releaseDir, "keys");
const defaultKeyPath = path.join(keyDir, "cbrowse-extension.pem");
const manifestPath = path.join(extensionSourceDir, "manifest.json");
const licensePath = path.join(projectRoot, "LICENSE");

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate.includes(path.sep) && fs.existsSync(candidate)) {
      return candidate;
    }

    try {
      execFileSync("bash", ["-lc", `command -v ${candidate}`], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue.
    }
  }

  return null;
}

async function fileExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureCleanDir(dirPath) {
  await rm(dirPath, { recursive: true, force: true });
  await mkdir(dirPath, { recursive: true });
}

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.version;
  const zipName = `cBrowse-extension-v${version}.zip`;
  const crxName = `cBrowse-extension-v${version}.crx`;
  const zipPath = path.join(releaseDir, zipName);
  const crxPath = path.join(releaseDir, crxName);
  const requestedKeyPath = process.env.CBROWSE_EXTENSION_KEY || defaultKeyPath;
  const allowGeneratedKey = process.env.CBROWSE_GENERATE_KEY === "1";

  await ensureCleanDir(buildRoot);
  await mkdir(releaseDir, { recursive: true });
  await mkdir(keyDir, { recursive: true });
  await cp(extensionSourceDir, stageDir, { recursive: true });
  await cp(licensePath, path.join(stageDir, "LICENSE"));

  execFileSync("zip", ["-qr", zipPath, "."], { cwd: stageDir, stdio: "inherit" });

  const chromeBinary = findChromeBinary();
  let builtCrx = false;

  const hasExistingKey = await fileExists(requestedKeyPath);

  if (chromeBinary && (hasExistingKey || allowGeneratedKey)) {
    const chromeArgs = [`--pack-extension=${stageDir}`];
    if (hasExistingKey) {
      chromeArgs.push(`--pack-extension-key=${requestedKeyPath}`);
    }

    execFileSync(chromeBinary, chromeArgs, {
      stdio: "pipe",
      env: {
        ...process.env,
        HOME: process.env.HOME,
      },
    });

    const generatedCrxPath = `${stageDir}.crx`;
    const generatedPemPath = `${stageDir}.pem`;

    if (await fileExists(generatedCrxPath)) {
      await rm(crxPath, { force: true });
      await rename(generatedCrxPath, crxPath);
      builtCrx = true;
    }

    if (!hasExistingKey && (await fileExists(generatedPemPath))) {
      await rename(generatedPemPath, requestedKeyPath);
    } else if (await fileExists(generatedPemPath)) {
      await rm(generatedPemPath, { force: true });
    }
  }

  const checksumLines = [`${await sha256(zipPath)}  ${path.basename(zipPath)}`];
  if (builtCrx) {
    checksumLines.push(`${await sha256(crxPath)}  ${path.basename(crxPath)}`);
  }
  await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`);

  console.log(
    JSON.stringify(
      {
        version,
        zip: zipPath,
        crx: builtCrx ? crxPath : null,
        key: (await fileExists(requestedKeyPath)) ? requestedKeyPath : null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
