import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { Type, type TSchema } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { parse as parseToml } from "toml";
import { parse as parseYaml } from "yaml";

const STATUS_KEY = "zoea-tools";
const MANIFEST_FILENAMES = new Set(["tools.toml", "tools.json", "tools.yaml", "tools.yml"]);
const STREAM_MAX_BYTES = Math.floor(DEFAULT_MAX_BYTES / 2);
const STREAM_MAX_LINES = Math.floor(DEFAULT_MAX_LINES / 2);

type ToolInputType = "string" | "integer" | "number" | "boolean";

type ToolInputDefinition = {
	type?: ToolInputType;
	description?: string;
	required?: boolean;
	default?: unknown;
	repeatable?: boolean;
	enum?: unknown[];
};

type ToolSpec = {
	name?: string;
	description?: string;
	command?: string;
	entry?: string;
	interpreter?: string;
	cwd?: string;
	inputs?: Record<string, ToolInputDefinition>;
	tags?: string[];
	triggers?: string[];
	timeout_ms?: number;
	env?: Record<string, string>;
};

type ToolFile = {
	version?: number;
	tools?: ToolSpec[] | Record<string, ToolSpec>;
};

type ToolRef = {
	name: string;
	manifestPath: string;
	manifestDir: string;
	source: string;
	tool: Required<Pick<ToolSpec, "description">> & Omit<ToolSpec, "description">;
};

type DiscoveryError = {
	path: string;
	message: string;
};

