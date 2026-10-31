import * as assert from 'assert';
import { parseDevcontainerList, remoteUserFromMetadata } from '../devcontainer';

suite('devcontainer', () => {
	test('docker ps lines', () => {
		assert.deepStrictEqual(
			parseDevcontainerList('3f2a9c1b04de\t/Users/me/src/my-app\tsharp_euler\n\nbad line\nabc123456789\t/w/x\tn2\n'),
			[
				{ id: '3f2a9c1b04de', localFolder: '/Users/me/src/my-app', name: 'sharp_euler' },
				{ id: 'abc123456789', localFolder: '/w/x', name: 'n2' },
			],
		);
	});

	test('remote user from metadata: later entries win', () => {
		assert.strictEqual(remoteUserFromMetadata('[{"containerUser":"root"},{"remoteUser":"vscode"}]'), 'vscode');
		assert.strictEqual(remoteUserFromMetadata('{"containerUser":"node"}'), 'node');
		assert.strictEqual(remoteUserFromMetadata('not json'), undefined);
	});
});
