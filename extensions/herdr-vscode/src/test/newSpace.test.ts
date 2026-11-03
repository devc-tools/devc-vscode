import * as assert from 'assert';
import * as vscode from 'vscode';
import { environmentPathOf, newSpaceCandidates, typedDirectory } from '../newSpace';
import { CONTAINER_SCHEME, SSH_SCHEME } from '../paths';
import { snapshot } from './fixtures';

suite('new space directory', () => {
	test('candidates: the focused space first, other spaces, workspace folders, home; no repeats', () => {
		assert.deepStrictEqual(newSpaceCandidates(snapshot(), ['/src/web/', '/work/repo'], '/home/me'), ['/src/api', '/src/web', '/work/repo', '/home/me']);
		assert.deepStrictEqual(newSpaceCandidates(undefined, [], undefined), []);
		assert.deepStrictEqual(newSpaceCandidates(undefined, ['/'], 'relative'), ['/'], 'root kept; non-absolute dropped');
	});

	test('typed paths: absolute and ~, nothing else', () => {
		assert.strictEqual(typedDirectory(' /tmp/x ', '/home/me'), '/tmp/x');
		assert.strictEqual(typedDirectory('~', '/home/me'), '/home/me');
		assert.strictEqual(typedDirectory('~/src', '/home/me'), '/home/me/src');
		assert.strictEqual(typedDirectory('~/src', undefined), undefined);
		assert.strictEqual(typedDirectory('api', '/home/me'), undefined);
	});

	test('a folder VS Code knows, as a path in the environment', () => {
		const mounts = [{ source: '/Users/me/app', destination: '/workspaces/app' }];
		const host = { kind: 'host', label: 'this machine' } as const;
		const ssh = { kind: 'ssh', alias: 'box', label: 'box' } as const;
		const container = { kind: 'container', containerId: 'abcdefabcdef0123', label: 'app' } as const;
		assert.strictEqual(environmentPathOf(vscode.Uri.file('/Users/me/x'), host, []), '/Users/me/x');
		assert.strictEqual(environmentPathOf(vscode.Uri.from({ scheme: SSH_SCHEME, authority: 'box', path: '/srv' }), ssh, []), '/srv');
		assert.strictEqual(environmentPathOf(vscode.Uri.from({ scheme: SSH_SCHEME, authority: 'other', path: '/srv' }), ssh, []), undefined);
		assert.strictEqual(environmentPathOf(vscode.Uri.file('/Users/me/app/src'), container, mounts), '/workspaces/app/src');
		assert.strictEqual(environmentPathOf(vscode.Uri.file('/Users/me/elsewhere'), container, mounts), undefined);
		assert.strictEqual(environmentPathOf(vscode.Uri.from({ scheme: CONTAINER_SCHEME, authority: 'abcdefabcdef', path: '/opt' }), container, mounts), '/opt');
		assert.strictEqual(environmentPathOf(vscode.Uri.file('/x'), ssh, []), undefined);
	});
});