type DiscoveryResult = {
	tools: ToolRef[];
	errors: DiscoveryError[];
	scannedPaths: string[];
	manifestPaths: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(p: string): Promise<boolean> {
	try {
		await fs.access(p, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveFrom(baseDir: string, candidate: string): string {
	return path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
}

async function readJsonIfPresent(filePath: string): Promise<Record<string, unknown>> {
	if (!(await exists(filePath))) return {};
	try {
		const text = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(text);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function defaultManifestPaths(cwd: string): string[] {
	const home = os.homedir();
	const projectRoots = [path.join(cwd, ".zoea"), path.join(cwd, ".pi")];
	const globalRoots = [path.join(home, ".zoea"), path.join(home, ".pi", "agent")];
	const out: string[] = [];

	for (const root of [...projectRoots, ...globalRoots]) {
		for (const filename of MANIFEST_FILENAMES) out.push(path.join(root, filename));
		out.push(path.join(root, "tools"));
	}

	return out;
}

function readPathList(config: Record<string, unknown>): string[] {
	const direct = config.toolPaths;
	if (Array.isArray(direct)) return direct.filter((value): value is string => typeof value === "string");

	const nested = config.zoeaTools;
	if (isRecord(nested) && Array.isArray(nested.paths)) {
		return nested.paths.filter((value): value is string => typeof value === "string");
	}

	return [];
}

async function configuredManifestPaths(cwd: string): Promise<string[]> {
	const home = os.homedir();
	const configPaths = [
		path.join(cwd, ".zoea", "config.json"),
		path.join(cwd, ".pi", "zoea-tools.json"),
		path.join(home, ".zoea", "config.json"),
		path.join(home, ".pi", "agent", "zoea-tools.json"),
	];

	const envPaths = (process.env.ZOEA_TOOL_PATHS ?? "")
		.split(":")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => resolveFrom(cwd, part));

	const configuredPaths: string[] = [];
	for (const configPath of configPaths) {
		const config = await readJsonIfPresent(configPath);
		configuredPaths.push(...readPathList(config).map((entry) => resolveFrom(path.dirname(configPath), entry)));
	}

	return [...envPaths, ...configuredPaths, ...defaultManifestPaths(cwd)];
}

async function collectManifestFiles(scanPath: string): Promise<string[]> {
	if (!(await exists(scanPath))) return [];

	const stat = await fs.stat(scanPath);
	if (stat.isFile()) {
		return MANIFEST_FILENAMES.has(path.basename(scanPath)) ? [scanPath] : [];
	}
	if (!stat.isDirectory()) return [];

	const found: string[] = [];
	const stack = [scanPath];

	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && MANIFEST_FILENAMES.has(entry.name)) found.push(entryPath);
		}
	}

	return found.sort();
}

async function loadManifestFile(filePath: string): Promise<ToolFile> {
	const text = await fs.readFile(filePath, "utf8");
	const ext = path.extname(filePath).toLowerCase();

	let parsed: unknown;
	if (ext === ".json") parsed = JSON.parse(text);
	else if (ext === ".toml") parsed = parseToml(text);
	else parsed = parseYaml(text);

	if (!isRecord(parsed)) throw new Error("manifest root must be an object");
	return parsed as ToolFile;
}

function normalizeToolFile(filePath: string, data: ToolFile): ToolSpec[] {
	if (!data.tools) return [];
	if (Array.isArray(data.tools)) return data.tools;
	if (isRecord(data.tools)) {
		return Object.entries(data.tools).map(([name, raw]) => {
			if (!isRecord(raw)) throw new Error(`tool '${name}' must be an object`);
			return { ...raw, name } as ToolSpec;
		});
	}
	throw new Error(`${filePath}: 'tools' must be an array or object map`);
}

function normalizeToolSpec(filePath: string, manifestDir: string, source: string, raw: ToolSpec): ToolRef {
	const name = raw.name?.trim();
	if (!name) throw new Error("tool 'name' is required");
	const description = raw.description?.trim();
	if (!description) throw new Error(`tool '${name}' is missing 'description'`);

	const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
	const hasEntry = typeof raw.entry === "string" && raw.entry.trim().length > 0;
	if (hasCommand === hasEntry) {
		throw new Error(`tool '${name}' must define exactly one of 'command' or 'entry'`);
	}

	return {
		name,
		manifestPath: filePath,
		manifestDir,
		source,
		tool: {
			...raw,
			description,
			name,
			command: hasCommand ? raw.command?.trim() : undefined,
			entry: hasEntry ? raw.entry?.trim() : undefined,
		},
	};
}

async function discoverTools(cwd: string): Promise<DiscoveryResult> {
	const scanRoots = await configuredManifestPaths(cwd);
	const manifestPaths: string[] = [];
	const tools: ToolRef[] = [];
	const errors: DiscoveryError[] = [];
	const seenToolNames = new Map<string, string>();
	const seenManifestPaths = new Set<string>();

	for (const scanRoot of scanRoots) {
		let files: string[] = [];
		try {
			files = await collectManifestFiles(scanRoot);
		} catch (error) {
			errors.push({
				path: scanRoot,
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		for (const filePath of files) {
			if (!seenManifestPaths.has(filePath)) {
				seenManifestPaths.add(filePath);
				manifestPaths.push(filePath);
			}

			try {
				const manifest = await loadManifestFile(filePath);
				const rawTools = normalizeToolFile(filePath, manifest);
				const manifestDir = path.dirname(filePath);
				const source = scanRoot;

				for (const rawTool of rawTools) {
					const tool = normalizeToolSpec(filePath, manifestDir, source, rawTool);
					const existing = seenToolNames.get(tool.name);
					if (existing) {
						errors.push({
							path: filePath,
							message: `duplicate tool '${tool.name}' (already loaded from ${existing})`,
						});
						continue;
					}
					seenToolNames.set(tool.name, filePath);
					tools.push(tool);
				}
			} catch (error) {
				errors.push({
					path: filePath,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return {
		tools,
		errors,
		scannedPaths: scanRoots,
		manifestPaths,
	};
}

function inputDescription(spec: ToolInputDefinition): string | undefined {
	const parts: string[] = [];
	if (spec.description) parts.push(spec.description.trim());
	if (spec.repeatable) parts.push("Repeatable.");
	if (spec.default !== undefined) parts.push(`Default: ${JSON.stringify(spec.default)}`);
	if (Array.isArray(spec.enum) && spec.enum.length > 0) {
		parts.push(`Allowed: ${spec.enum.map((item) => JSON.stringify(item)).join(", ")}`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildParameterSchema(inputs: Record<string, ToolInputDefinition> | undefined): TSchema {
	const properties: Record<string, TSchema> = {};

	for (const [name, spec] of Object.entries(inputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		const description = inputDescription(spec);
		let schema: TSchema;
		const type = spec.type ?? "string";

		if (spec.repeatable) {
			schema = Type.Array(Type.String(description ? { description } : {}));
		} else if (type === "integer") {
			schema = Type.Integer(description ? { description } : {});
		} else if (type === "number") {
			schema = Type.Number(description ? { description } : {});
		} else if (type === "boolean") {
			schema = Type.Boolean(description ? { description } : {});
		} else {
			schema = Type.String(description ? { description } : {});
		}

		properties[name] = spec.required ? schema : Type.Optional(schema);
	}

	return Type.Object(properties);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function interpreterPrefix(tool: ToolRef): Promise<string[]> {
	if (tool.tool.interpreter) {
		switch (tool.tool.interpreter) {
			case "bash":
				return ["bash"];
			case "sh":
			case "shell":
				return ["sh"];
			case "python":
			case "python3":
				return ["python3"];
			case "node":
				return ["node"];
			case "ruby":
				return ["ruby"];
			default:
				return [tool.tool.interpreter];
		}
	}

	const entryPath = path.resolve(tool.manifestDir, tool.tool.entry!);
	if (await isExecutable(entryPath)) return [];
	const ext = path.extname(entryPath).toLowerCase();
	if (ext === ".py") return ["python3"];
	if (ext === ".sh" || ext === ".bash") return ["bash"];
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ["node"];
	if (ext === ".rb") return ["ruby"];
	return [];
}

function applyDefaults(tool: ToolRef, params: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...params };
	for (const [name, spec] of Object.entries(tool.tool.inputs ?? {})) {
		if (out[name] === undefined && spec.default !== undefined) out[name] = spec.default;
	}
	return out;
}

function formatFlag(name: string, value: unknown): string[] {
	const flag = `--${name.replace(/_/g, "-")}`;
	if (value === undefined || value === null) return [];
	if (typeof value === "boolean") return value ? [flag] : [];
	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const item of value) {
			if (item === undefined || item === null) continue;
			out.push(flag, String(item));
		}
		return out;
	}
	return [flag, String(value)];
}

type BuildShellCommandOptions = {
	sessionCwd?: string;
	runId: string;
};

async function buildShellCommand(
	tool: ToolRef,
	params: Record<string, unknown>,
	options: BuildShellCommandOptions,
): Promise<{ cwd: string; commandText: string; runId: string }> {
	const effectiveCwd = tool.tool.cwd ? resolveFrom(tool.manifestDir, tool.tool.cwd) : tool.manifestDir;
	const effectiveParams = applyDefaults(tool, params);
	const argv: string[] = [];

	if (tool.tool.command) {
		argv.push(tool.tool.command);
	} else {
		const entryPath = path.resolve(tool.manifestDir, tool.tool.entry!);
		argv.push(...(await interpreterPrefix(tool)), entryPath);
	}

	for (const [name] of Object.entries(tool.tool.inputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		argv.push(...formatFlag(name, effectiveParams[name]));
	}

	const shellCommand = tool.tool.command
		? [tool.tool.command, ...argv.slice(1).map(shellQuote)].join(" ")
		: argv.map(shellQuote).join(" ");

	const zoeaDir = process.env.ZOEA_DIR ?? ".zoea";
	// ZOEA_PROJECT_DIR pins zoea-core's project root to the session's
	// working dir. Without it, zoea-core falls back to process.cwd(),
	// which is the tool's own cwd (typically the manifest's parent like
	// `<project>/.zoea`) — yielding `<project>/.zoea/.zoea/output/...`.
	const envEntries: Record<string, string | undefined> = {
		ZOEA_DIR: zoeaDir,
		ZOEA_TOOL_MANIFEST: tool.manifestPath,
		ZOEA_TOOL_NAME: tool.name,
		ZOEA_RUN_ID: options.runId,
		ZOEA_EMIT_RESULT_SENTINEL: "1",
		ZOEA_SESSION_CWD: options.sessionCwd,
		ZOEA_PROJECT_DIR: options.sessionCwd,
		...(tool.tool.env ?? {}),
	};

	const exports = Object.entries(envEntries)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
		.join("\n");

	return {
		cwd: effectiveCwd,
		commandText: `${exports}\n${shellCommand}`,
		runId: options.runId,
	};
}

const RESULT_SENTINEL_PREFIX = "__ZOEA_RESULT__";
const RESULT_SENTINEL_RE = /^__ZOEA_RESULT__ (\{.*\})$/gm;

type ZoeaArtifactSentinel = {
	name: string;
	relative_path: string;
	media_type?: string | null;
	bytes?: number;
	metadata?: Record<string, unknown> | null;
};

type ZoeaResultSentinel = {
	version: number;
	run_id: string;
	tool_name: string;
	status: "success" | "error" | "skipped";
	summary: string;
	result_path: string;
	artifacts: ZoeaArtifactSentinel[];
};

type ZoeaToolDetails = {
	version: 1;
	run_id: string;
	results: ZoeaResultSentinel[];
};

function extractSentinels(stdout: string): { results: ZoeaResultSentinel[]; cleaned: string } {
	if (!stdout.includes(RESULT_SENTINEL_PREFIX)) return { results: [], cleaned: stdout };
	const results: ZoeaResultSentinel[] = [];
	RESULT_SENTINEL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = RESULT_SENTINEL_RE.exec(stdout)) !== null) {
		try {
			const parsed = JSON.parse(match[1]) as ZoeaResultSentinel;
			if (parsed && typeof parsed === "object" && parsed.version === 1) {
				results.push(parsed);
			}
		} catch {
			// Malformed sentinel: leave it in stdout so diagnostic output is visible.
		}
	}
	const cleaned = stdout.replace(RESULT_SENTINEL_RE, "").replace(/\n{3,}/g, "\n\n");
	return { results, cleaned };
}

function buildZoeaDetails(runId: string, results: ZoeaResultSentinel[]): ZoeaToolDetails | undefined {
	if (results.length === 0) return undefined;
	return { version: 1, run_id: runId, results };
}

function generateRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(16).slice(2, 10);
	return `${timestamp}-${suffix}`;
}

function summarizeStream(label: string, content: string): string | null {
	if (!content.trim()) return null;
	const truncated = truncateTail(content, {
		maxBytes: STREAM_MAX_BYTES,
		maxLines: STREAM_MAX_LINES,
	});
	let text = `${label}:\n${truncated.content}`;
	if (truncated.truncated) {
		text += `\n[${label} truncated: ${truncated.outputLines} of ${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}]`;
	}
	return text;
}

function buildResultText(tool: ToolRef, stdout: string, stderr: string, code: number): string {
	const parts = [`${tool.name} completed with exit code ${code}.`];
	const stdoutText = summarizeStream("stdout", stdout);
	const stderrText = summarizeStream("stderr", stderr);
	if (stdoutText) parts.push(stdoutText);
	if (stderrText) parts.push(stderrText);
	return parts.join("\n\n");
}

function toolPromptSnippet(tool: ToolRef): string {
	return tool.tool.description;
}

function buildStatusReport(discovery: DiscoveryResult): string {
	const lines: string[] = [];
	lines.push(`# zoea-tools`);
	lines.push("");
	lines.push(`loaded tools: ${discovery.tools.length}`);
	lines.push(`loaded manifests: ${discovery.manifestPaths.length}`);
	lines.push(`errors: ${discovery.errors.length}`);
	lines.push("");
	lines.push(`## scanned paths`);
	for (const scanPath of discovery.scannedPaths) lines.push(`- ${scanPath}`);
	lines.push("");
	lines.push(`## loaded tools`);
	for (const tool of discovery.tools) lines.push(`- ${tool.name} ← ${tool.manifestPath}`);
	if (discovery.errors.length > 0) {
		lines.push("");
		lines.push(`## errors`);
		for (const error of discovery.errors) lines.push(`- ${error.path}: ${error.message}`);
	}
	return lines.join("\n");
}

export default async function zoeaTools(pi: ExtensionAPI): Promise<void> {
	const cwd = process.cwd();
	const discovery = await discoverTools(cwd);

	for (const tool of discovery.tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.tool.description,
			promptSnippet: toolPromptSnippet(tool),
			parameters: buildParameterSchema(tool.tool.inputs),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const runId = process.env.ZOEA_RUN_ID ?? generateRunId();
				const shell = await buildShellCommand(tool, params as Record<string, unknown>, {
					sessionCwd: ctx.cwd,
					runId,
				});
				const result = await pi.exec("bash", ["-lc", shell.commandText], {
					signal,
					timeout: tool.tool.timeout_ms,
					cwd: shell.cwd,
				});

				const { results: sentinels, cleaned } = extractSentinels(result.stdout);
				const text = buildResultText(tool, cleaned, result.stderr, result.code);
				const zoea = buildZoeaDetails(runId, sentinels);

				if (result.code !== 0) throw new Error(text);

				return {
					content: [{ type: "text", text }],
					details: {
						tool: tool.name,
						manifestPath: tool.manifestPath,
						cwd: shell.cwd,
						code: result.code,
						killed: result.killed,
						...(zoea ? { zoea } : {}),
					},
				};
			},
		});
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const summary = discovery.tools.length > 0
			? `${discovery.tools.length} tool(s) from ${discovery.manifestPaths.length} manifest(s)`
			: "no tool manifests found";
		ctx.ui.setStatus(STATUS_KEY, summary);
		if (discovery.errors.length > 0) {
			ctx.ui.notify(
				`zoea-tools: ${discovery.errors.length} discovery error(s). Run /zoea-tools-status for details.`,
				"warning",
			);
		}
	});

	pi.registerCommand("zoea-tools-status", {
		description: "Show zoea-tools discovery status",
		handler: async () => {
			pi.sendMessage({
				customType: "zoea-tools-status",
				content: buildStatusReport(discovery),
				display: true,
			});
		},
	});

	pi.registerCommand("zoea-introspect", {
		description: "Emit a structured snapshot of registered commands and tools (used by zoea-server boot-time discovery)",
		handler: async () => {
			pi.sendMessage({
				customType: "zoea-introspect",
				content: "ok",
				display: false,
				details: {
					version: 1,
					commands: pi.getCommands(),
					tools: pi.getAllTools(),
				},
			});
		},
	});
}
