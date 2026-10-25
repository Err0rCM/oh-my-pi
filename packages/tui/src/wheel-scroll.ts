/**
 * Speed-adaptive wheel scrolling for full-screen surfaces.
 *
 * A terminal wheel "event" is not a physical notch: trackpads and touch
 * scrolling emit a continuous stream of events whose density reflects how fast
 * the user is flinging. Scrolling a fixed line per event feels sluggish in a
 * fling and uncontrollable on a discrete notch, so scale the line count by the
 * gap between consecutive events. Timings mirror upstream Pi's defaults.
 */

/** Events closer than this belong to one physical notch (Ghostty bursts ~4ms) and must not re-add lines. */
const BURST_GAP_MS = 5;
/** A pause at least this long ends the gesture and restarts from the slowest speed. */
const GESTURE_GAP_MS = 200;
/** Lines per event in a fast fling (gap between 20 and 50ms). */
const FAST_LINES = 2;
/** Lines per event in a very fast fling (gap below 20ms). */
const FASTER_LINES = 5;
/** Upper bound for auto-scaled lines, so a misbehaving terminal cannot jump pages. */
const MAX_AUTO_LINES = 6;

/** Multiplier applied on top of the auto-scaled lines when Alt is held (Pi default: 5). */
export const ALT_WHEEL_SCROLL_MULTIPLIER = 5;

export class WheelScrollAccelerator {
	#lastEventMs = Number.NEGATIVE_INFINITY;

	constructor(
		/** Injectable clock so tests can synthesize fling timings. */
		private readonly now: () => number = () => performance.now(),
	) {}

	/**
	 * Record one wheel event and return how many lines it should scroll.
	 * Zero means the event is a burst duplicate of a notch already counted.
	 */
	linesForEvent(): number {
		const now = this.now();
		const gap = now - this.#lastEventMs;
		this.#lastEventMs = now;
		if (gap <= BURST_GAP_MS) return 0;
		// Discrete notches and post-pause restarts both scroll one line.
		if (gap >= GESTURE_GAP_MS || gap >= 100) return 1;
		if (gap >= 50) return FAST_LINES;
		if (gap >= 20) return FASTER_LINES;
		return MAX_AUTO_LINES;
	}
}
