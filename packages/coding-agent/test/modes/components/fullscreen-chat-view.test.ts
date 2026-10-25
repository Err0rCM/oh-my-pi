import { describe, expect, it } from "bun:test";
import { FullscreenChatView } from "@oh-my-pi/pi-coding-agent/modes/components/fullscreen-chat-view";
import { type Component, Container, type MouseRoutable } from "@oh-my-pi/pi-tui";

class LinesComponent implements Component, MouseRoutable {
	constructor(private readonly lines: readonly string[]) {}

	render(): readonly string[] {
		return this.lines;
	}

	routeMouse(): void {
		// Not exercised in these tests; the editor slot contract requires it.
	}
}

/** Mutable transcript stand-in for streaming appends during a test. */
class GrowableComponent implements Component {
	lines: string[];
	constructor(lines: readonly string[]) {
		this.lines = [...lines];
	}

	render(): readonly string[] {
		return this.lines;
	}
}

class WrappingComponent implements Component {
	constructor(private readonly text: string) {}

	render(width: number): readonly string[] {
		const lineWidth = Math.max(1, width);
		const lines: string[] = [];
		for (let index = 0; index < this.text.length; index += lineWidth) {
			lines.push(this.text.slice(index, index + lineWidth));
		}
		return lines;
	}
}

