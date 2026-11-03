import * as esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['src/extension.ts'],
	outfile: 'dist/extension.js',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	sourcemap: true,
	logLevel: 'info',
});

await esbuild.build({
	entryPoints: ['src/webview/tiles.ts'],
	outfile: 'dist/webview/tiles.js',
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	sourcemap: true,
	logLevel: 'info',
});
