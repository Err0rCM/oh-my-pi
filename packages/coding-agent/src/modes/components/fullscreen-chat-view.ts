import { stripVTControlCharacters } from "node:util";
import {
	ALT_WHEEL_SCROLL_MULTIPLIER,
	type Component,
	type Container,
	Ellipsis,
	type MouseRoutable,
	matchesKey,
	type OverlayFocusOwner,
	parseSgrMouse,
	ScrollView,
	type SgrMouseEvent,
	visibleWidth,
	WheelScrollAccelerator,
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
	/** Scales wheel events by fling speed so touch scrolling keeps up with a flick. */
	#wheelAccelerator = new WheelScrollAccelerator();
	/** Transcript length at the last render; growth while scrolled up means new activity. */
	#lastContentLength = 0;
	/** True once content grew while the user was scrolled away from the tail. */
	#hasNewActivity = false;
	/** Active transcript search: typed query plus its literal matches and cursor. */
	#search: { query: string; matches: TranscriptMatch[]; current: number } | undefined;

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

		// Ctrl+F toggles the transcript search bar. The editor still owns the
		// bare key as cursor-right's Ctrl twin; fullscreen takes the chord.
		if (matchesKey(data, "ctrl+f")) {
			this.#search = this.#search === undefined ? this.#openSearch() : undefined;
			return true;
		}
		if (this.#search !== undefined && this.#handleSearchKey(data)) return true;

		if (!this.#handleViewportKey(data)) return false;
		this.#syncFollowTail();
		return true;
	}

	#openSearch(): { query: string; matches: TranscriptMatch[]; current: number } {
		// One text affordance at a time: opening search drops any selection.
		this.#selection = undefined;
		this.#draggingSelection = false;
		return { query: "", matches: [], current: 0 };
	}

	#handleSearchKey(data: string): boolean {
		if (matchesKey(data, "escape")) {
			this.#search = undefined;
			return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "ctrl+g")) {
			this.#stepSearch(1);
			return true;
		}
		if (matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+shift+g")) {
			this.#stepSearch(-1);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			this.#typeSearch(this.#search!.query.slice(0, -1));
			return true;
		}
		// Printable text extends the query; other bare control keys (tab…) are
		// swallowed so they cannot reach the editor mid-search. Escape-sequence
		// keys (arrows, pageUp…) fall through to viewport navigation instead.
		if (data.length > 0 && !data.includes("\x1b")) {
			const typed = [...data].filter(ch => ch >= " " && ch !== "\x7f").join("");
			if (typed.length > 0) this.#typeSearch(this.#search!.query + typed);
			return true;
		}
		return false;
	}

	#typeSearch(query: string): void {
		const search = this.#search!;
		search.query = query;
		search.matches = findTranscriptMatches(this.#transcriptLines, query);
		// Start from the first hit at or below the viewport, wrapping to the top.
		const firstVisible = this.#scrollView.getScrollOffset();
		let current = search.matches.findIndex(match => match.line >= firstVisible);
		if (current === -1) current = 0;
		search.current = current;
		this.#jumpToCurrentMatch();
	}

	#stepSearch(delta: number): void {
		const search = this.#search!;
		if (search.matches.length === 0) return;
		search.current = (search.current + delta + search.matches.length) % search.matches.length;
		this.#jumpToCurrentMatch();
	}

	/** Scrolls the current match into the upper third of the viewport without re-engaging follow (upstream Pi). */
	#jumpToCurrentMatch(): void {
		const match = this.#search?.matches[this.#search.current];
		if (match === undefined) return;
		this.#scrollView.setScrollOffset(Math.max(0, match.line - Math.floor(this.#viewportHeight / 3)));
		this.#followTail = false;
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
			this.#selection === undefined && this.#search === undefined
				? [...transcriptLines]
				: transcriptLines.map((line, index) => {
						if (this.#selection !== undefined) {
							const tail = transcriptLines.length - 1 - index;
							const lo = Math.min(this.#selection.start, this.#selection.end);
							const hi = Math.max(this.#selection.start, this.#selection.end);
							return tail >= lo && tail <= hi ? `\x1b[7m${line}\x1b[0m` : line;
						}
						const ranges = this.#search!.matches.filter(match => match.line === index).map(match => ({
							start: match.start,
							end: match.end,
						}));
						return highlightTranscriptRanges(line, ranges);
					}),
		);
		if (this.#followTail) this.#scrollView.scrollToBottom();

		if (!this.#followTail && transcriptLines.length > this.#lastContentLength) {
			this.#hasNewActivity = true;
		}
		this.#lastContentLength = transcriptLines.length;

		let transcriptViewport = this.#scrollView.render(this.#width);
		// The first viewport row becomes the search bar while a search is open;
		// the last one becomes a jump-to-latest affordance while the user is
		// scrolled away (upstream Pi) — with a stronger "New activity" variant
		// once content grew below the fold (Codex).
		if (this.#search !== undefined && transcriptViewport.length > 0) {
			transcriptViewport = [this.#renderSearchBar(), ...transcriptViewport.slice(1)];
		}
		if (this.#hasJumpIndicator() && transcriptViewport.length > 0) {
			const label = this.#hasNewActivity ? "● New activity · Back to bottom" : "↓ Back to bottom · Ctrl+End";
			transcriptViewport = [...transcriptViewport.slice(0, -1), this.#renderCentered(label)];
		}
		return [...transcriptViewport, ...dockLines];
	}

	#hasJumpIndicator(): boolean {
		return !this.#followTail;
	}

	#renderSearchBar(): string {
		const search = this.#search!;
		const count = search.matches.length === 0 ? "no matches" : `${search.current + 1}/${search.matches.length}`;
		const label = ` find: ${search.query}▏  ${count} · Enter↓ ⇧Enter↑ · Esc`;
		const padding = Math.max(0, this.#width - visibleWidth(label));
		return `\x1b[7m${label}${" ".repeat(padding)}\x1b[0m`;
	}

	#renderCentered(label: string): string {
		const text = ` ${label} `;
		const padding = Math.max(0, this.#width - visibleWidth(text));
		const left = Math.floor(padding / 2);
		return `\x1b[7m${" ".repeat(left)}${text}${" ".repeat(padding - left)}\x1b[0m`;
	}

	/** Recomputes tail-following from the scroll position; landing on the tail also clears activity. */
	#syncFollowTail(): void {
		this.#followTail = this.#scrollView.getScrollOffset() === this.#scrollView.getMaxScrollOffset();
		if (this.#followTail) this.#hasNewActivity = false;
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
		// Keep normal arrows, Home, and End available to the multiline editor
		// (Home/End must move the caret, not the transcript — upstream Pi moved
		// them back to the editor in 1.0.3 for the same reason). The viewport
		// variants use Ctrl: these mirror upstream Pi's alternate-screen defaults.
		if (matchesKey(data, "pageUp")) {
			this.#scrollView.scroll(-this.#pageStep());
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.#scrollView.scroll(this.#pageStep());
			return true;
		}
		if (matchesKey(data, "ctrl+home")) {
			this.#scrollView.scrollToTop();
			return true;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.#scrollView.scrollToBottom();
			return true;
		}
		return false;
	}

	/** Page-turn step that keeps the last lines of the previous page visible (upstream Pi keeps 4). */
	#pageStep(): number {
		return Math.max(1, this.#viewportHeight - 4);
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null) {
			// A trackpad/touch fling emits a dense event stream: scale lines by
			// event speed (upstream Pi defaults), and let Alt multiply for a jump.
			const lines = this.#wheelAccelerator.linesForEvent();
			if (lines > 0) {
				const alt = (event.button & 8) !== 0;
				this.#scrollView.scroll(event.wheel * lines * (alt ? ALT_WHEEL_SCROLL_MULTIPLIER : 1));
			}
			this.#syncFollowTail();
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
				this.#search = undefined; // clicking into the composer leaves search mode
				this.editor().routeMouse(event, dockRow - this.#editorDockRows.top, event.col);
				return true;
			}
		}

		// Clicking the jump-to-latest indicator row returns to the tail instead
		// of starting a selection; the indicator only replaces the last viewport
		// row while the user is scrolled away, so it cannot shadow real content.
		if (event.leftClick && this.#hasJumpIndicator() && event.row === this.#viewportHeight - 1) {
			this.#scrollView.scrollToBottom();
			this.#syncFollowTail();
			return true;
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
			this.#search = undefined; // starting a selection leaves search mode
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
		this.#syncFollowTail();
	}
}

