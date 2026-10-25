import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Container,
	Ellipsis,
	type MouseRoutable,
	matchesKey,
	type OverlayFocusOwner,
	parseSgrMouse,
	ScrollView,
	type SgrMouseEvent,
} from "@oh-my-pi/pi-tui";

/**
 * Persistent alternate-screen chat surface.
 *
 * The regular OMP root remains the source of truth for every existing
 * transcript, status, hook, and editor component. This view only gives those
 * components a viewport: history scrolls independently while the live dock
 * stays fixed at the bottom of the terminal.
 */
export class FullscreenChatView implements Component, OverlayFocusOwner {
	#scrollView = new ScrollView([], { height: 1, scrollbar: "auto", ellipsis: Ellipsis.Omit });
	#followTail = true;
	#viewportHeight = 1;
	#width = 1;
	#draggingScrollbar = false;
	/** Editor rows within the dock, from the last render; undefined when the editor is not laid out. */
	#editorDockRows: { top: number; count: number } | undefined;
	/**
	 * Selected transcript content lines as tail-relative indices (0 = last
	 * line), which stay glued to the same content while streaming appends rows
	 * at the end. Highlight is cleared on release after the copy fires.
	 */
	#selection: { start: number; end: number } | undefined;
	#draggingSelection = false;
	/** Un-styled transcript lines from the last render, backing selection copy. */
	#transcriptLines: readonly string[] = [];

	constructor(
		private readonly transcriptComponents: readonly Component[],
		private readonly dockComponents: readonly Component[],
		private readonly editorContainer: Container,
		private readonly terminalRows: () => number,
		/** Resolved at click time: the editor slot can be hot-swapped while fullscreen is up (approval prompts, visualizers), and a stale captured instance would silently route clicks into an unmounted instance. */
		private readonly editor: () => Component & MouseRoutable,
		/** Raw terminal write for one-shot sequences that must not race a frame (OSC 52 clipboard push). */
		private readonly write: (data: string) => void,
	) {}

	/** Lets the normal editor slot keep keyboard focus while this overlay owns the screen. */
	ownsOverlayFocusTarget(component: Component): boolean {
		return this.editorContainer.children.includes(component);
	}

	/** True when a viewport navigation key or mouse gesture changed the scroll position. */
	handleViewportInput(data: string): boolean {
		const mouse = parseSgrMouse(data);
		if (mouse) return this.#handleMouse(mouse);

		if (!this.#handleViewportKey(data)) return false;
		this.#followTail = this.#scrollView.getScrollOffset() === this.#scrollView.getMaxScrollOffset();
		return true;
	}

	invalidate(): void {
		for (const component of this.transcriptComponents) component.invalidate?.();
		for (const component of this.dockComponents) component.invalidate?.();
	}

	render(width: number): readonly string[] {
		this.#width = Math.max(1, width);
		const terminalRows = Math.max(1, this.terminalRows());
		const dockLines = this.#renderDock(this.#width, terminalRows);
		this.#viewportHeight = Math.max(1, terminalRows - dockLines.length);
		const fullWidthTranscript = this.#renderComponents(this.transcriptComponents, this.#width);
		// The scrollbar consumes the last terminal column. Re-render the
		// transcript at its remaining width so each component wraps its own
		// content instead of ScrollView cutting a rendered line short.
		const transcriptWidth =
			fullWidthTranscript.length > this.#viewportHeight ? Math.max(1, this.#width - 1) : this.#width;
		const transcriptLines =
			transcriptWidth === this.#width
				? fullWidthTranscript
				: this.#renderComponents(this.transcriptComponents, transcriptWidth);
		this.#transcriptLines = transcriptLines;

		this.#scrollView.setHeight(this.#viewportHeight);
		this.#scrollView.setLines(
			this.#selection === undefined
				? [...transcriptLines]
				: transcriptLines.map((line, index) => {
						const tail = transcriptLines.length - 1 - index;
						const lo = Math.min(this.#selection!.start, this.#selection!.end);
						const hi = Math.max(this.#selection!.start, this.#selection!.end);
						return tail >= lo && tail <= hi ? `\x1b[7m${line}\x1b[0m` : line;
					}),
		);
		if (this.#followTail) this.#scrollView.scrollToBottom();

		const transcriptViewport = this.#scrollView.render(this.#width);
		return [...transcriptViewport, ...dockLines];
	}

	#renderComponents(components: readonly Component[], width: number): string[] {
		const lines: string[] = [];
		for (const component of components) lines.push(...component.render(width));
		return lines;
	}

	#renderDock(width: number, terminalRows: number): string[] {
		const lines: string[] = [];
		let editorTop = -1;
		let editorCount = 0;
		for (const component of this.dockComponents) {
			const rendered = component.render(width);
			if (component === this.editorContainer) {
				// The editor container renders its children in order; the editor
				// is the first (and currently only) child, so its rows start at
				// the container's first row.
				editorTop = lines.length;
				editorCount = rendered.length;
			}
			lines.push(...rendered);
		}
		// Keep one transcript row usable even when a transient panel and a tall
		// editor would otherwise consume the whole terminal. The tail contains
		// the editor and footer, which must remain available to type.
		let dockLines = lines;
		if (lines.length >= terminalRows) {
			dockLines = lines.slice(lines.length - terminalRows + 1);
			if (editorTop >= 0) editorTop -= lines.length - dockLines.length;
		}
		this.#editorDockRows =
			editorTop >= 0 && editorTop < dockLines.length ? { top: editorTop, count: editorCount } : undefined;
		return dockLines;
	}

	#handleViewportKey(data: string): boolean {
		// Keep normal arrows available to the multiline editor. These fullscreen
		// navigation keys mirror upstream Pi's alternate-screen defaults.
		if (matchesKey(data, "pageUp")) {
			this.#scrollView.page(-1);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.#scrollView.page(1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.#scrollView.scrollToTop();
			return true;
		}
		if (matchesKey(data, "end")) {
			this.#scrollView.scrollToBottom();
			return true;
		}
		return false;
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null) {
			this.#scrollView.scroll(event.wheel);
			this.#followTail = this.#scrollView.getScrollOffset() === this.#scrollView.getMaxScrollOffset();
			return true;
		}

