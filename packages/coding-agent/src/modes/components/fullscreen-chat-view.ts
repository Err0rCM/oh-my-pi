import {
	type Component,
	type Container,
	Ellipsis,
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

	constructor(
		private readonly transcriptComponents: readonly Component[],
		private readonly dockComponents: readonly Component[],
		private readonly editorContainer: Container,
		private readonly terminalRows: () => number,
		private readonly editor?: Component & {
			moveCursorToRenderedPosition(row: number, col: number, renderWidth: number): boolean;
		},
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

		this.#scrollView.setHeight(this.#viewportHeight);
		this.#scrollView.setLines(transcriptLines);
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
			this.editor && editorTop >= 0 && editorTop < dockLines.length
				? { top: editorTop, count: editorCount }
				: undefined;
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
			// Mouse tracking is enabled for the whole fullscreen surface, so even a
			// release that did not end a scrollbar drag must stay out of the editor.
			return true;
		}

		// Click into the editor's rows: position the caret at the clicked
		// glyph (click-to-position, CC-style). Runs before generic click
		// handling so the press never falls through to the scrollbar path.
		if (event.leftClick && this.editor && this.#editorDockRows !== undefined && event.row >= this.#viewportHeight) {
			const dockRow = event.row - this.#viewportHeight;
			if (dockRow >= this.#editorDockRows.top && dockRow < this.#editorDockRows.top + this.#editorDockRows.count) {
				if (this.editor.moveCursorToRenderedPosition(dockRow - this.#editorDockRows.top, event.col, this.#width)) {
					return true;
				}
			}
		}

		const scrollbarColumn = this.#width - 1;
		if (event.leftClick && event.col === scrollbarColumn && event.row < this.#viewportHeight) {
			this.#draggingScrollbar = true;
			this.#scrollToPointer(event.row);
			return true;
		}
		if (event.motion && this.#draggingScrollbar) {
			this.#scrollToPointer(event.row);
			return true;
		}
		// Mouse tracking is active while fullscreen owns the TTY. Consume idle
		// motion and clicks so their escape sequences never enter the editor.
		return true;
	}

	#scrollToPointer(row: number): void {
		const max = this.#scrollView.getMaxScrollOffset();
		const denominator = Math.max(1, this.#viewportHeight - 1);
		const ratio = Math.max(0, Math.min(1, row / denominator));
		this.#scrollView.setScrollOffset(Math.round(max * ratio));
		this.#followTail = this.#scrollView.getScrollOffset() === max;
	}
}
