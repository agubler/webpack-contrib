import { Compiler, compilation } from 'webpack';
import { outputFileSync, removeSync, readFileSync, existsSync, writeFileSync } from 'fs-extra';
import { StaticPool } from 'node-worker-threads-pool';

import { join } from 'path';
import { generateRouteInjectionScript, createError } from './helpers';
import { BuildTimePath, RenderResult, WriteRenderResult } from './interfaces';

import { Renderer } from './Renderer';
const webpack = require('webpack');
const createHash = require('webpack/lib/util/createHash');
import { parse } from 'node-html-parser';

export interface BuildTimeRenderArguments {
	root: string;
	entries: string[];
	useManifest?: boolean;
	paths?: (BuildTimePath | string)[];
	useHistory?: boolean;
	static?: boolean;
	puppeteerOptions?: any;
	basePath: string;
	baseUrl?: string;
	scope: string;
	sync?: boolean;
	renderer?: Renderer;
	discoverPaths?: boolean;
	writeHtml?: boolean;
	onDemand?: boolean;
}

function genHash(content: string): string {
	return createHash('md4')
		.update(content)
		.digest('hex')
		.substr(0, 20);
}

const trailingSlash = new RegExp(/\/$/);
const leadingSlash = new RegExp(/^\//);

class MockAsset {
	private _assetPath: string;
	constructor(assetPath: string) {
		this._assetPath = assetPath;
	}

	source() {
		try {
			return readFileSync(this._assetPath, 'utf8');
		} catch {
			return '';
		}
	}
}

class MockCompilation {
	private _manifest: { [index: string]: string };
	public assets: { [index: string]: MockAsset };
	public errors: any[] = [];
	public warnings: any[] = [];
	constructor(output: string) {
		this._manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
		this.assets = Object.keys(this._manifest).reduce(
			(assets, key) => {
				const asset = new MockAsset(join(output, this._manifest[key]));
				assets[this._manifest[key]] = asset;
				return assets;
			},
			{} as { [index: string]: MockAsset }
		);
		this.assets['manifest.json'] = new MockAsset(join(output, 'manifest.json'));
		this.assets['index.html'] = new MockAsset(join(output, 'btr-index.html'));
	}
}

export default class BuildTimeRender {
	private _cssFiles: string[] = [];
	private _entries: string[];
	private _manifest: any;
	private _manifestContent: { [index: string]: string } = {};
	private _blockEntries: string[] = [];
	private _output?: string;
	private _jsonpName?: string;
	private _paths: (BuildTimePath | string)[];
	private _static = false;
	private _puppeteerOptions: any;
	private _root: string;
	private _useHistory = false;
	private _basePath = '';
	private _baseUrl: string;
	private _filesToWrite = new Set();
	private _filesToRemove = new Set();
	private _originalRoot!: string;
	private _hasBuildBridgeCache = false;
	private _scope: string;
	private _renderer: Renderer;
	private _discoverPaths: boolean;
	private _sync: boolean;
	private _writeHtml: boolean;
	private _writtenHtmlFiles: string[] = [];
	private _initialBtr = true;
	private _onDemand = false;

	constructor(args: BuildTimeRenderArguments) {
		const {
			paths = [],
			scope,
			root = '',
			entries,
			useHistory,
			puppeteerOptions,
			basePath,
			baseUrl = '/',
			renderer = 'puppeteer',
			discoverPaths = true,
			sync = false,
			writeHtml = true,
			onDemand = false
		} = args;
		const path = paths[0];
		const initialPath = typeof path === 'object' ? path.path : path;

		this._basePath = basePath;
		this._baseUrl = baseUrl;
		if (!trailingSlash.test(this._baseUrl)) {
			this._baseUrl = `${this._baseUrl}/`;
		}
		if (!leadingSlash.test(this._baseUrl)) {
			this._baseUrl = `/${this._baseUrl}`;
		}
		this._renderer = renderer;
		this._discoverPaths = discoverPaths;
		this._puppeteerOptions = puppeteerOptions;
		this._paths = ['', ...paths];
		this._root = root;
		this._sync = sync;
		this._scope = scope;
		this._onDemand = onDemand;
		this._writeHtml = writeHtml;
		this._entries = entries.map((entry) => `${entry.replace('.js', '')}.js`);
		this._useHistory = useHistory !== undefined ? useHistory : paths.length > 0 && !/^#.*/.test(initialPath);
		if (this._useHistory || paths.length === 0) {
			this._static = !!args.static;
		}
	}

	private _updateHTML(oldHash: string, hash: string) {
		const name = 'index.html';
		let content = this._manifestContent[name];
		content = content.replace(new RegExp(oldHash, 'g'), hash);
		this._manifestContent[name] = content;
		this._filesToWrite.add(name);
	}

	private _createCombinedRenderResult(renderResults: (WriteRenderResult | undefined)[]) {
		const combined = renderResults.reduce(
			(combined, result) => {
				if (!result) {
					return combined;
				}
				combined.styles = result.styles ? `${combined.styles}\n${result.styles}` : combined.styles;
				combined.html.push(result.content);
				combined.paths.push(result.path || '');
				combined.blockScripts.push(...result.blockScripts);
				combined.additionalScripts.push(...result.additionalScripts);
				combined.additionalCss.push(...result.additionalCss);
				return combined;
			},
			{ styles: '', html: [], paths: [], blockScripts: [], additionalScripts: [], additionalCss: [] } as {
				paths: (string | BuildTimePath)[];
				styles: string;
				html: string[];
				blockScripts: string[];
				additionalScripts: string[];
				additionalCss: string[];
			}
		);
		const script = generateRouteInjectionScript(combined.html, combined.paths, this._root);
		return {
			styles: combined.styles,
			content: this._originalRoot,
			script,
			head: [],
			blockScripts: combined.blockScripts,
			additionalScripts: combined.additionalScripts,
			additionalCss: combined.additionalCss
		};
	}

	private _writeSyncBuildBridgeCache(result: any): void {
		const [, , mainHash] = this._manifest['main.js'].match(/(main\.)(.*)(\.bundle)/) || ([] as any);
		Object.keys(result.blockResult).forEach((modulePath) => {
			Object.keys(result.blockResult[modulePath]).forEach((args) => {
				this._hasBuildBridgeCache = true;
				const blockResult = result.blockResult[modulePath][args];
				const blockCacheEntry = ` blockCacheEntry('${modulePath}', '${args}', ${blockResult});`;
				if (this._manifestContent['main.js'].indexOf(blockCacheEntry) === -1) {
					this._manifestContent['main.js'] = this._manifestContent['main.js'].replace(
						'APPEND_BLOCK_CACHE_ENTRY **/',
						`APPEND_BLOCK_CACHE_ENTRY **/${blockCacheEntry}`
					);
				}

				if (mainHash) {
					const currentMainChunkName = this._manifest['main.js'];
					const currentMainHash = this._manifest['main.js']
						.replace('main.js'.replace('js', ''), '')
						.replace(/\..*/, '');
					const newMainHash = genHash(this._manifestContent['main.js']);

					const mainChunkName = `main.${newMainHash}.bundle.js`;
					this._manifest['main.js'] = mainChunkName;
					this._updateHTML(currentMainHash, newMainHash);
					this._filesToRemove.add(currentMainChunkName);
					this._filesToRemove.add(mainChunkName);
				}
				this._filesToWrite.add('main.js');
			});
		});
	}

	private _writeBuildBridgeCache(result: any): void {
		// console.log(result);
		const scripts: string[] = [];
		const [, , mainHash] = this._manifest['main.js'].match(/(main\.)(.*)(\.bundle)/) || ([] as any);
		const chunkMarker = `main:"${mainHash}",`;
		const blockChunk = 'runtime/blocks.js';
		Object.keys(result.blockResult).forEach((modulePath) => {
			Object.keys(result.blockResult[modulePath]).forEach((args) => {
				this._hasBuildBridgeCache = true;
				const chunkName = `runtime/block-${genHash(modulePath + args)}`;
				const blockCacheEntry = `blockCacheEntry('${modulePath}', '${args}', '${chunkName}')`;
				const blockResult = result.blockResult[modulePath][args];
				const blockResultChunk = `
(window['${this._jsonpName}'] = window['${this._jsonpName}'] || []).push([['${chunkName}'],{
/***/ '${chunkName}.js':
/*! exports provided: default */
/***/ (function(module, __webpack_exports__, __webpack_require__) {
"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony default export */ __webpack_exports__["default"] = (${blockResult});
/***/ })
}]);
`;
				if (mainHash) {
					scripts.push(`${chunkName}.${genHash(blockResultChunk)}.bundle.js`);
				} else {
					scripts.push(`${chunkName}.js`);
				}

				if (this._blockEntries.indexOf(blockCacheEntry) === -1) {
					this._blockEntries.push(blockCacheEntry);
					if (this._manifestContent[blockChunk].indexOf(blockCacheEntry) === -1) {
						this._manifestContent[blockChunk] = this._manifestContent[blockChunk].replace(
							'APPEND_BLOCK_CACHE_ENTRY **/',
							`APPEND_BLOCK_CACHE_ENTRY **/
${blockCacheEntry}`
						);
					}
					this._manifest[`${chunkName}.js`] = `${chunkName}.js`;
					if (mainHash) {
						const newBlockHash = genHash(this._manifestContent[blockChunk]);
						const currentBlockChunkName = this._manifest[blockChunk];
						const currentBootstrapChunkName = this._manifest['bootstrap.js'];
						const currentBlockHash = currentBlockChunkName
							.replace(blockChunk.replace('js', ''), '')
							.replace(/\..*/, '');
						const blockResultChunkHash = genHash(blockResultChunk);
						this._manifest[`${chunkName}.js`] = `${chunkName}.${blockResultChunkHash}.bundle.js`;
						this._manifestContent['bootstrap.js'] = this._manifestContent['bootstrap.js'].replace(
							chunkMarker,
							`${chunkMarker}"${chunkName}":"${blockResultChunkHash}",`
						);
						this._manifestContent['bootstrap.js'] = this._manifestContent['bootstrap.js'].replace(
							currentBlockHash,
							newBlockHash
						);
						const currentBootstrapHash = this._manifest['bootstrap.js']
							.replace('bootstrap.js'.replace('js', ''), '')
							.replace(/\..*/, '');
						const newBootstrapHash = genHash(this._manifestContent['bootstrap.js']);
						const bootstrapChunkName = `bootstrap.${newBootstrapHash}.bundle.js`;
						const blockChunkName = `runtime/blocks.${newBlockHash}.bundle.js`;
						this._manifest['bootstrap.js'] = bootstrapChunkName;
						this._manifest[blockChunk] = blockChunkName;
						this._updateHTML(currentBootstrapHash, newBootstrapHash);
						this._updateHTML(currentBlockHash, newBlockHash);
						this._filesToRemove.add(currentBootstrapChunkName);
						this._filesToRemove.add(currentBlockChunkName);
						this._filesToRemove.add(blockChunkName);
						this._filesToRemove.add(bootstrapChunkName);
						this._filesToWrite.add('bootstrap.js');
						const additionalScriptIndex = result.renderResult.additionalScripts.indexOf(
							currentBlockChunkName
						);
						if (additionalScriptIndex !== -1) {
							result.renderResult.additionalScripts[additionalScriptIndex] = blockChunkName;
						}
					}
					this._manifestContent[`${chunkName}.js`] = blockResultChunk;
					this._filesToWrite.add(blockChunk);
					this._filesToWrite.add(`${chunkName}.js`);
				}
			});
		});
		result.renderResult.blockScripts = scripts;
	}

	private _writeBuildTimeCacheFiles() {
		if (this._hasBuildBridgeCache) {
			outputFileSync(join(this._output!, 'manifest.json'), JSON.stringify(this._manifest, null, 2), 'utf-8');
			this._filesToRemove.forEach((name) => {
				removeSync(join(this._output!, name));
			});

			this._filesToRemove = new Set();

			this._filesToWrite.forEach((name) => {
				this._filesToRemove.add(this._manifest[name]);
				outputFileSync(join(this._output!, this._manifest[name]), this._manifestContent[name], 'utf-8');
			});

			this._filesToWrite = new Set();
		}
	}

	private async _run(compilation: compilation.Compilation | MockCompilation, callback: Function, path?: string) {
		this._blockEntries = [];
		if (!this._output || compilation.errors.length > 0) {
			return Promise.resolve().then(() => {
				callback();
			});
		}
		const paths = path ? [path] : [...this._paths];
		let pageManifest = paths.map((path) => (typeof path === 'object' ? path.path : path));
		if (this._onDemand && !this._initialBtr && existsSync(join(this._output, 'btr-manifest.json'))) {
			pageManifest = JSON.parse(readFileSync(join(this._output, 'btr-manifest.json'), 'utf8'));
		}
		if (this._onDemand && path && pageManifest.indexOf(path) !== -1) {
			removeSync(join(this._output, ...path.split('/'), 'index.html'));
		} else {
			let htmlFileToRemove = this._writtenHtmlFiles.pop();
			while (htmlFileToRemove) {
				removeSync(htmlFileToRemove);
				htmlFileToRemove = this._writtenHtmlFiles.pop();
			}
		}

		this._manifest = JSON.parse(compilation.assets['manifest.json'].source());
		this._manifestContent = Object.keys(this._manifest).reduce((obj: any, chunkname: string) => {
			obj[chunkname] = compilation.assets[this._manifest[chunkname]].source();
			return obj;
		}, this._manifestContent);
		const originalManifest = { ...this._manifest };

		const html = this._manifestContent['index.html'];
		const root = parse(html);
		const rootNode = root.querySelector(`#${this._root}`);
		if (!rootNode) {
			compilation.errors.push(
				createError(undefined, `Could not find DOM node with id: "${this._root}" in src/index.html`)
			);
			callback();
			return;
		}
		this._originalRoot = `${rootNode.toString()}`;
		this._cssFiles = Object.keys(this._manifest)
			.filter((key) => {
				return /\.css$/.test(key);
			})
			.map((key) => this._manifest[key]);

		const renderPool = new StaticPool({
			size: 4,
			task: __dirname + '/render-worker.js',
			workerData: {
				root: this._root,
				scope: this._scope,
				output: this._output!,
				cssFiles: this._cssFiles,
				renderType: this._renderer,
				basePath: this._basePath,
				baseUrl: this._baseUrl,
				puppeteerOptions: this._puppeteerOptions,
				initialBtr: this._initialBtr,
				entries: this._entries,
				originalManifest: originalManifest,
				discoverPaths: this._discoverPaths,
				onDemand: this._onDemand,
				useHistory: this._useHistory
			}
		});

		const renderPromises = [];
		let renderCounter = 0;
		while (paths.length || renderCounter) {
			let path = paths.pop();
			if (path != null) {
				const parsedPath = typeof path === 'object' ? path.path : path;
				const pageExists = existsSync(join(this._output, ...parsedPath.split('/'), 'index.html'));
				const isBtrPage = pageManifest.indexOf(parsedPath) !== -1;
				if (pageExists && !isBtrPage) {
					console.warn(
						`BTR: The page for path: '${parsedPath}' already exists, but was not generated by BTR. Skipping.`
					);
					continue;
				}
				if (!isBtrPage) {
					if (!this._initialBtr) {
						console.warn(
							`On demand BTR: This path (${parsedPath}) has not been previously discovered by BTR, please make sure that it is discoverable or included in the btr paths array`
						);
					}
					pageManifest.push(parsedPath);
				}
				renderCounter++;
				const renderPromise: Promise<RenderResult> = renderPool.exec({ path });
				renderPromise
					.then((result) => {
						result.paths.forEach((newPath: string) => {
							if (pageManifest.indexOf(newPath) === -1) {
								(!this._onDemand || this._initialBtr) && paths.push(newPath);
								pageManifest.push(newPath);
							}
						});

						renderCounter--;
					})
					.catch(() => {
						createError(parsedPath, '');
						renderCounter--;
					});
				renderPromises.push(renderPromise);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const results = await Promise.all(renderPromises);
		renderPool.destroy();

		let renderResults = results.map((result) => {
			this._sync ? this._writeSyncBuildBridgeCache(result) : this._writeBuildBridgeCache(result);
			return result.renderResult;
		});

		this._writeBuildTimeCacheFiles();

		if (!this._useHistory && this._paths.length > 1) {
			renderResults = [this._createCombinedRenderResult(renderResults)];
		}

		const writerPool = new StaticPool({
			size: 4,
			task: __dirname + '/writer-worker.js',
			workerData: {
				isStatic: this._static,
				writeHtml: this._writeHtml,
				originalRoot: this._originalRoot,
				manifest: this._manifest,
				sync: this._sync,
				output: this._output,
				baseUrl: this._baseUrl,
				entries: this._entries,
				manifestContent: this._manifestContent,
				useHistory: this._useHistory
			}
		});
		let writerCounter = 0;
		const writerPromises = [];
		while (renderResults.length || writerCounter) {
			const result = renderResults.pop();
			if (result) {
				writerCounter++;
				const writerPromise: Promise<string[]> = writerPool.exec(result);
				writerPromise
					.then(() => {
						writerCounter--;
					})
					.catch(() => {
						createError(result.path, '');
						writerCounter--;
					});
				writerPromises.push(writerPromise);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		const writerResults = await Promise.all(writerPromises);
		this._writtenHtmlFiles.push(...(writerResults as any).flat());
		writerPool.destroy();
		if (this._hasBuildBridgeCache) {
			outputFileSync(
				join(this._output, '..', 'info', 'manifest.original.json'),
				compilation.assets['manifest.json'].source(),
				'utf8'
			);
		}
		outputFileSync(join(this._output, 'btr-manifest.json'), JSON.stringify(pageManifest, null, 4), 'utf8');
		callback();
	}

	public runPath(callback: Function, path: string, output: string, jsonpName: string) {
		this._output = output;
		this._jsonpName = jsonpName;
		const compilation = new MockCompilation(this._output);
		path = path
			.replace(/#.*/, '')
			.replace(/\/$/, '')
			.replace(/^\//, '')
			.toLowerCase();
		this._initialBtr = false;
		return this._run(compilation, callback, path);
	}

	public apply(compiler: Compiler) {
		if (!this._root) {
			return;
		}

		const plugin = new webpack.NormalModuleReplacementPlugin(/\.block/, (resource: any) => {
			const modulePath = join(resource.context, resource.request)
				.replace(this._basePath, '')
				.replace(/\\/g, '/')
				.replace(/^\//, '');
			resource.request = `@dojo/webpack-contrib/build-time-render/build-bridge-loader?modulePath='${modulePath}'!@dojo/webpack-contrib/build-time-render/bridge`;
		});
		plugin.apply(compiler);

		if (compiler.options.output) {
			this._output = compiler.options.output.path;
			this._jsonpName = compiler.options.output.jsonpFunction;
		}

		compiler.hooks.afterEmit.tapAsync(this.constructor.name, async (compilation, callback) => {
			if (!this._output) {
				return callback();
			}
			writeFileSync(join(this._output, 'btr-index.html'), compilation.assets['index.html'].source(), 'utf8');
			if (this._onDemand && !this._initialBtr) {
				return callback();
			}
			return this._run(compilation, callback);
		});
	}
}
