import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);

export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!/^[a-zA-Z0-9_-]+$/.test(config.id ?? ""))
    throw new Error("Invalid business id");
  if (!Array.isArray(config.repositories) || !config.repositories.length)
    throw new Error("Repositories required");
  const names = new Set();
  for (const repo of config.repositories) {
    if (!repo.name || names.has(repo.name) || typeof repo.path !== "string")
      throw new Error("Unique repository names and paths required");
    names.add(repo.name);
    repo.path = path.resolve(path.dirname(file), repo.path);
    for (const key of ["include", "exclude"]) {
      if (
        repo[key] !== undefined &&
        (!Array.isArray(repo[key]) ||
          repo[key].some((x) => typeof x !== "string"))
      )
        throw new Error(`Invalid ${key}`);
    }
  }
  for (const [key, fallback, min] of [
    ["intervalSeconds", 86400, 1],
    ["batchCharacters", 40000, 1000],
    ["timeoutSeconds", 180, 1],
  ]) {
    config[key] ??= fallback;
    if (!Number.isSafeInteger(config[key]) || config[key] < min)
      throw new Error(`Invalid ${key}`);
    if (key !== "batchCharacters" && config[key] > 2147483)
      throw new Error(`${key} exceeds supported timer range`);
  }
  if (!config.model?.provider || !config.model?.id)
    throw new Error("Model provider and id required");
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      config.model.thinking ?? "low",
    )
  )
    throw new Error("Invalid thinking level");
  return config;
}

export function matches(file, patterns) {
  return patterns.some((pattern) => path.matchesGlob(file, pattern));
}

export async function snapshot(config) {
  const files = [],
    skipped = [],
    revisions = {};
  for (const repo of config.repositories) {
    const repositoryRoot = await realpath(repo.path);
    const git = async (args) =>
      (
        await execute(
          "git",
          [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-C",
            repo.path,
            ...args,
          ],
          {
            maxBuffer: 32 * 1024 * 1024,
          },
        )
      ).stdout;
    revisions[repo.name] = {
      head: (await git(["rev-parse", "HEAD"])).trim(),
      dirty: Boolean((await git(["status", "--porcelain"])).trim()),
    };
    const names = (await git(["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const name of names) {
      const id = `${repo.name}/${name}`;
      if (
        (repo.include?.length && !matches(name, repo.include)) ||
        matches(name, repo.exclude ?? [])
      ) {
        skipped.push({ file: id, reason: "outside configured scope" });
        continue;
      }
      // Secret files and symbolic links are never sent to the model.
      if (/(^|\/)(\.env(?:\..*)?|auth\.json)$|\.(pem|key|p12)$/i.test(name)) {
        skipped.push({ file: id, reason: "credential file" });
        continue;
      }
      const full = path.resolve(repo.path, name);
      let stat;
      try {
        stat = await lstat(full);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        skipped.push({ file: id, reason: "missing from working tree" });
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ file: id, reason: "not a regular file" });
        continue;
      }
      const canonical = await realpath(full);
      if (!canonical.startsWith(repositoryRoot + path.sep)) {
        skipped.push({ file: id, reason: "resolved path outside repository" });
        continue;
      }
      const buffer = await readFile(canonical);
      if (buffer.includes(0)) {
        skipped.push({ file: id, reason: "binary" });
        continue;
      }
      const text = buffer.toString("utf8");
      files.push({ id, text });
    }
  }
  return { files, skipped, revisions };
}

