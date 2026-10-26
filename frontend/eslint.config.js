import prettier from 'eslint-config-prettier';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	prettier,
	...svelte.configs['flat/prettier'],
	{
		// TypeScript inside `.svelte` files: without this the script blocks
		// are parsed as plain JS and every `import type` / `as` fails.
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				extraFileExtensions: ['.svelte'],
				svelteConfig
			}
		}
	},
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			// Console output is the app's observability story (log rails, boot
			// diagnostics) — never flag it.
			'no-console': 'off',
			// Warnings, not errors: surface dead code without failing the gate.
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			// `{@html}` is sanitized at every call site (DOMPurify) — the rule
			// cannot see that, so keep it advisory.
			'svelte/no-at-html-tags': 'warn'
		}
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'node_modules/']
	},
	{
		// Plain-JS Electron/shell files: typescript-eslint's no-require-imports
		// and no-unused-expressions assume TS modules; plain `require` and the
		// ternary-as-statement idiom are correct here.
		files: ['electron/**/*.js', 'scripts/**/*.cjs', 'scripts/**/*.js'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-unused-expressions': 'off'
		}
	}
];
