import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const protectedRoot = "/usr/share/omarchy";
const privilegedCommands: Record<string, true | undefined> = {
	sudo: true, pkexec: true, pacman: true, yay: true, paru: true,
};
const systemMutations: Record<string, true | undefined> = {
	start: true, stop: true, restart: true, reload: true, "try-restart": true,
	"reload-or-restart": true, "reload-or-try-restart": true, "try-reload-or-restart": true,
	condrestart: true, "force-reload": true, isolate: true, kill: true, clean: true, freeze: true, thaw: true,
	"set-property": true, bind: true, "mount-image": true, "service-log-level": true, "service-log-target": true,
	"reset-failed": true, enable: true, disable: true, reenable: true, preset: true, "preset-all": true,
	mask: true, unmask: true, link: true, revert: true, edit: true, "add-wants": true, "add-requires": true,
	"daemon-reload": true, "daemon-reexec": true, "set-environment": true, "unset-environment": true,
	"import-environment": true, "switch-root": true, default: true, rescue: true, emergency: true,
	halt: true, poweroff: true, reboot: true, kexec: true, exit: true, suspend: true, hibernate: true,
	"hybrid-sleep": true, "suspend-then-hibernate": true, "soft-reboot": true, cancel: true, "schedule-shutdown": true,
};