describe("FullscreenChatView", () => {
	it("keeps the editor dock visible while history scrolls independently", () => {
		const transcript = new LinesComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[status, editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		const initial = view.render(12);
		expect(initial[0]).toContain("message-7");
		expect(initial.slice(-2)).toEqual(["status", "editor"]);
		expect(view.ownsOverlayFocusTarget(editor)).toBe(true);
		expect(view.ownsOverlayFocusTarget(transcript)).toBe(false);
		expect(view.handleViewportInput("\x1b[A")).toBe(false);

		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		const pageUp = view.render(12);
		// Viewport height 4 keeps a 4-row overlap, clamped to a 1-row minimum step.
		expect(pageUp[0]).toContain("message-6");
		expect(pageUp.slice(-2)).toEqual(["status", "editor"]);

		// Click the top of the scrollbar. The visible transcript jumps back to
		// the beginning while the fixed dock remains in place.
		expect(view.handleViewportInput("\x1b[<0;12;1M")).toBe(true);
		const top = view.render(12);
		expect(top[0]).toContain("message-1");
		expect(top.slice(-2)).toEqual(["status", "editor"]);
	});

	it("reflows transcript lines before reserving space for the scrollbar", () => {
		const transcript = new WrappingComponent("abcdefghijklmnopqrstuvwxyz0123456789".repeat(2));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[status, editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		const rendered = view.render(12);
		expect(rendered.slice(0, 4).some(line => line.includes("…"))).toBe(false);
	});

	it("leaves Home/End to the editor and scrolls the viewport on Ctrl+Home/End", () => {
		const transcript = new LinesComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[status, editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		view.render(12);
		// Leave the tail so the Ctrl+Home/End jumps below are observable.
		expect(view.handleViewportInput("\x1b[5~")).toBe(true);

		// Plain Home/End move the editor caret instead: the viewport must let
		// them fall through (upstream Pi returned them to the editor in 1.0.3).
		expect(view.handleViewportInput("\x1b[H")).toBe(false);
		expect(view.handleViewportInput("\x1b[F")).toBe(false);

		expect(view.handleViewportInput("\x1b[1;5H")).toBe(true); // ctrl+home
		expect(view.render(12)[0]).toContain("message-1");
		expect(view.handleViewportInput("\x1b[1;5F")).toBe(true); // ctrl+end
		// Back at the tail, and follow-tail re-engaged for future appends.
		expect(view.render(12)[0]).toContain("message-7");
	});

	it("consumes wheel events for accelerated scrolling", () => {
		const transcript = new LinesComponent(Array.from({ length: 30 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		view.render(12);
		// Wheel up must be consumed by the viewport regardless of how many lines
		// the speed heuristic picks (line-count behavior is pinned in the
		// wheel-scroll unit tests with an injected clock).
		expect(view.handleViewportInput("\x1b[<64;5;1M")).toBe(true);
		expect(view.render(12).length).toBe(6);
	});

	it("shows a clickable jump-to-latest indicator only while scrolled away", () => {
		const transcript = new GrowableComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		// Following the tail: no indicator, the last viewport row is content.
		const following = view.render(12);
		expect(following[4]).toContain("message-10");

		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		const scrolled = view.render(12);
		expect(scrolled[4]).toContain("Back to bottom");
		expect(scrolled[4]).not.toContain("message-");

		// Streaming appends while scrolled away switch to the new-activity label.
		transcript.lines.push("message-11", "message-12");
		const notified = view.render(12);
		expect(notified[4]).toContain("New activity");
		expect(notified[4]).toContain("Back to bottom");

		// Clicking the indicator row returns to the tail, clears the activity
		// flag, and re-engages follow so later appends stay pinned.
		expect(view.handleViewportInput("\x1b[<0;2;5M")).toBe(true);
		const back = view.render(12);
		expect(back[4]).toContain("message-12");
		transcript.lines.push("message-13");
		expect(view.render(12)[4]).toContain("message-13");

		// Scrolling away again shows the plain label until content grows again.
		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		expect(view.render(12)[4]).not.toContain("New activity");
	});

	it("routes editor-row clicks through the MouseRoutable contract with frame-local coordinates", () => {
		class RoutableEditor implements Component, MouseRoutable {
			routed: { line: number; col: number }[] = [];
			render(): readonly string[] {
				return ["editor-line"];
			}
			routeMouse(_event: unknown, line: number, col: number): void {
				this.routed.push({ line, col });
			}
		}
		const transcript = new LinesComponent(["message"]);
		const editor = new RoutableEditor();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		const rendered = view.render(12);
		const editorRow = rendered.findIndex(line => line.includes("editor-line"));
		expect(editorRow).toBeGreaterThanOrEqual(0);

		// Click into the editor row: routed with the row relative to the editor's
		// own output, and the raw column. A click one row above (viewport) is not routed.
		expect(view.handleViewportInput(`\x1b[<0;5;${editorRow + 1}M`)).toBe(true);
		expect(editor.routed).toEqual([{ line: 0, col: 4 }]);
		expect(view.handleViewportInput("\x1b[<0;5;1M")).toBe(true);
		expect(editor.routed.length).toBe(1);
	});

	it("disables editor click routing when dock truncation cuts into the editor", () => {
		class RoutableEditor implements Component, MouseRoutable {
			routed = 0;
			render(): readonly string[] {
				return ["editor-line"];
			}
			routeMouse(): void {
				this.routed += 1;
			}
		}
		const transcript = new LinesComponent(["message"]);
		const editor = new RoutableEditor();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		// terminalRows=1 forces the dock to truncate to a single row (the editor
		// tail survives only if it is the last row; with the editor first it is
		// cut away entirely).
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 1,
			() => editor,
			() => {},
		);

		view.render(12);
		for (let row = 0; row < 3; row++) {
			view.handleViewportInput(`\x1b[<0;5;${row + 1}M`);
		}
		expect(editor.routed).toBe(0);
	});

	it("selects transcript lines on drag and pushes them via OSC 52 on release", () => {
		const transcript = new LinesComponent(["\x1b[1mmsg-one\x1b[0m", "msg-two", "msg-three", "msg-four"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			data => writes.push(data),
		);

		// viewport = 6 - 1 dock row = 5 rows; content 4 lines fits, scrollOffset 0.
		view.render(12);
		// Press on row 0, drag to row 2 (button 32 = left drag), release.
		expect(view.handleViewportInput("\x1b[<0;2;1M")).toBe(true);
		const mid = view.render(12);
		expect(mid[0]).toContain("\x1b[7m"); // selection highlight on the first line
		expect(view.handleViewportInput("\x1b[<32;2;3M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;2;3m")).toBe(true);

		expect(writes.length).toBe(1);
		const osc = writes[0] ?? "";
		expect(osc.startsWith("\x1b]52;c;")).toBe(true);
		const b64 = osc.slice("\x1b]52;c;".length).replace(/\x07$/, "");
		const decoded = Buffer.from(b64, "base64").toString("utf8");
		// SGR stripped, trailing padding trimmed, three lines joined.
		expect(decoded).toBe("msg-one\nmsg-two\nmsg-three");

		// The highlight clears on release right after the copy fires.
		const after = view.render(12);
		expect(after[0]).not.toContain("\x1b[7m");
	});

	it("does not start a selection from clicks on the editor rows", () => {
		const transcript = new LinesComponent(["message"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 3,
			() => editor,
			data => writes.push(data),
		);

		const rendered = view.render(12);
		const editorRow = rendered.findIndex(line => line.includes("editor"));
		expect(view.handleViewportInput(`\x1b[<0;2;${editorRow + 1}M`)).toBe(true);
		expect(view.handleViewportInput(`\x1b[<0;2;${editorRow + 1}m`)).toBe(true);
		expect(writes.length).toBe(0);
	});

	it("consumes mouse releases that do not end a scrollbar drag", () => {
		const transcript = new LinesComponent(["message"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView(
			[transcript],
			[editorContainer],
			editorContainer,
			() => 6,
			() => editor,
			() => {},
		);

		view.render(12);
		// A press away from the scrollbar is ignored by navigation but remains
		// consumed. Its matching release must not leak an SGR sequence to the editor.
		expect(view.handleViewportInput("\x1b[<0;1;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;1;1m")).toBe(true);
	});
});
