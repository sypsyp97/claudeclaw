import { execSync, spawnSync } from "node:child_process";
import { access, chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { statSync, type Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./config";
import { whisperDir } from "./paths";

// ---------------------------------------------------------------------------
// Single config object for every on-disk location and remote fact the
// module needs. Computed once at import time from whisperDir() + the
// module URL, then treated as read-only.
// ---------------------------------------------------------------------------

const CFG = (() => {
  const root = whisperDir();
  const modelName = "base.en";
  return {
    root,
    bin: join(root, "bin"),
    lib: join(root, "lib"),
    models: join(root, "models"),
    scratch: join(root, "tmp"),
    modelName,
    modelFileName: `ggml-${modelName}.bin`,
    modelUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`,
    oggBridge: fileURLToPath(new URL("./ogg.mjs", import.meta.url)),
    pluginRoot: fileURLToPath(new URL("..", import.meta.url)),
  } as const;
})();

interface ArchiveSource {
  url: string;
  kind: "tar.gz" | "zip";
  headers?: Record<string, string>;
}

// Bearer QQ== is base64("A"). GHCR demands a header before vending
// homebrew blobs — anonymous, so any non-empty bearer is accepted.
const GHCR_AUTH = { Authorization: "Bearer QQ==" } as const;

function pickBinarySource(platform: string, arch: string): ArchiveSource | null {
  switch (`${platform}-${arch}`) {
    case "linux-x64":
      return {
        url: "https://github.com/dscripka/whisper.cpp_binaries/releases/download/commit_3d42463/whisper-bin-linux-x64.tar.gz",
        kind: "tar.gz",
      };
    case "linux-arm64":
      return {
        url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:684199fd6bec28cddfa086c584a49d236386c109f901a443b577b857fd052f83",
        kind: "tar.gz",
        headers: { ...GHCR_AUTH },
      };
    case "darwin-arm64":
      return {
        url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:f0901568c7babbd3022a043887007400e4b57a22d3a90b9c0824d01fa3a77270",
        kind: "tar.gz",
        headers: { ...GHCR_AUTH },
      };
    case "darwin-x64":
      return {
        url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:e6c2f78cbc5d6b311dfe24d8c5d4ffc68a634465c5e35ed11746068583d273c4",
        kind: "tar.gz",
        headers: { ...GHCR_AUTH },
      };
    case "win32-x64":
      return {
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip",
        kind: "zip",
      };
    default:
      return null;
  }
}

const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64"] as const;

type LineSink = (message: string) => void;

const SILENT: LineSink = () => {};

let pendingWarmup: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Path helpers — derived from CFG, kept as tiny functions so the platform
// suffix lives in exactly one place.
// ---------------------------------------------------------------------------

function binaryPath(): string {
  return join(CFG.bin, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

function modelPath(): string {
  return join(CFG.models, CFG.modelFileName);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Iterative DFS for the whisper executable. The extracted tarball layout
// varies between the Homebrew bottle (nested under Cellar/...), the dscripka
// release (flat), and the ggml-org release (inside a build/ dir).
async function findTool(root: string, candidates: string[]): Promise<string | null> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const wanted = new Set<string>();
  for (const c of candidates) {
    wanted.add(c + suffix);
    if (suffix) wanted.add(c);
  }

  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && wanted.has(e.name)) {
        return full;
      }
    }
  }
  return null;
}

function prettySize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Resumable downloader. Keeps a `.tmp` sidecar until the transfer succeeds
// so a crash mid-way does not leave a half-written final file.
// ---------------------------------------------------------------------------

interface FetchOpts {
  url: string;
  target: string;
  headers?: Record<string, string>;
}

async function fetchWithResume({ url, target, headers }: FetchOpts): Promise<void> {
  const scratch = `${target}.tmp`;

  let offset = await stat(scratch).then((s) => s.size).catch(() => 0);
  const outboundHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (offset > 0) {
    outboundHeaders["Range"] = `bytes=${offset}-`;
    console.log(`whisper: resuming download from ${prettySize(offset)}`);
  }

  const res = await fetch(url, { redirect: "follow", headers: outboundHeaders });
  const resuming = offset > 0 && res.status === 206;
  if (!resuming && !res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }

  // Server returned the whole thing despite our Range header — wipe progress.
  if (offset > 0 && res.status === 200) {
    await rm(scratch, { force: true });
    offset = 0;
  }

  const body = res.body;
  if (!body) throw new Error("No response body");

  const declaredLen = Number(res.headers.get("content-length") || 0);
  const grandTotal = resuming ? offset + declaredLen : declaredLen;

  const fh = await open(scratch, resuming ? "a" : "w");
  let written = resuming ? offset : 0;
  let lastTick = Date.now();
  try {
    for await (const chunk of body) {
      await fh.write(new Uint8Array(chunk));
      written += chunk.byteLength;
      const now = Date.now();
      if (grandTotal > 0 && now - lastTick > 2000) {
        const pct = Math.round((written / grandTotal) * 100);
        console.log(
          `whisper: downloading ${prettySize(written)} / ${prettySize(grandTotal)} (${pct}%)`
        );
        lastTick = now;
      }
    }
  } finally {
    await fh.close();
  }

  await rename(scratch, target);
}

// ---------------------------------------------------------------------------
// Binary provisioning: download archive -> extract -> scoop up whisper-cli
// and any sibling .so/.dylib libraries -> chmod. Collapsed into one
// orchestrator rather than spread across three helpers.
// ---------------------------------------------------------------------------

async function installBinary(): Promise<void> {
  const key = `${process.platform}-${process.arch}`;
  const source = pickBinarySource(process.platform, process.arch);
  if (!source) {
    throw new Error(
      `No pre-built whisper binary for ${key}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}`
    );
  }

  const unpackDir = join(CFG.scratch, "extract");
  await rm(unpackDir, { recursive: true, force: true });
  await Promise.all([
    mkdir(unpackDir, { recursive: true }),
    mkdir(CFG.bin, { recursive: true }),
    mkdir(CFG.lib, { recursive: true }),
  ]);

  const archiveFile = join(CFG.scratch, `whisper-bin.${source.kind === "tar.gz" ? "tar.gz" : "zip"}`);
  console.log(`whisper: downloading binary for ${key}...`);
  await fetchWithResume({ url: source.url, target: archiveFile, headers: source.headers });

  console.log("whisper: extracting...");
  const extractCmd =
    source.kind === "tar.gz"
      ? ["tar", "xzf", archiveFile, "-C", unpackDir]
      : ["unzip", "-o", archiveFile, "-d", unpackDir];
  const extractRes = Bun.spawnSync(extractCmd);
  if (extractRes.exitCode !== 0) {
    throw new Error(
      `Failed to extract ${source.kind}: ${extractRes.stderr.toString()}`
    );
  }

  const exeSource = await findTool(unpackDir, ["whisper-cli", "main"]);
  if (!exeSource) {
    throw new Error("Could not find whisper-cli or main binary in downloaded archive");
  }

  const exeDest = binaryPath();
  await Bun.write(exeDest, Bun.file(exeSource));
  if (process.platform !== "win32") {
    await chmod(exeDest, 0o755);
  } else {
    // chmod is a no-op on Windows but keep the call to match cross-platform
    // behaviour where the parent mounts WSL/Cygwin views.
    await chmod(exeDest, 0o755).catch(() => {});
  }

  // Homebrew bottles bundle libwhisper + libggml as .dylib; the linux-arm64
  // mirror does the same with .so. Copy every whisper-named shared lib into
  // CFG.lib so LD_LIBRARY_PATH picks them up at runtime.
  const libEntries: Dirent[] = await readdir(unpackDir, {
    withFileTypes: true,
    recursive: true,
  }).catch(() => [] as Dirent[]);
  for (const entry of libEntries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const isSharedLib =
      name.includes("whisper") &&
      (name.endsWith(".so") || name.endsWith(".dylib") || /\.so\.\d/.test(name));
    if (!isSharedLib) continue;
    const parent = (entry as unknown as { parentPath?: string }).parentPath ?? "";
    await Bun.write(join(CFG.lib, name), Bun.file(join(parent, name)));
  }

  await Promise.all([
    rm(unpackDir, { recursive: true, force: true }),
    rm(archiveFile, { force: true }),
  ]);
  console.log("whisper: binary ready");
}

async function installModel(): Promise<void> {
  const dest = modelPath();
  if (await pathExists(dest)) return;
  await mkdir(CFG.models, { recursive: true });
  console.log(`whisper: downloading model ${CFG.modelName}...`);
  await fetchWithResume({ url: CFG.modelUrl, target: dest });
  console.log("whisper: model ready");
}

async function provisionAssets(): Promise<void> {
  const t0 = Date.now();
  console.log(`whisper warmup: start root=${CFG.root} model=${CFG.modelName}`);
  await mkdir(CFG.root, { recursive: true });
  await mkdir(CFG.scratch, { recursive: true });

  if (await pathExists(binaryPath())) {
    console.log("whisper warmup: binary exists");
  } else {
    await installBinary();
  }
  await installModel();

  console.log(`whisper warmup: complete in ${Date.now() - t0}ms`);
}

// ---------------------------------------------------------------------------
// ogg->wav bridge. Runs the bundled ogg.mjs script under node because
// ogg-opus-decoder is distributed as a Node-friendly ESM-wasm hybrid that
// Bun's own loader chokes on under some release channels.
// ---------------------------------------------------------------------------

function ensureOggDecoder(): void {
  const marker = join(CFG.pluginRoot, "node_modules", "ogg-opus-decoder");
  try {
    statSync(marker);
    return;
  } catch {
    // fall through
  }
  console.log("whisper: installing ogg-opus-decoder...");
  let pm = "npm";
  try {
    execSync("bun --version", { stdio: "ignore" });
    pm = "bun";
  } catch {
    // bun not on PATH — npm is fine.
  }
  execSync(`${pm} install`, { cwd: CFG.pluginRoot, stdio: "inherit" });
}

function runOggToWav(input: string, wav: string, log: LineSink): void {
  ensureOggDecoder();
  log("voice decode: running node converter");
  const out = spawnSync("node", [CFG.oggBridge, input, wav], { encoding: "utf8" });
  if (out.status !== 0) {
    const err = (out.stderr ?? "").trim();
    const std = (out.stdout ?? "").trim();
    const suffix = err ? `: ${err}` : std ? `: ${std}` : "";
    throw new Error(`node decode failed (exit ${out.status ?? "unknown"})${suffix}`);
  }
  const stderr = (out.stderr ?? "").trim();
  if (stderr) log(`voice decode(node): ${stderr}`);
  log("voice decode: node converter completed");
}

async function prepWav(input: string, log: LineSink): Promise<string> {
  const ext = extname(input).toLowerCase();
  log(`voice input: path=${input} ext=${ext || "(none)"}`);
  if (ext === ".wav") return input;
  if (ext !== ".ogg" && ext !== ".oga") {
    throw new Error(
      `unsupported audio format "${ext || "(none)"}" without ffmpeg; supported: .oga, .ogg, .wav`
    );
  }
  const wav = join(
    CFG.scratch,
    `${basename(input, extname(input))}-${Date.now()}.wav`
  );
  runOggToWav(input, wav, log);
  return wav;
}

// ---------------------------------------------------------------------------
// Remote HTTP backend (OpenAI-compatible /v1/audio/transcriptions). Used when
// settings.stt.baseUrl is set — covered by the test suite.
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  webm: "audio/webm",
};

async function viaHttpApi(
  input: string,
  baseUrl: string,
  modelName: string,
  log: LineSink
): Promise<string> {
  const model = modelName || "Systran/faster-whisper-large-v3";
  const endpoint = `${baseUrl}/v1/audio/transcriptions`;
  log(`voice transcribe: using STT API url=${endpoint} model=${model}`);

  const bytes = await readFile(input);
  const ext = extname(input).toLowerCase().replace(".", "") || "ogg";
  const mime = EXT_TO_MIME[ext] ?? "audio/ogg";

  const body = new FormData();
  body.append("file", new Blob([bytes], { type: mime }), `audio.${ext}`);
  body.append("model", model);

  const res = await fetch(endpoint, { method: "POST", body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`STT API error (${res.status}): ${detail}`);
  }
  const payload = (await res.json()) as { text?: string };
  const text = (payload.text ?? "").trim();
  log(`voice transcribe: API transcript chars=${text.length}`);
  return text;
}

// ---------------------------------------------------------------------------
// Local whisper.cpp backend. Spawns the cached binary, runs it against the
// GGML model, cleans the stdout, and falls back to a one-shot
// re-download-and-retry when the binary itself has gone missing.
// ---------------------------------------------------------------------------

function runWhisper(wav: string): string {
  const libPathJoin = (existing: string | undefined) =>
    [CFG.lib, existing].filter(Boolean).join(":");

  const proc = Bun.spawnSync(
    [binaryPath(), "-m", modelPath(), "-f", wav, "--no-timestamps"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LD_LIBRARY_PATH: libPathJoin(process.env.LD_LIBRARY_PATH),
        DYLD_LIBRARY_PATH: libPathJoin(process.env.DYLD_LIBRARY_PATH),
      },
    }
  );

  if (proc.exitCode !== 0) {
    const tail = proc.stderr.toString().trim();
    throw new Error(`whisper transcription failed (exit ${proc.exitCode}): ${tail}`);
  }
  return proc.stdout.toString();
}

function cleanTranscript(raw: string): string {
  // Drop blank lines + [BLANK_AUDIO] markers, flatten to single-space prose.
  return raw
    .replace(/\[BLANK_AUDIO\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function viaLocalBinary(input: string, log: LineSink): Promise<string> {
  await warmupWhisperAssets();
  log(`voice transcribe: warmup ready cwd=${process.cwd()} input=${input}`);

  try {
    const info = await stat(input);
    log(`voice transcribe: input size=${info.size} bytes`);
  } catch (err) {
    log(
      `voice transcribe: failed to stat input - ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const wav = await prepWav(input, log);
  const disposable = wav !== input;
  log(`voice transcribe: using wav=${wav} cleanup=${disposable}`);

  try {
    let stdout: string;
    try {
      stdout = runWhisper(wav);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) throw err;
      log("voice transcribe: missing whisper executable, forcing re-download and retry");
      pendingWarmup = null;
      await rm(CFG.bin, { recursive: true, force: true });
      await warmupWhisperAssets();
      stdout = runWhisper(wav);
    }
    const transcript = cleanTranscript(stdout);
    log(`voice transcribe: transcript chars=${transcript.length}`);
    return transcript;
  } finally {
    if (disposable) {
      log(`voice transcribe: cleanup wav=${wav}`);
      await rm(wav, { force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — names and shapes frozen by the test suite and callers.
// ---------------------------------------------------------------------------

export function warmupWhisperAssets(options?: { printOutput?: boolean }): Promise<void> {
  const printOutput = options?.printOutput ?? false;
  if (pendingWarmup) {
    console.log("whisper warmup: reusing in-flight warmup promise");
    return pendingWarmup;
  }
  console.log(`whisper warmup: creating warmup promise printOutput=${printOutput}`);
  pendingWarmup = provisionAssets().catch((err) => {
    console.error(
      `whisper warmup: failed - ${err instanceof Error ? err.message : String(err)}`
    );
    pendingWarmup = null;
    throw err;
  });
  return pendingWarmup;
}

export async function transcribeAudioToText(
  inputPath: string,
  options?: { debug?: boolean; log?: (message: string) => void }
): Promise<string> {
  const log: LineSink = options?.debug ? options.log ?? console.log : SILENT;

  const stt = getSettings().stt;
  if (stt?.baseUrl) {
    return viaHttpApi(inputPath, stt.baseUrl, stt.model, log);
  }
  return viaLocalBinary(inputPath, log);
}