		if (event.release) {
			this.#draggingScrollbar = false;
			// A finished drag over the transcript commits the selection: push the
			// covered lines to the client clipboard via OSC 52 (the only clipboard
			// that reaches the user over SSH) and keep the highlight until the
			// next press. Requires client support: most terminals and tmux
			// (`set-clipboard on`) honor it.
			if (this.#draggingSelection) {
				this.#draggingSelection = false;
				this.#emitSelectionClipboard();
				this.#selection = undefined;
			}
			// Mouse tracking is enabled for the whole fullscreen surface, so even a
			// release that did not end a scrollbar drag must stay out of the editor.
			return true;
		}

		// Click into the editor's rows: forward through the MouseRoutable
		// contract with frame-local coordinates so the editor can position its
		// caret at the clicked glyph (click-to-position, CC-style). The editor
		// rows and the scrollbar column live in disjoint row ranges (dock vs
		// viewport), so this and the scrollbar-drag path never compete.
		if (event.leftClick && this.#editorDockRows !== undefined && event.row >= this.#viewportHeight) {
			const dockRow = event.row - this.#viewportHeight;
			if (dockRow >= this.#editorDockRows.top && dockRow < this.#editorDockRows.top + this.#editorDockRows.count) {
				this.editor().routeMouse(event, dockRow - this.#editorDockRows.top, event.col);
				return true;
			}
		}

		const scrollbarColumn = this.#width - 1;
		if (event.leftClick && event.col === scrollbarColumn && event.row < this.#viewportHeight) {
			this.#draggingScrollbar = true;
			this.#draggingSelection = false;
			this.#selection = undefined;
			this.#scrollToPointer(event.row);
			return true;
		}
		if (event.motion && this.#draggingScrollbar) {
			this.#scrollToPointer(event.row);
			return true;
		}

		// Line selection over the transcript: press starts (or restarts) a
		// selection on the content line under the pointer, a left-button drag
		// extends it, release commits it to the clipboard. Anchored to content
		// line indices so the selection survives scrolling while dragging.
		const contentLine = this.#scrollView.getScrollOffset() + event.row;
		const tailLine = this.#transcriptLines.length - 1 - contentLine;
		if (event.leftClick && event.row < this.#viewportHeight && event.col < scrollbarColumn) {
			this.#draggingSelection = true;
			this.#draggingScrollbar = false;
			this.#selection = { start: Math.max(0, tailLine), end: Math.max(0, tailLine) };
			return true;
		}
		if (event.motion && (event.button & 3) === 0 && this.#draggingSelection) {
			if (this.#selection) this.#selection.end = Math.max(0, tailLine);
			return true;
		}
		// Mouse tracking is active while fullscreen owns the TTY. Consume idle
		// motion and clicks so their escape sequences never enter the editor.
		return true;
	}

	/** Push the selected transcript lines (styled text stripped) to the client clipboard via OSC 52. */
	#emitSelectionClipboard(): void {
		if (this.#selection === undefined) return;
		const start = Math.max(
			0,
			this.#transcriptLines.length - 1 - Math.max(this.#selection.start, this.#selection.end),
		);
		const end = Math.min(
			this.#transcriptLines.length - 1,
			this.#transcriptLines.length - 1 - Math.min(this.#selection.start, this.#selection.end),
		);
		if (end < start) return;
		const text = this.#transcriptLines
			.slice(start, end + 1)
			.map(line => stripVTControlCharacters(line).trimEnd())
			.join("\n");
		if (text.length === 0) return;
		// OSC 52 payloads are base64; terminals cap them (tmux defaults to 256 KiB),
		// which covers multi-screen selections comfortably.
		this.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	}

	#scrollToPointer(row: number): void {
		const max = this.#scrollView.getMaxScrollOffset();
		const denominator = Math.max(1, this.#viewportHeight - 1);
		const ratio = Math.max(0, Math.min(1, row / denominator));
		this.#scrollView.setScrollOffset(Math.round(max * ratio));
		this.#followTail = this.#scrollView.getScrollOffset() === max;
	}
}
