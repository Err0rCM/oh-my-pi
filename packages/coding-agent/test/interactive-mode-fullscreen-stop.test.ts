import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("InteractiveMode fullscreen teardown", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let terminal: VirtualTerminal;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-fullscreen-stop-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(80, 24);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("does not restore a fullscreen surface after the mode stops", async () => {
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			write(data);
		});

		mode.setFullscreenTui(true);
		await terminal.waitForRender();
		expect(writes.join("")).toContain("\x1b[?1049h");

		mode.stop();
		writes.length = 0;
		mode.ui.start();
		await terminal.waitForRender();

		expect(writes.join("")).not.toContain("\x1b[?1049h");
		mode.ui.stop();
	});
});
