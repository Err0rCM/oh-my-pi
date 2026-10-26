import { stripVTControlCharacters } from "node:util";
import {
	ALT_WHEEL_SCROLL_MULTIPLIER,
	type Component,
	type Container,
	Ellipsis,
	getSegmenter,
	type MouseRoutable,
	matchesKey,
	type OverlayFocusOwner,
	parseSgrMouse,
	ScrollView,
	type SgrMouseEvent,
	visibleWidth,
	WheelScrollAccelerator,
} from "@oh-my-pi/pi-tui";

const segmenter = getSegmenter();

/**
 * Muted chip colors for overlay rows (search bar, jump indicator, copy
 * flash). Reverse video would swap to a white slab on dark terminals; a dim
 * gray background with light gray text stays quiet on dark and light themes.
 */
const CHIP_BG = "\x1b[48;5;236m";
const CHIP_FG = "\x1b[38;5;250m";

export interface FullscreenChatViewOptions {
	/** Transcript components: the history that scrolls independently of the dock. */
	transcript: readonly Component[];
	/** Dock components pinned to the bottom: pending messages, status, editor, footer. */
	dock: readonly Component[];
	/** Container whose focused child owns the keyboard while fullscreen is up. */
	editorContainer: Container;
	/** Terminal height in rows, polled on each render. */
	terminalRows: () => number;
	/**
	 * Resolved at click time: the editor slot can be hot-swapped while
	 * fullscreen is up (approval prompts, visualizers), and a stale captured
	 * instance would silently route clicks into an unmounted instance.
	 */
	editor: () => Component & MouseRoutable;
	/** Raw terminal write for one-shot sequences that must not race a frame (OSC 52 clipboard push). */
	write: (data: string) => void;
	/** Asks the host for a re-render; drives drag auto-scroll and copy-flash timers. */
	requestRender?: () => void;
}

