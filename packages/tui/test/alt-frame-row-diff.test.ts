import { beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** Captures raw frame writes so a test can assert which rows were repainted. */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** Mutable rows standing in for a transcript plus editor. */
class RowsComponent implements Component {
	rows: string[];

	constructor(rows: readonly string[]) {
		this.rows = [...rows];
	}

	invalidate(): void {
		// No cached state
	}

	render(): readonly string[] {
		return this.rows;
	}
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(40);
	await term.flush();
}

describe("alt-frame row-level diff", () => {
	beforeEach(() => {
		delete Bun.env.TERM_PROGRAM;
		delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
	});

	it("repaints only the changed row on a keystroke-sized frame", async () => {
		const term = new RecordingTerminal(40, 4);
		const tui = new TUI(term, true);
		const overlay = new RowsComponent(["α-row-one", "中文第二行", "third row", "editor line"]);

		tui.start();
		await flushRender(term);
		tui.showOverlay(overlay, { anchor: "top-left", width: "100%", maxHeight: "100%", fullscreen: true, base: true });
		tui.requestRender();
		await flushRender(term);

		// First frame paints everything.
		expect(term.writes.some(w => w.includes("α-row-one"))).toBe(true);

		// A keystroke changes only the last row: the next frame must not
		// rewrite the untouched rows (their erase-then-rewrite is what
		// flickers on slow clients), yet the viewport stays correct.
		term.writes.length = 0;
		overlay.rows = ["α-row-one", "中文第二行", "third row", "editor line!"];
		tui.requestRender();
		await flushRender(term);

		const last = term.writes[term.writes.length - 1] ?? "";
		expect(last).toContain("editor line!");
		expect(last).not.toContain("α-row-one");
		expect(last).not.toContain("中文第二行");
		expect(last).not.toContain("third row");
		expect((await term.flushAndGetViewport())[3]).toContain("editor line!");

		// An identical frame repaints nothing; the skip path may still emit an
		// idempotent cursor re-hide (no marker in these rows).
		term.writes.length = 0;
		tui.requestRender();
		await flushRender(term);
		expect(term.writes.join("")).toMatch(/^(\x1b\[\?25l)?$/);
	});
});
