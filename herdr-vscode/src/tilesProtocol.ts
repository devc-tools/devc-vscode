import { StoredLayoutConfig } from './layoutMapping';
import { DropZone } from './mirrorEdit';

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
export interface SpacePanelState {
	kind: 'space';
	sessionKey: string;
	workspaceId: string;
}

/** Saved by builds where an editor tab mirrored one herdr tab; restored as that tab's space. */
export interface MirrorPanelState {
	kind: 'mirror';
	sessionKey: string;
	tabId: string;
}

export type PanelState = SpacePanelState | MirrorPanelState;

/** A space panel's tab strip entry: one of the space's herdr tabs. */
export interface StripTab {
	tabId: string;
	label: string;
	/** The worst agent status of the tab's panes; `shell` with no agents (no dot). */
	status: TileMeta['status'];
	/** The tab the panel shows. */
	active: boolean;
}

/** A tile header: label, faded detail, and the status dot (`shell` for no agent: no dot). */
export interface TileMeta {
	paneKey: string;
	label: string;
	detail?: string;
	status: 'blocked' | 'working' | 'done' | 'idle' | 'unknown' | 'shell';
}

/** A tile's stream, when it is not simply showing frames. */
export type TileStreamState =
	| { kind: 'live' }
	| { kind: 'takenOver' }
	| { kind: 'ended'; reason: string };

export type HostMessage =
	| { type: 'init'; state: PanelState }
	| { type: 'font'; fontFamily: string; fontSize: number }
	| { type: 'layout'; config: StoredLayoutConfig }
	/** No layout: every tile goes away and `text` is shown instead. */
	| { type: 'empty'; text: string }
	/** `strip`: the space's tabs in herdr's order. */
	| { type: 'meta'; tiles: TileMeta[]; strip?: StripTab[] }
	| { type: 'frame'; paneKey: string; full: boolean; cols: number; rows: number; bytes: string }
	| { type: 'tileState'; paneKey: string; state: TileStreamState }
	| { type: 'focusTile'; paneKey: string }
	/** Mirrored tabs: herdr's split ratios changed (path key → the `first` child's share); resize in place. */
	| { type: 'ratios'; ratios: Record<string, number> }
	/** Mirrored tabs: herdr's zoomed pane (null: none); after every `layout` and on each change. */
	| { type: 'zoom'; paneKey: string | null }
	/** Test support: answer with `probeResult`, after an optional key press, click or drop. */
	| { type: 'probe'; id: number; action?: ProbeAction };

export type ProbeAction =
	| { kind: 'press'; paneKey: string; key: string; keyCode: number }
	| { kind: 'clickClose'; paneKey: string }
	/** The X on a tile's own tab. */
	| { kind: 'clickTabClose'; paneKey: string }
	/** Moves the mouse over a cell (0-based) with synthetic events. */
	| { kind: 'hoverCell'; paneKey: string; col: number; row: number }
	/** A press and release where the mouse is, as a click on a link needs. */
	| { kind: 'clickCell'; paneKey: string; col: number; row: number }
	/** Mirrored tabs: drags the splitter of item `split:<key>` to `fraction` of that item's width or height. */
	| { kind: 'dragSplitter'; splitId: string; fraction: number }
	/** Mirrored tabs: drags a tile's tab to a point inside `zone` of another tile, with synthetic pointer events. */
	| { kind: 'dragTile'; paneKey: string; targetPaneKey: string; zone: DropZone }
	/** Drags a tile's tab onto a strip entry (`tabId`) or the strip's + (null). */
	| { kind: 'dragTileToStrip'; paneKey: string; tabId: string | null }
	/** The maximise control of a tile's stack. */
	| { kind: 'clickMaximise'; paneKey: string }
	/** Space panels: a click on a tab strip entry (or its ×, or a double-click), or the strip's +. */
	| { kind: 'clickStrip'; tabId: string; part: 'tab' | 'close' | 'double' }
	| { kind: 'clickNewTab' };

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
	/** Whether the terminal shows the pointer cursor, as it does over a link. */
	overLink: boolean;
	/** The class of the status dot on the tile's tab; '' with no dot. */
	dot: string;
	/** The tile host's `data-vscode-context`, as written. */
	context: string;
}

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'tileOpen'; paneKey: string; cols: number; rows: number }
	| { type: 'tileResize'; paneKey: string; cols: number; rows: number }
	| { type: 'tileClose'; paneKey: string }
	| { type: 'input'; paneKey: string; text: string }
	| { type: 'scroll'; paneKey: string; direction: 'up' | 'down'; lines: number }
	| { type: 'focus'; paneKey: string }
	| { type: 'closePane'; paneKey: string }
	/** Space panels: show this herdr tab (herdr's `tab.focus`). */
	| { type: 'focusTab'; tabId: string }
	/** Space panels: the strip's +. */
	| { type: 'newTab' }
	/** Space panels: a strip entry's ×. */
	| { type: 'closeTab'; tabId: string }
	/** Space panels: a strip entry was double-clicked. */
	| { type: 'renameTab'; tabId: string }
	| { type: 'reconnect'; paneKey: string }
	| { type: 'clipboardPaste'; paneKey: string }
	| { type: 'clipboardCopy'; text: string }
	/** A path printed in a tile was clicked: `text` is the link, with any `:line[:col]`. */
	| { type: 'openLink'; paneKey: string; text: string }
	/** Mirrored tabs: splitter drags, as path key → the `first` child's share. */
	| { type: 'setRatios'; ratios: Record<string, number> }
	/** Mirrored tabs: a tile was maximised (its pane key) or restored (null). */
	| { type: 'setZoom'; paneKey: string | null }
	/** Mirrored tabs: a tile was dragged onto another tile's zone. */
	| { type: 'movePane'; paneKey: string; targetPaneKey: string; zone: DropZone }
	/** Mirrored tabs: a tile was dragged onto a strip entry (`tabId`) or the strip's + (null). */
	| { type: 'movePaneToTab'; paneKey: string; tabId: string | null }
	| {
			type: 'probeResult';
			id: number;
			tiles: TileProbe[];
			/** The ids of the toolbar's children. */
			toolbar: string[];
			message: string;
			/** The strip's entries as shown, `*` before the active one. */
			strip: string[];
			config: StoredLayoutConfig;
			/** A Golden Layout tab drag is under way. */
			dragging: boolean;
			/** Every `split:` item's ratio, from the live Golden Layout items, by path key. */
			ratios: Record<string, number>;
			/** The pane key of the maximised stack's tile. */
			maximised: string | null;
	  };
