const { parentPort, workerData } = require('worker_threads');
import { ensureDirSync } from 'fs-extra';
import { Worker } from 'worker_threads';
import renderer, { Renderer } from './Renderer';
import { join } from 'path';
import {
	serve,
	getClasses,
	generateBasePath,
	getScriptSources,
	getForSelector,
	getAllForSelector,
	setupEnvironment,
	getPageStyles,
	getRenderHooks,
	getPageLinks,
	createError
} from './helpers';
import { BuildTimePath, WriteRenderResult } from './interfaces';

const filterCss = require('filter-css');

interface RenderData {
	root: string;
	scope: string;
	output: string;
	cssFiles: string[];
	renderType?: Renderer;
	basePath: string;
	baseUrl: string;
	puppeteerOptions: any;
	initialBtr: boolean;
	entries: string[];
	originalManifest: any;
	discoverPaths: boolean;
	useHistory: boolean;
	onDemand: boolean;
}

interface RenderResult {
	paths: string[];
	renderResult?: any;
	blockResult: any;
	warnings: any[];
	errors: any[];
}

interface RenderOptions {
	path: BuildTimePath;
}

const {
	root,
	scope,
	output,
	cssFiles,
	renderType,
	basePath,
	baseUrl,
	puppeteerOptions,
	entries,
	originalManifest,
	discoverPaths,
	useHistory
}: RenderData = workerData;

async function setUp() {
	const browser = await renderer(renderType).launch(puppeteerOptions);
	const app = await serve(output, baseUrl);
	const screenshotDirectory = join(output, '..', 'info', 'screenshots');
	ensureDirSync(screenshotDirectory);

	parentPort.on('message', async ({ path }: RenderOptions) => {
		const parsedPath = typeof path === 'object' ? path.path : path;
		const btrResult: RenderResult = {
			errors: [],
			warnings: [],
			paths: [],
			blockResult: {}
		};

		async function buildBridge(modulePath: string, args: any[]) {
			const promise = new Promise<any>((resolve, reject) => {
				const worker = new Worker(join(__dirname, 'block-worker.js'), {
					workerData: {
						basePath,
						modulePath,
						args
					}
				});

				worker.on('message', resolve);
				worker.on('error', reject);
				worker.on('exit', (code) => {
					if (code !== 0) {
						reject(new Error(`Worker stopped with exit code ${code}`));
					}
				});
			});
			try {
				const { result, error } = await promise;
				if (error) {
					btrResult.errors.push(createError(parsedPath, error, 'Block'));
				} else {
					btrResult.blockResult[modulePath] = btrResult.blockResult[modulePath] || {};
					btrResult.blockResult[modulePath][JSON.stringify(args)] = JSON.stringify(result);
					return result;
				}
			} catch (error) {
				btrResult.errors.push(createError(parsedPath, error, 'Block'));
			}
		}

		async function createPage(browser: any) {
			const reportError = (err: Error) => {
				if (err.message.indexOf('http://localhost') !== -1) {
					btrResult.errors.push(createError(parsedPath, err, 'Runtime'));
				}
			};
			const page = await browser.newPage();
			page.on('error', reportError);
			page.on('pageerror', reportError);
			await setupEnvironment(page, baseUrl, scope);
			await page.exposeFunction('__dojoBuildBridge', buildBridge);
			return page;
		}

		function _filterCss(classes: string[]): string {
			return cssFiles.reduce((result, entry: string) => {
				let filteredCss: string = filterCss(join(output, entry), (context: string, value: string) => {
					if (context === 'selector') {
						value = value.replace(/(:| ).*/, '');
						value = value
							.split('.')
							.slice(0, 2)
							.join('.');
						const firstChar = value.substr(0, 1);

						return classes.indexOf(value) === -1 && ['.', '#'].indexOf(firstChar) !== -1;
					}
				});

				return `${result}${filteredCss}`;
			}, '');
		}

		async function getRenderResult(page: any): Promise<WriteRenderResult> {
			const classes: any[] = await getClasses(page);
			let content = await getForSelector(page, `#${root}`);
			let head = await getAllForSelector(page, 'head > *');
			let styles = _filterCss(classes);
			let script = '';

			content = content.replace(/http:\/\/localhost:\d+\//g, '');
			content = content.replace(new RegExp(baseUrl.slice(1), 'g'), '');
			if (useHistory) {
				script = generateBasePath(parsedPath, scope);
			}

			return {
				content,
				styles,
				script,
				path,
				head,
				blockScripts: [],
				additionalScripts: [],
				additionalCss: []
			};
		}

		try {
			const page = await createPage(browser);
			try {
				await page.goto(`http://localhost:${app.port}${baseUrl}${parsedPath}`);
			} catch {
				btrResult.warnings.push(createError(parsedPath, 'Failed to visit path'));
				parentPort.postMessage(btrResult);
				return;
			}
			const pathDirectories = parsedPath.replace('#', '').split('/');
			if (pathDirectories.length > 0) {
				pathDirectories.pop();
				ensureDirSync(join(screenshotDirectory, ...pathDirectories));
			}
			let { rendering, blocksPending } = await getRenderHooks(page, scope);
			while (rendering || blocksPending) {
				({ rendering, blocksPending } = await getRenderHooks(page, scope));
			}
			const scripts = await getScriptSources(page, app.port);
			const additionalScripts = scripts.filter(
				(script) => script && entries.every((entry) => !script.endsWith(originalManifest[entry]))
			);
			const additionalCss = (await getPageStyles(page))
				.filter((url: string) =>
					entries.every((entry) => !url.endsWith(originalManifest[entry.replace('.js', '.css')]))
				)
				.filter((url) => !/^http(s)?:\/\/.*/.test(url) || url.indexOf('localhost') !== -1);
			await page.screenshot({
				path: join(screenshotDirectory, `${parsedPath ? parsedPath.replace('#', '') : 'default'}.png`)
			});
			if (discoverPaths) {
				const links = await getPageLinks(page);
				for (let i = 0; i < links.length; i++) {
					btrResult.paths.push(links[i]);
				}
			}
			const renderResult = await getRenderResult(page);
			renderResult.additionalScripts = additionalScripts;
			renderResult.additionalCss = additionalCss;
			btrResult.renderResult = renderResult;
			await page.close();
		} catch (error) {
			btrResult.errors.push(createError(parsedPath, error));
		}
		parentPort.postMessage(btrResult);
	});
}

setUp();
