/**
 * Input helpers for the tiles webview, free of the DOM so the tests can load
 * them. herdr's frames are its own redraw, so the page never learns the app's
 * terminal modes (docs/how-it-works.md); paste is the one place it has to
 * guess, and it guesses bracketed paste, as devc web does.
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * A multi-line paste, normalized (`\r\n` and `\n` become `\r`) and wrapped in
 * bracketed-paste markers so a shell or agent TUI does not submit each line. A
 * single line is sent unchanged.
 */
export function wrapPaste(text: string): string {
	if (!/[\r\n]/.test(text)) {
		return text;
	}
	return PASTE_START + text.replace(/\r\n|\n/g, '\r') + PASTE_END;
}

/** Lines one wheel notch scrolls. */
export const NOTCH_LINES = 3;
/** The most lines one wheel event scrolls. */
const MAX_WHEEL_LINES = 30;

/**
 * Wheel events to `terminal.scroll`s of {@link NOTCH_LINES} per notch. Line and
 * page deltas are one notch per event. Pixel deltas (Chromium reports mouse
 * notches and trackpad travel alike as pixels) count one notch per
 * {@link NOTCH_LINES} cell heights, the remainder carrying over until the
 * direction reverses, so a trackpad scrolls in proportion to finger travel.
 * Returns undefined until a whole notch has accumulated.
 */
export function createWheelAccumulator(): (
	deltaY: number,
	cellHeight: number,
	deltaMode: number,
) => { direction: 'up' | 'down'; lines: number } | undefined {
	let pending = 0;
	return (deltaY, cellHeight, deltaMode) => {
		if (!deltaY) {
			return undefined;
		}
		const direction = deltaY < 0 ? 'up' : 'down';
		if (deltaMode !== 0 || !(cellHeight > 0)) {
			pending = 0;
			return { direction, lines: NOTCH_LINES };
		}
		if (Math.sign(pending) !== Math.sign(deltaY)) {
			pending = 0;
		}
		pending += deltaY / (cellHeight * NOTCH_LINES);
		const whole = Math.trunc(pending);
		if (whole === 0) {
			return undefined;
		}
		pending -= whole;
		return { direction, lines: Math.min(MAX_WHEEL_LINES, Math.abs(whole) * NOTCH_LINES) };
	};
}