/**
 * Persistent alternate-screen chat surface.
 *
 * The regular OMP root remains the source of truth for every existing
 * transcript, status, hook, and editor component. This view gives those
 * components a viewport: history scrolls independently while the live dock
 * stays fixed at the bottom of the terminal. On top of that viewport it owns
 * the fullscreen-only text interactions: speed-adaptive wheel scrolling,
 * click-to-position routing into the composer, character-level selection with
 * OSC 52 copy, transcript search, and the jump-to-latest indicator.
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
	 * Character-level selection as two tail-relative anchors. Lines and
	 * code-unit offsets stay glued to the same content while streaming appends
	 * rows at the end. Highlight is cleared on release after the copy fires.
	 */
	#selection: { anchor: SelectionPoint; head: SelectionPoint } | undefined;
	#draggingSelection = false;
	/** Last press position and time, for double/triple-click word and line selection. */
	#lastClick: { ms: number; row: number; col: number; count: number } | undefined;
	/** Drag auto-scroll state: direction while the pointer holds against a viewport edge. */
	#autoScrollTimer: ReturnType<typeof setInterval> | undefined;
	#autoScrollDir = 0;
	/** Column of the last drag motion, so auto-scroll extends the head at the pointer's column. */
	#dragCol = 0;
	/** Transient copy feedback replacing the last viewport row for a moment. */
	#flash: { text: string } | undefined;
	#flashTimer: ReturnType<typeof setTimeout> | undefined;
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

	constructor(private readonly options: FullscreenChatViewOptions) {}

	get transcriptComponents(): readonly Component[] {
		return this.options.transcript;
	}

	get dockComponents(): readonly Component[] {
		return this.options.dock;
	}

	get editorContainer(): Container {
		return this.options.editorContainer;
	}

	get terminalRows(): () => number {
		return this.options.terminalRows;
	}

	get editor(): () => Component & MouseRoutable {
		return this.options.editor;
	}

	get write(): (data: string) => void {
		return this.options.write;
	}

	get requestRender(): () => void {
		return this.options.requestRender ?? (() => {});
	}

	/** Lets the normal editor slot keep keyboard focus while this overlay owns the screen. */
	ownsOverlayFocusTarget(component: Component): boolean {
		return this.editorContainer.children.includes(component);
	}

	/** True when the fullscreen surface consumed the input: navigation keys, the search bar, selection gestures, or composer-click routing. */
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
		this.#stopAutoScroll();
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
						const ranges =
							this.#selection !== undefined ? this.#selectionRangesFor(index) : this.#searchRangesFor(index);
						return ranges.length > 0 ? highlightTranscriptRanges(line, ranges) : line;
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
		if (this.#flash !== undefined && transcriptViewport.length > 0) {
			transcriptViewport = [...transcriptViewport.slice(0, -1), this.#renderCentered(this.#flash.text)];
		} else if (this.#hasJumpIndicator() && transcriptViewport.length > 0) {
			const label = this.#hasNewActivity ? "● New activity · Back to bottom" : "↓ Back to bottom · Ctrl+End";
			transcriptViewport = [...transcriptViewport.slice(0, -1), this.#renderCentered(label)];
		}
		return [...transcriptViewport, ...dockLines];
	}

	#hasJumpIndicator(): boolean {
		return !this.#followTail;
	}

	/** Tail-relative index of absolute transcript line `index`. */
	#tailOf(index: number): number {
		return this.#transcriptLines.length - 1 - index;
	}

	/** Styled transcript line at tail-relative index `tail`. */
	#styledLineAtTail(tail: number): string | undefined {
		return this.#transcriptLines[this.#tailOf(tail)];
	}

	/** Reverse-video ranges covering the active selection on absolute line `index`. */
	#selectionRangesFor(index: number): { start: number; end: number }[] {
		if (this.#selection === undefined) return [];
		const tail = this.#tailOf(index);
		const [first, last] = this.#normalizedSelection();
		if (tail > first.line || tail < last.line) return [];
		const length = stripVTControlCharacters(this.#transcriptLines[index] ?? "").length;
		const start = tail === first.line ? first.unit : 0;
		const end = tail === last.line ? last.unit : length;
		return end > start ? [{ start, end }] : [];
	}

	/** Reverse-video ranges covering the active search hits on absolute line `index`. */
	#searchRangesFor(index: number): { start: number; end: number }[] {
		if (this.#search === undefined) return [];
		return this.#search.matches
			.filter(match => match.line === index)
			.map(match => ({ start: match.start, end: match.end }));
	}

	/** A muted chip row: left-aligned filling the row, or centered hugging its label. */
	#renderChipRow(text: string, center: boolean): string {
		const padding = Math.max(0, this.#width - visibleWidth(text));
		const left = center ? Math.floor(padding / 2) : 0;
		return `${" ".repeat(left)}${CHIP_BG}${CHIP_FG}${text}\x1b[0m${" ".repeat(padding - left)}`;
	}

	#renderSearchBar(): string {
		const search = this.#search!;
		const count = search.matches.length === 0 ? "no matches" : `${search.current + 1}/${search.matches.length}`;
		return this.#renderChipRow(` find: ${search.query}▏  ${count} · Enter↓ ⇧Enter↑ · Esc`, false);
	}

	#renderCentered(label: string): string {
		return this.#renderChipRow(`  ${label}  `, true);
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
			// covered character range to the client clipboard via OSC 52 (the only
			// clipboard that reaches the user over SSH) and clear the highlight —
			// the transient "Copied N lines" chip confirms it landed. Requires
			// client support: most terminals and tmux (`set-clipboard on`) honor it.
			if (this.#draggingSelection) {
				this.#draggingSelection = false;
				this.#stopAutoScroll();
				this.#emitSelectionClipboard();
				this.#selection = undefined;
			}
			// Mouse tracking is enabled for the whole fullscreen surface, so even a
			// release that did not end a scrollbar drag must stay out of the editor.
			return true;
		}

		// Drags keep tracking the pointer across the whole screen, so both
		// motion handlers run before the row is classified below.
		if (event.motion && this.#draggingScrollbar) {
			this.#scrollToPointer(event.row);
			return true;
		}
		if (event.motion && (event.button & 3) === 0 && this.#draggingSelection) {
			this.#dragCol = event.col;
			const row = Math.max(0, Math.min(this.#viewportHeight - 1, event.row));
			if (this.#selection) this.#selection.head = this.#pointAt(row, event.col);
			// Holding the drag against a viewport edge keeps scrolling so a
			// selection can extend past one screen (upstream Pi).
			if (event.row <= 0) this.#startAutoScroll(-1);
			else if (event.row >= this.#viewportHeight - 1) this.#startAutoScroll(1);
			else this.#stopAutoScroll();
			return true;
		}

		if (event.row >= this.#viewportHeight) {
			// Dock rows: a click on the editor's rows routes through the
			// MouseRoutable contract (click-to-position, CC-style); everything
			// else is consumed so the sequences never reach the editor.
			this.#routeEditorClick(event);
			return true;
		}

		// Viewport rows, in precedence order: jump-to-latest indicator, then
		// the scrollbar column, then text selection. The indicator only
		// replaces the last viewport row while the user is scrolled away, so
		// it cannot shadow content — but it leaves that row's scrollbar
		// column to the scrollbar.
		const scrollbarColumn = this.#width - 1;
		if (
			event.leftClick &&
			this.#hasJumpIndicator() &&
			event.row === this.#viewportHeight - 1 &&
			event.col < scrollbarColumn
		) {
			this.#scrollView.scrollToBottom();
			this.#syncFollowTail();
			return true;
		}
		if (event.leftClick && event.col === scrollbarColumn) {
			this.#draggingScrollbar = true;
			this.#draggingSelection = false;
			this.#selection = undefined;
			this.#scrollToPointer(event.row);
			return true;
		}
		// Character selection: press plants an anchor on the glyph under the
		// pointer; a quick second click selects the word, a third the line.
		if (event.leftClick && event.col < scrollbarColumn) {
			const point = this.#pointAt(event.row, event.col);
			this.#draggingSelection = true;
			this.#draggingScrollbar = false;
			this.#search = undefined; // starting a selection leaves search mode
			const clicks = this.#multiClickCount(event);
			this.#selection =
				clicks >= 2 ? this.#multiClickSelection(point.line, event.col, clicks) : { anchor: point, head: point };
			return true;
		}
		// Mouse tracking is active while fullscreen owns the TTY. Consume idle
		// motion and clicks so their escape sequences never enter the editor.
		return true;
	}

	/** Forwards a dock-area click into the editor with frame-local coordinates; other dock rows are simply consumed. */
	#routeEditorClick(event: SgrMouseEvent): void {
		if (!event.leftClick || this.#editorDockRows === undefined) return;
		const dockRow = event.row - this.#viewportHeight;
		if (dockRow < this.#editorDockRows.top || dockRow >= this.#editorDockRows.top + this.#editorDockRows.count) {
			return;
		}
		this.#search = undefined; // clicking into the composer leaves search mode
		this.editor().routeMouse(event, dockRow - this.#editorDockRows.top, event.col);
	}

	/**
	 * The selection endpoints in copy order [first, last] — first is the upper
	 * row on screen, which is the *larger* tail index (tail 0 = last line).
	 */
	#normalizedSelection(): [SelectionPoint, SelectionPoint] {
		const { anchor, head } = this.#selection!;
		return anchor.line > head.line || (anchor.line === head.line && anchor.unit <= head.unit)
			? [anchor, head]
			: [head, anchor];
	}

	/** Tail-relative anchor for a pointer position: line from the viewport row, unit from the visible column. */
	#pointAt(viewportRow: number, visibleCol: number): SelectionPoint {
		// Clamp rows beyond the content end to its last line (a drag can cross
		// into the dock area).
		const contentLine = Math.min(this.#scrollView.getScrollOffset() + viewportRow, this.#transcriptLines.length - 1);
		const tailLine = this.#tailOf(contentLine);
		const styled = this.#styledLineAtTail(tailLine);
		return { line: tailLine, unit: styled === undefined ? 0 : pickCodeUnit(styled, visibleCol) };
	}

	/** Counts chained clicks at the same cell within 500ms (double → word, triple+ → line). */
	#multiClickCount(event: SgrMouseEvent): number {
		const now = performance.now();
		const repeat =
			this.#lastClick !== undefined &&
			this.#lastClick.row === event.row &&
			this.#lastClick.col === event.col &&
			now - this.#lastClick.ms < 500;
		const count = repeat ? this.#lastClick!.count + 1 : 1;
		this.#lastClick = { ms: now, row: event.row, col: event.col, count };
		return count;
	}

	#multiClickSelection(
		tailLine: number,
		visibleCol: number,
		clicks: number,
	): {
		anchor: SelectionPoint;
		head: SelectionPoint;
	} {
		const styled = this.#transcriptLines[this.#transcriptLines.length - 1 - tailLine] ?? "";
		const text = stripVTControlCharacters(styled);
		if (clicks >= 3) {
			return { anchor: { line: tailLine, unit: 0 }, head: { line: tailLine, unit: text.length } };
		}
		// Double-click: the whitespace-delimited word under the pointer; / and -
		// stay joined, matching terminal double-click selection.
		const [start, end] = wordRangeAt(text, pickCodeUnit(styled, visibleCol));
		return { anchor: { line: tailLine, unit: start }, head: { line: tailLine, unit: end } };
	}

	/** Push the selected transcript range (styled text stripped) to the client clipboard via OSC 52. */
	#emitSelectionClipboard(): void {
		if (this.#selection === undefined) return;
		const [first, last] = this.#normalizedSelection();
		const firstText = stripVTControlCharacters(this.#styledLineAtTail(first.line) ?? "");
		const lastText = stripVTControlCharacters(this.#styledLineAtTail(last.line) ?? "");
		const lines: string[] = [];
		if (first.line === last.line) {
			lines.push(firstText.slice(first.unit, last.unit));
		} else {
			lines.push(firstText.slice(first.unit));
			for (let tail = first.line - 1; tail > last.line; tail--) {
				lines.push(stripVTControlCharacters(this.#styledLineAtTail(tail) ?? ""));
			}
			lines.push(lastText.slice(0, last.unit));
		}
		// An anchor sitting at a line boundary contributes no text of its own.
		while (lines.length > 1 && lines[0]!.trim().length === 0) lines.shift();
		while (lines.length > 1 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
		const text = lines.map(line => line.trimEnd()).join("\n");
		if (text.length === 0) return;
		// OSC 52 payloads are base64; terminals cap them (tmux defaults to 256 KiB),
		// which covers multi-screen selections comfortably.
		this.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.#showFlash(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`);
	}

	/** Shows a transient copy confirmation on the last viewport row. */
	#showFlash(text: string): void {
		const durationMs = 1500;
		this.#flash = { text };
		if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
		this.#flashTimer = setTimeout(() => {
			this.#flash = undefined;
			this.#flashTimer = undefined;
			this.requestRender();
		}, durationMs);
		this.requestRender();
	}

	#startAutoScroll(direction: number): void {
		if (this.#autoScrollDir === direction && this.#autoScrollTimer !== undefined) return;
		this.#stopAutoScroll();
		this.#autoScrollDir = direction;
		// Two rows per tick: fast enough to cross screens, slow enough to stop
		// where intended while the pointer holds the edge.
		this.#autoScrollTimer = setInterval(() => {
			this.#scrollView.scroll(direction * 2);
			if (this.#selection) {
				this.#selection.head = this.#pointAt(direction < 0 ? 0 : this.#viewportHeight - 1, this.#dragCol);
			}
			this.#syncFollowTail();
			this.requestRender();
		}, 50);
	}

	#stopAutoScroll(): void {
		if (this.#autoScrollTimer !== undefined) clearInterval(this.#autoScrollTimer);
		this.#autoScrollTimer = undefined;
		this.#autoScrollDir = 0;
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

/** A character-selection anchor: tail-relative line + code-unit offset in the SGR-stripped line text. */
export type SelectionPoint = { line: number; unit: number };

/** Maps a visible column to a code-unit index in the SGR-stripped text of a styled line. */
export function pickCodeUnit(line: string, visibleCol: number): number {
	const text = stripVTControlCharacters(line);
	let acc = 0;
	let idx = 0;
	for (const { segment } of segmenter.segment(text)) {
		const width = visibleWidth(segment);
		if (acc + width > visibleCol) break;
		acc += width;
		idx += segment.length;
	}
	return idx;
}

/** Word range [start, end) around idx: whitespace-delimited, / and - stay joined (terminal double-click). */
export function wordRangeAt(text: string, idx: number): [number, number] {
	const wordChar = (ch: string | undefined) => ch !== undefined && ch.trim().length > 0;
	let start = idx;
	while (wordChar(text[start - 1])) start--;
	let end = idx;
	while (wordChar(text[end])) end++;
	return [start, end];
}
