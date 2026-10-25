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
		);

		const initial = view.render(12);
		expect(initial[0]).toContain("message-7");
		expect(initial.slice(-2)).toEqual(["status", "editor"]);
		expect(view.ownsOverlayFocusTarget(editor)).toBe(true);
		expect(view.ownsOverlayFocusTarget(transcript)).toBe(false);
		expect(view.handleViewportInput("\x1b[A")).toBe(false);

		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		const pageUp = view.render(12);
		expect(pageUp[0]).toContain("message-4");
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
		);

		const rendered = view.render(12);
		expect(rendered.slice(0, 4).some(line => line.includes("…"))).toBe(false);
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
		);

		view.render(12);
		for (let row = 0; row < 3; row++) {
			view.handleViewportInput(`\x1b[<0;5;${row + 1}M`);
		}
		expect(editor.routed).toBe(0);
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
		);

		view.render(12);
		// A press away from the scrollbar is ignored by navigation but remains
		// consumed. Its matching release must not leak an SGR sequence to the editor.
		expect(view.handleViewportInput("\x1b[<0;1;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;1;1m")).toBe(true);
	});
});
