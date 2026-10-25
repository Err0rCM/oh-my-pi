import { beforeEach, describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** One row whose caret marker can move without changing the stripped pixels. */
class CaretMarkerComponent implements Component, Focusable {
	focused = false;
	#col = 0;
	readonly #text = "cursor-anchor-row";

	setCol(col: number): void {
		this.#col = Math.max(0, Math.min(col, this.#text.length));
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		const marker = this.focused ? CURSOR_MARKER : "";
		return [`${this.#text.slice(0, this.#col)}${marker}${this.#text.slice(this.#col)}`];
	}
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(40);
	await term.flush();
}

describe("alt-frame hardware cursor parking", () => {
	beforeEach(() => {
		delete Bun.env.TERM_PROGRAM;
		delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
	});

	it("parks the hardware cursor on a focused editor's marker in a fullscreen alt frame", async () => {
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, true);
		const overlay = new CaretMarkerComponent();

		tui.start();
		await flushRender(term);

		tui.showOverlay(overlay, { anchor: "top-left", width: "100%", maxHeight: "100%", fullscreen: true, base: true });
		tui.setFocus(overlay);
		tui.requestRender();
		await flushRender(term);

		// The marker sits at col 0 of row 0: expect CUP to 1;1 plus show-cursor.
		expect(term.getCursor().row).toBe(0);
		expect(term.getCursor().col).toBe(0);
		expect(term.getCursor().visible).toBe(true);
	});

	it("repositions the cursor on the identical-frame skip path (marker moved, pixels equal)", async () => {
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, true);
		const overlay = new CaretMarkerComponent();

		tui.start();
		await flushRender(term);
		tui.showOverlay(overlay, { anchor: "top-left", width: "100%", maxHeight: "100%", fullscreen: true, base: true });
		tui.setFocus(overlay);
		tui.requestRender();
		await flushRender(term);
		expect(term.getCursor().col).toBe(0);

		// Move the marker: the stripped row is byte-identical, so the frame
		// skips the repaint — the cursor must still move.
		overlay.setCol(7);
		tui.requestRender();
		await flushRender(term);
		expect(term.getCursor().col).toBe(7);
		expect(term.getCursor().visible).toBe(true);
	});

	it("re-hides the cursor when a later identical frame carries no marker", async () => {
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, true);
		const overlay = new CaretMarkerComponent();

		tui.start();
		await flushRender(term);
		tui.showOverlay(overlay, { anchor: "top-left", width: "100%", maxHeight: "100%", fullscreen: true, base: true });
		tui.setFocus(overlay);
		tui.requestRender();
		await flushRender(term);
		expect(term.getCursor().visible).toBe(true);

		// Drop focus: no marker is emitted, and the stripped row is unchanged,
		// so the identical-frame path must hide the lingering cursor.
		overlay.focused = false;
		tui.requestRender();
		await flushRender(term);
		expect(term.getCursor().visible).toBe(false);
	});
});