/** One literal query hit: [start, end) into the SGR-stripped line text (UTF-16 code units). */
export type TranscriptMatch = { line: number; start: number; end: number };

/** Find literal case-insensitive query hits across SGR-stripped transcript lines. */
export function findTranscriptMatches(lines: readonly string[], query: string): TranscriptMatch[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return [];
	const matches: TranscriptMatch[] = [];
	for (let line = 0; line < lines.length; line++) {
		const text = stripVTControlCharacters(lines[line]!).toLowerCase();
		let start = text.indexOf(needle);
		while (start !== -1) {
			matches.push({ line, start, end: start + needle.length });
			start = text.indexOf(needle, start + needle.length);
		}
	}
	return matches;
}

/** End index (exclusive) of the CSI/OSC escape sequence starting at `from` in `line`. */
function endOfEscapeSequence(line: string, from: number): number {
	const kind = line[from + 1];
	if (kind === "[") {
		let i = from + 2;
		while (i < line.length && !/[A-Za-z]/.test(line[i]!)) i++;
		return Math.min(line.length, i + 1);
	}
	if (kind === "]") {
		// OSC terminates on BEL or ST (ESC \); OSC 8 link payloads ride inside.
		for (let i = from + 2; i < line.length; i++) {
			if (line[i] === "\x07") return i + 1;
			if (line[i] === "\x1b" && line[i + 1] === "\\") return i + 2;
		}
		return line.length;
	}
	return Math.min(line.length, from + 2);
}

/**
 * Re-insert reverse-video highlights around [start, end) ranges given as
 * indices into the SGR-stripped line text. Escape sequences pass through
 * untouched and do not consume index space; adjacent ranges merge so the
 * on/off sequences never interleave.
 */
export function highlightTranscriptRanges(line: string, ranges: readonly { start: number; end: number }[]): string {
	if (ranges.length === 0) return line;
	const merged: { start: number; end: number }[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = merged[merged.length - 1];
		if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	let out = "";
	let textIndex = 0;
	let rangeIndex = 0;
	let highlighted = false;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = endOfEscapeSequence(line, i);
			out += line.slice(i, end);
			// An in-range SGR (a reset in particular) drops the highlight; re-open it.
			if (highlighted) out += "\x1b[7m";
			i = end;
			continue;
		}
		const range = merged[rangeIndex];
		if (range !== undefined && textIndex === range.start) {
			out += "\x1b[7m";
			highlighted = true;
		}
		out += line[i];
		textIndex++;
		i++;
		if (range !== undefined && textIndex === range.end) {
			out += "\x1b[27m";
			highlighted = false;
			rangeIndex++;
		}
	}
	if (highlighted) out += "\x1b[27m";
	return out;
}
