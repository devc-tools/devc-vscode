import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The test host must not discover or connect to the machine's real herdr sessions.
	env: { HERDR_VSCODE_NO_DISCOVERY: '1' },
});
