/**
 * Finding paths in a tile's terminal lines. Imported by the webview and by
 * tests, so nothing here may need `vscode`, Node or the DOM.
 */

/** `~/x`, `./x` or `../x`; a path with a `/`; or a bare file name with an extension; with an optional `:line[:col]`. */
const PATH_LINK = /(?:~|\.{1,2})\/[\w.@+-]+(?:\/[\w.@+-]+)*(?::\d+(?::\d+)?)?|(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?|[\w.@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;

export interface PathLink {
	text: string;
	/** Where `text` starts in the line. */
	start: number;
}

/** The paths in one line: not URLs or bare version numbers, and not a sentence's last full stop. */
export function findPathLinks(line: string): PathLink[] {
	const links: PathLink[] = [];
	for (const match of line.matchAll(PATH_LINK)) {
		const text = match[0].replace(/\.+$/, '');
		const before = line.slice(0, match.index).match(/\S*$/)?.[0] ?? '';
		if (text && !`${before}${match[0]}`.includes('://') && !/^[\d.]+(?::\d+(?::\d+)?)?$/.test(text)) {
			links.push({ text, start: match.index });
		}
	}
	return links;
}