// Literal simple commands only, not a shell parser or containment boundary.
// Scripts, expansions, aliases, heredocs and other interpreters are outside this guard.
function* shellCommands(command: string): Generator<string[]> {
	const tokens = command.matchAll(/(?:[^\s'"\\;&|()<>]+|'[^']*'|"(?:\\.|[^"\\])*"|\\[\s\S])+|\d*(?:>>?|<<?|>&|<&)|[;&|()\n]/g);
	let words: string[] = [];
	let comment = false;
	let redirect = false;
	for (const [raw] of tokens) {
		if (raw === "\n" || (!comment && /^[;&|()]$/.test(raw))) {
			if (words.length) yield words;
			words = [];
			comment = false;
			redirect = false;
		} else if (!comment) {
			if (raw.startsWith("#")) { comment = true; continue; }
			if (/^\d*[<>]/.test(raw)) { redirect = true; continue; }
			if (redirect) { redirect = false; continue; }
			words.push(raw.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\([\s\S])/g,
				(_match, single, double, escaped) => single ?? (double !== undefined
					? double.replace(/\\([\\"$`\n])/g, "$1") : escaped === "\n" ? "" : escaped)));
		}
	}
	if (words.length) yield words;
}

function commandIndex(words: string[]): number {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word) || word === "!") { i++; continue; }
		const name = basename(word);
		if (name === "command" || name === "exec" || name === "env") {
			i++;
			while (i < words.length && words[i].startsWith("-")) {
				const option = words[i++];
				if (name === "command" && (option === "-v" || option === "-V")) return words.length;
				if (option === "--") break;
				if ((name === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option)) ||
					(name === "exec" && option === "-a")) i++;
			}
			continue;
		}
		break;
	}
	return i;
}

function subcommandIndex(words: string[], start: number, valueOptions: string[]): number {
	let i = start;
	while (i < words.length && words[i].startsWith("-")) {
		const option = words[i++];
		if (option === "--") break;
		if (valueOptions.includes(option)) i++;
	}
	return i;
}

function bashViolation(command: string): string | undefined {
	for (const words of shellCommands(command)) {
		const i = commandIndex(words);
		const executable = basename(words[i] ?? "");
		if (privilegedCommands[executable] === true) return `quick no puede ejecutar ${executable}`;
		if (executable === "systemctl") {
			const verb = words[subcommandIndex(words, i + 1,
				["-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "--root", "--image", "--state", "--job-mode"])];
			if (systemMutations[verb] === true) return `quick no puede ejecutar systemctl ${verb}`;
		}
		if (executable !== "git") continue;
		const verbIndex = subcommandIndex(words, i + 1,
			["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);
		const verb = words[verbIndex];
		let options = true;
		for (const argument of words.slice(verbIndex + 1)) {
			if (argument === "--") { options = false; continue; }
			const force = options && (/^-[^-]*f/.test(argument) || /^--force(?:=|$)/.test(argument));
			if (verb === "push" && (force || (options && /^--force-with-lease(?:=|$)/.test(argument)) || argument.startsWith("+"))) {
				return "quick no puede ejecutar git push forzado";
			}
			if (verb === "reset" && options && argument === "--hard") return "quick no puede ejecutar git reset --hard";
			if (verb === "clean" && force) return "quick no puede ejecutar git clean forzado";
		}
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function unquote(value: string): string {
	const text = value.trim();
	return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}

// OMP v18.15.0: extensibility/tool-event-input.ts derives edit.path/paths from
// file headers only, NOT MV destinations. The grammars live in crates/pi-edit/grammars/.
// Inspect destination fields/directives, never replacement text or write.content.
function* editTargets(input: Record<string, unknown>): Generator<unknown> {
	yield input.path;
	yield input._path;
	if (Array.isArray(input.paths)) yield* input.paths;
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) yield record(edit).rename;
	}
	const raw = typeof input.input === "string" ? input.input : input._input;
	if (typeof raw !== "string") return;
	const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
	const sloppy = lines.some(line => /^\s*\*\*\*\s+Edit\s+File:/i.test(line));
	const applyPatch = !sloppy && lines.some(line => /^\s*\*\*\* (?:Add|Delete|Update) File:/.test(line));
	for (const line of lines) {
		if (sloppy) {
			const match = /^\s*\*\*\*\s+Edit\s+File:\s*(.*)$/i.exec(line);
			if (match) yield unquote(match[1].replace(/\s+all\s*$/i, ""));
		} else if (applyPatch) {
			const match = /^\s*\*\*\* (?:Add File|Delete File|Update File|Move to):\s*(.+)$/.exec(line);
			if (match) yield unquote(match[1]);
		} else {
			const header = /^\[(.+)#[\da-f]{4}\]$/i.exec(line) ?? /^\s*¶+(.+?)(?:#[\da-f]{4})?$/i.exec(line);
			const move = /^MV\s+(.+)$/.exec(line);
			if (header) yield unquote(header[1]);
			if (move) yield unquote(move[1]);
		}
	}
}

function* mutationTargets(tool: string, input: Record<string, unknown>): Generator<unknown> {
	if (tool === "write") yield input.path;
	if (tool === "edit") yield* editTargets(input);
	if (tool === "ast_edit" && Array.isArray(input.paths)) yield* input.paths;
	if (tool === "lsp") {
		const mutates = ((input.action === "rename" || input.action === "rename_file") && input.apply !== false) ||
			(input.action === "code_actions" && input.apply === true);
		if (mutates) {
			yield input.file;
			if (input.action === "rename_file") yield input.new_name;
		}
	}
}

function canonical(path: string, links = 0): string {
	if (links >= 40) return path; // Cyclic links cannot be followed by the filesystem either.
	try { return realpathSync(path); } catch {
		const parent = dirname(path);
		let target: string | undefined;
		try { target = readlinkSync(path); } catch { /* Not a symlink, or inaccessible. */ }
		if (target !== undefined) return canonical(resolve(parent, target), links + 1);
		return parent === path ? path : resolve(canonical(parent, links), basename(path));
	}
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function protects(value: unknown, cwd: string, recursive: boolean): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	let path = unquote(value).replace(/^:(?=[/~]|\.\.?\/)/, "").replace(/^@(?=[/~]|\.\.?\/)/, "");
	if (/^file:\/\//i.test(path)) {
		try { path = fileURLToPath(path); } catch { return false; }
	}
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return false;
	if (path.startsWith("~")) path = resolve(homedir(), path.slice(1).replace(/^\//, ""));
	// Archive/SQLite selectors name the containing file; AST scopes can be globs.
	path = path.split(":", 1)[0];
	if (recursive) {
		const glob = path.search(/[*?{[]/);
		if (glob >= 0) path = path.slice(0, path.lastIndexOf("/", glob) + 1) || ".";
	}
	const absolute = resolve(cwd, path);
	const real = canonical(absolute);
	const root = canonical(protectedRoot);
	return within(absolute, protectedRoot) || within(real, root) ||
		(recursive && (within(protectedRoot, absolute) || within(root, real)));
}

// This guards declared local targets, not arbitrary code, remote/internal URL routing,
// LSP-generated edits to undeclared references, symlink races, or Bash of other agents.
export default function guard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		const input = record(event.input);
		if (event.toolName === "bash" && ctx?.agent?.name === "quick" && typeof input.command === "string") {
			const reason = bashViolation(input.command);
			if (reason) return { block: true, reason: `guard.ts: ${reason}. Escalar a un agente autorizado.` };
		}
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		const recursive = event.toolName === "ast_edit" || (event.toolName === "lsp" && input.action === "rename_file");
		for (const target of mutationTargets(event.toolName, input)) {
			const scopes = event.toolName === "ast_edit" && typeof target === "string" ? target.split(";") : [target];
			if (scopes.some(scope => protects(scope, cwd, recursive))) {
				return { block: true, reason: `guard.ts: ${event.toolName} no puede modificar ${protectedRoot} ni sus descendientes; la lectura está permitida.` };
			}
		}
	});
}