export function batches(files, limit) {
  const result = [];
  let batch = [],
    size = 0;
  const add = (part) => {
    if (size + part.content.length > limit && batch.length) {
      result.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(part);
    size += part.content.length;
  };
  for (const file of files) {
    const lines = file.text.split("\n");
    let chunk = [],
      length = 0,
      start = 1;
    const flush = () => {
      if (!chunk.length) return;
      const part = {
        file: file.id,
        start,
        end: start + chunk.length - 1,
        content: chunk.join("\n"),
      };
      add(part);
      start += chunk.length;
      chunk = [];
      length = 0;
    };
    for (const line of lines) {
      if (line.length > limit) {
        flush();
        for (let offset = 0; offset < line.length;) {
          let end = Math.min(offset + limit, line.length);
          // Keep UTF-16 surrogate pairs together at fragment boundaries.
          if (
            end < line.length &&
            /[\uD800-\uDBFF]/.test(line[end - 1]) &&
            /[\uDC00-\uDFFF]/.test(line[end])
          )
            end--;
          if (end === offset)
            throw new Error("Batch limit too small for Unicode character");
          add({
            file: file.id,
            start,
            end: start,
            startColumn: offset + 1,
            endColumn: end,
            content: line.slice(offset, end),
          });
          offset = end;
        }
        start++;
        continue;
      }
      if (length + line.length + (chunk.length ? 1 : 0) > limit) flush();
      chunk.push(line);
      length += line.length + (chunk.length > 1 ? 1 : 0);
    }
    flush();
  }
  if (batch.length) result.push(batch);
  return result;
}

export function validateFindings(raw, batch) {
  const parsed = JSON.parse(
    raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
  );
  if (!Array.isArray(parsed.findings))
    throw new Error("Expected findings array");
  for (const finding of parsed.findings) {
    const part = batch.find(
      (p) =>
        p.file === finding.file &&
        Number.isInteger(finding.line) &&
        finding.line >= p.start &&
        finding.line <= p.end,
    );
    if (
      !part ||
      !["high", "medium", "low"].includes(finding.severity) ||
      ["title", "explanation", "trigger", "evidence"].some(
        (k) => typeof finding[k] !== "string" || !finding[k].trim(),
      ) ||
      !part.content
        .split("\n")
        [finding.line - part.start].includes(finding.evidence)
    )
      throw new Error("Finding has invalid location or evidence");
  }
  return parsed.findings;
}

async function save(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${file}.tmp`, file);
}

export async function runReview(
  config,
  root,
  review,
  onProgress = async () => {},
) {
  const dir = path.join(root, config.id);
  await mkdir(dir, { recursive: true });
  const { open } = await import("node:fs/promises");
  const lock = await open(path.join(dir, "run.lock"), "wx").catch(() => {
    throw new Error(
      "Review locked; verify no active process before removing run.lock",
    );
  });
  try {
    const input = await snapshot(config);
    if (!input.files.length)
      throw new Error("No reviewable tracked files in configured scope");
    const chunks = batches(input.files, config.batchCharacters);
    const hash = createHash("sha256")
      .update(JSON.stringify({ reviewFormatVersion: 2, config, input }))
      .digest("hex");
    const stateFile = path.join(dir, `${hash}.json`);
    let state;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    state ??= {
      id: hash,
      startedAt: new Date().toISOString(),
      status: "running",
      revisions: input.revisions,
      skipped: input.skipped,
      totalBatches: chunks.length,
      completed: [],
      findings: [],
    };
    state.status = "running";
    delete state.error;
    await save(stateFile, state);
    await onProgress(structuredClone(state));
    try {
      for (let i = state.completed.length; i < chunks.length; i++) {
        const raw = await review(chunks[i], config, {
          index: i,
          total: chunks.length,
          files: input.files.map((f) => f.id),
        });
        const findings = validateFindings(raw, chunks[i]);
        state.findings.push(...findings);
        state.completed.push({
          index: i,
          ranges: chunks[i].map(({ content, ...range }) => range),
          finishedAt: new Date().toISOString(),
        });
        await save(stateFile, state);
        await onProgress(structuredClone(state));
      }
      state.findings = [
        ...new Map(
          state.findings.map((f) => [`${f.file}:${f.line}:${f.title}`, f]),
        ).values(),
      ];
      state.status = "completed";
      state.finishedAt = new Date().toISOString();
    } catch (error) {
      state.status = "failed";
      state.error = error.message;
      throw error;
    } finally {
      await save(stateFile, state);
      await save(path.join(dir, "latest.json"), state);
    }
    return state;
  } finally {
    await lock.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(dir, "run.lock"));
  }
}
