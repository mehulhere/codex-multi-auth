import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");

export function getRepoRoot() {
  return repoRoot;
}

function resolveWindowsNpmShim(command) {
  if (!/\.(cmd|bat)$/i.test(command)) {
    return { command, shell: false };
  }

  const codexScript = join(dirname(command), "node_modules", "codex-multi-auth", "scripts", "codex.js");
  if (existsSync(codexScript)) {
    return {
      command: process.execPath,
      shell: false,
      argsPrefix: [codexScript],
      shimCommand: command,
    };
  }

  return { command, shell: true };
}

export function resolveCodexExecutable() {
  const envOverride = process.env.CODEX_BIN;
  if (envOverride && envOverride.trim().length > 0) {
    const command = envOverride.trim();
    return process.platform === "win32" ? resolveWindowsNpmShim(command) : { command, shell: false };
  }

  if (process.platform !== "win32") {
    return { command: "codex", shell: false };
  }

  const whereResult = spawnSync("where", ["Codex"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const candidates = `${whereResult.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z]:\\.+\.(exe|cmd)$/i.test(line));

  if (candidates.length === 0) {
    return { command: "codex", shell: false };
  }

  const exactExe = candidates.find((candidate) => /npm\\Codex\.exe$/i.test(candidate));
  if (exactExe) {
    return { command: exactExe, shell: false };
  }

  const exactCmd = candidates.find((candidate) => /npm\\Codex\.cmd$/i.test(candidate));
  if (exactCmd) {
    return resolveWindowsNpmShim(exactCmd);
  }

  const anyCmd = candidates.find((candidate) => /\.cmd$/i.test(candidate));
  if (anyCmd) {
    return resolveWindowsNpmShim(anyCmd);
  }

  return { command: candidates[0], shell: false };
}

export function parseNdjson(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines emitted by wrappers (bun install, warnings, etc.).
    }
  }
  return events;
}

export function getToolEvents(events) {
  const legacyToolEvents = events
    .filter((event) => event?.type === "tool_use" && event?.part?.type === "tool")
    .map((event) => ({
      tool: event.part.tool,
      input: event.part.state?.input ?? {},
      output: event.part.state?.output,
      status: event.part.state?.status,
      start: event.part.state?.time?.start,
      end: event.part.state?.time?.end,
      durationMs:
        typeof event.part.state?.time?.start === "number" &&
        typeof event.part.state?.time?.end === "number"
          ? event.part.state.time.end - event.part.state.time.start
          : null,
    }));
  const execToolEvents = events
    .filter((event) => event?.type === "item.completed" && event?.item?.type === "command_execution")
    .map((event) => ({
      tool: "command_execution",
      input: { command: event.item.command },
      output: event.item.aggregated_output,
      status: event.item.status,
      start: null,
      end: null,
      durationMs: null,
    }));
  return [...legacyToolEvents, ...execToolEvents];
}

export function getSessionDuration(events) {
  const starts = events
    .filter((event) => event?.type === "step_start" && typeof event.timestamp === "number")
    .map((event) => event.timestamp);
  const finishes = events
    .filter((event) => event?.type === "step_finish" && typeof event.timestamp === "number")
    .map((event) => event.timestamp);
  if (starts.length === 0 || finishes.length === 0) {
    return null;
  }
  return Math.max(...finishes) - Math.min(...starts);
}

export function getTokenTotals(events) {
  const stepFinishes = events.filter((event) => event?.type === "step_finish" && event?.part?.tokens);
  const turnCompletions = events.filter((event) => event?.type === "turn.completed" && event?.usage);
  if (stepFinishes.length === 0 && turnCompletions.length === 0) {
    return null;
  }
  const total = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const event of stepFinishes) {
    const tokens = event.part.tokens ?? {};
    const input = Number(tokens.input ?? 0);
    const output = Number(tokens.output ?? 0);
    const reasoning = Number(tokens.reasoning ?? 0);
    const explicitTotal = Number(tokens.total ?? NaN);
    total.total += Number.isFinite(explicitTotal) ? explicitTotal : input + output + reasoning;
    total.input += input;
    total.output += output;
    total.reasoning += reasoning;
    total.cacheRead += Number(tokens.cache?.read ?? 0);
    total.cacheWrite += Number(tokens.cache?.write ?? 0);
  }
  for (const event of turnCompletions) {
    const usage = event.usage ?? {};
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    const reasoning = Number(usage.reasoning_output_tokens ?? 0);
    total.total += input + output;
    total.input += input;
    total.output += output;
    total.reasoning += reasoning;
    total.cacheRead += Number(usage.cached_input_tokens ?? 0);
  }
  return total;
}

export function getTextOutput(events) {
  const legacyText = events
    .filter((event) => event?.type === "text" && typeof event?.part?.text === "string")
    .map((event) => event.part.text)
    .join("\n");
  const execText = events
    .filter((event) => event?.type === "item.completed" && event?.item?.type === "agent_message" && typeof event.item.text === "string")
    .map((event) => event.item.text)
    .join("\n");
  return [legacyText, execText].filter(Boolean).join("\n");
}

export function getEventError(events) {
  const lastCompletedIndex = events.findLastIndex((event) => event?.type === "turn.completed");
  const failureIndex = events.findLastIndex(
    (event, index) => index > lastCompletedIndex && (event?.type === "error" || event?.type === "turn.failed"),
  );
  if (failureIndex < 0) {
    return null;
  }
  const errorEvent = events[failureIndex];
  return {
    name: errorEvent.error?.name ?? errorEvent.type ?? "UnknownError",
    message: errorEvent.error?.data?.message ?? errorEvent.error?.message ?? errorEvent.message ?? "Unknown error",
  };
}

export function runCodexJson({
  executable,
  prompt,
  model,
  variant,
  agent,
  cwd,
  homeDir,
  timeoutMs,
  extraEnv,
}) {
  const startWall = Date.now();
  const args = [
    "exec",
    "--json",
    "--model",
    model,
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "-c",
    "approval_policy='never'",
  ];
  if (variant) {
    args.push("-c", `model_reasoning_effort='${variant}'`);
  }
  void agent;
  args.push(prompt);
  const childArgs = [...(executable.argsPrefix ?? []), ...args];

  const child = spawnSync(executable.command, childArgs, {
    cwd: cwd ?? repoRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: executable.shell,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      ...(homeDir ? { HOME: homeDir, USERPROFILE: homeDir } : {}),
      ...extraEnv,
    },
  });

  const wallMs = Date.now() - startWall;
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const events = parseNdjson(stdout);
  const eventError = getEventError(events);
  const timedOut =
    child.error?.code === "ETIMEDOUT" ||
    child.signal === "SIGTERM" ||
    /timed out/i.test(String(child.error?.message ?? ""));
  if (child.error && !timedOut) {
    throw child.error;
  }
  const failed = (child.status ?? 1) !== 0 || eventError !== null;
  const modelNotFound =
    failed &&
    (/Model not found|ProviderModelNotFoundError|model is not supported|not supported when using Codex/i.test(`${stdout}\n${stderr}`) ||
      /Model not found|model is not supported|not supported when using Codex/i.test(eventError?.message ?? ""));

  return {
    status: child.status ?? 1,
    signal: child.signal ?? null,
    stdout,
    stderr,
    wallMs,
    events,
    eventError,
    timedOut,
    modelNotFound,
  };
}

