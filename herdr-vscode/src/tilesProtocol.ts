import { GlLayoutConfig } from './layoutMapping';

/**
 * Messages between the extension host and the `herdr.tiles` webview. Imported
 * by both sides, so nothing here may need `vscode`, Node or the DOM at runtime.
 */

/** `<sessionKey>|<paneId>`: a pane across every environment and session. */
export function makePaneKey(sessionKey: string, paneId: string): string {
	return `${sessionKey}|${paneId}`;
}

export function splitPaneKey(paneKey: string): { sessionKey: string; paneId: string } {
	const i = paneKey.lastIndexOf('|');
	return { sessionKey: paneKey.slice(0, i), paneId: paneKey.slice(i + 1) };
}

/** What a webview keeps with `setState` to come back after a reload. */
export interface MirrorPanelState {
	kind: 'mirror';
	sessionKey: string;
	tabId: string;
}

/** A tile header: label, faded detail, and the status dot (`shell` for no agent). */
export interface TileMeta {
	paneKey: string;
	label: string;
	detail?: string;
	status: 'blocked' | 'working' | 'done' | 'idle' | 'unknown' | 'shell';
}

/** A tile's stream, when it is not simply showing frames. */
export type TileStreamState = { kind: 'live' } | { kind: 'takenOver' } | { kind: 'ended'; reason: string };

export type HostMessage =
	| { type: 'init'; state: MirrorPanelState }
	| { type: 'font'; fontFamily: string; fontSize: number }
	| { type: 'layout'; config: GlLayoutConfig }
	/** No layout: every tile goes away and `text` is shown instead. */
	| { type: 'empty'; text: string }
	| { type: 'meta'; breadcrumb: string; tiles: TileMeta[] }
	| { type: 'frame'; paneKey: string; full: boolean; cols: number; rows: number; bytes: string }
	| { type: 'tileState'; paneKey: string; state: TileStreamState }
	| { type: 'focusTile'; paneKey: string }
	/** Test support (the opt-in live suite): answer with `probeResult`, after an optional key press or click. */
	| { type: 'probe'; id: number; action?: ProbeAction };

export type ProbeAction =
	| { kind: 'press'; paneKey: string; key: string; keyCode: number }
	| { kind: 'clickClose'; paneKey: string };

export interface TileProbe {
	paneKey: string;
	/** Which Terminal this is: it changes only if a tile's terminal was re-created. */
	serial: number;
	text: string;
	cols: number;
	rows: number;
	width: number;
	height: number;
	x: number;
	y: number;
	title: string;
	overlay: string;
}

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'tileOpen'; paneKey: string; cols: number; rows: number }
	| { type: 'tileResize'; paneKey: string; cols: number; rows: number }
	| { type: 'tileClose'; paneKey: string }
	| { type: 'input'; paneKey: string; text: string }
	| { type: 'scroll'; paneKey: string; direction: 'up' | 'down'; lines: number }
	| { type: 'focus'; paneKey: string }
	| { type: 'split'; direction: 'right' | 'down' }
	| { type: 'closePane'; paneKey: string }
	| { type: 'reconnect'; paneKey: string }
	| { type: 'clipboardPaste'; paneKey: string }
	| { type: 'clipboardCopy'; text: string }
	| { type: 'probeResult'; id: number; tiles: TileProbe[]; breadcrumb: string; message: string };
