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
