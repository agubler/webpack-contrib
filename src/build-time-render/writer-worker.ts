const { parentPort, workerData } = require('worker_threads');
import { outputFileSync } from 'fs-extra';
import { join } from 'path';
import { WriteRenderResult } from './interfaces';
import cssnano = require('cssnano');
const postcss = require('postcss');

interface WriterData {
	output: string;
	baseUrl: string;
	entries: string[];
	originalRoot: string;
	writeHtml: boolean;
	useHistory: boolean;
	manifestContent: any;
	manifest: any;
	isStatic: boolean;
	sync: boolean;
}

const {
	isStatic,
	writeHtml,
	originalRoot,
	manifest,
	sync,
	output,
	baseUrl,
	entries,
	manifestContent,
	useHistory
}: WriterData = workerData;

async function processCss(css: string) {
	const cssnanoConfig = cssnano({ preset: ['default', { calc: false, normalizeUrl: false }] });
	const processedCss = await postcss([cssnanoConfig]).process(css, { from: undefined });
	return processedCss.css;
}

function createScripts(regex = true) {
	const scripts = entries.reduce(
		(script, entry) => `${script}<script${regex ? '.*' : ''} src="${manifest[entry]}"></script>`,
		''
	);
	return regex ? new RegExp(scripts) : scripts;
}

parentPort.on(
	'message',
	async ({
		additionalCss,
		additionalScripts,
		blockScripts,
		path = '',
		content,
		head,
		styles,
		script
	}: WriteRenderResult) => {
		let staticPath = isStatic;
		const writtenHtmlFiles: string[] = [];
		if (typeof path === 'object') {
			if (useHistory) {
				staticPath = path.static === undefined ? staticPath : path.static;
			}
			path = path.path;
		} else {
			path = path;
		}

		let html = manifestContent['index.html'];
		const writtenAssets: string[] = entries.map((entry) => manifest[entry]);
		if (writeHtml) {
			html = html.replace(originalRoot, content);
			if (head.length) {
				head = head.filter((node) => !/.*localhost.*/.test(node));
				html = html.replace(/<head>[\s\S]*<\/head>/, `<head>\n\t\t${head.join('\n\t\t')}\n\t</head>`);
			}
			const cssFiles = Object.keys(manifest).filter((key) => /\.css$/.test(key));
			let css = cssFiles.reduce((css, file) => {
				const cssFile = manifest[file];
				const cssFileRegExp = new RegExp(`<link .*?href="${cssFile}".*?>`);
				if (cssFile && cssFileRegExp.test(html)) {
					html = html.replace(cssFileRegExp, '');
					if (entries.indexOf(file.replace('.css', '.js')) !== -1) {
						css = `${css}<link rel="stylesheet" href="${cssFile}" />`;
						writtenAssets.push(cssFile);
					}
				}
				return css;
			}, '');

			css = additionalCss.reduce((prev, url) => {
				url = url.replace(baseUrl.slice(1), '');
				writtenAssets.push(url);

				return `${prev}<link rel="preload" href="${url}" as="style">`;
			}, css);

			styles = await processCss(styles);
			html = html.replace(`</head>`, `<style>${styles}</style></head>`);
			if (staticPath) {
				html = html.replace(createScripts(), '');
			} else {
				html = html.replace(createScripts(), `${script}${css}${createScripts(false)}`);

				const mainScript = manifest['main.js'];

				additionalScripts
					.sort((script1, script2) => {
						return script1 === mainScript && !(script2 === mainScript) ? 1 : -1;
					})
					.forEach((additionalChunk: string) => {
						additionalChunk = additionalChunk.replace(baseUrl.slice(1), '');
						writtenAssets.push(additionalChunk);

						html = html.replace(
							'</body>',
							`<link rel="preload" href="${additionalChunk}" as="script"></body>`
						);
					});

				Object.keys(manifest)
					.filter((name) => name.endsWith('.js') || name.endsWith('.css'))
					.filter((name) => !name.startsWith('runtime/'))
					.filter((name) => !writtenAssets.some((asset) => manifest[name] === asset))
					.forEach((preload) => {
						html = html.replace(
							'</body>',
							`<link rel="prefetch" href="${manifest[preload].replace(baseUrl.slice(1), '')}" /></body>`
						);
					});
			}
		} else {
			if (!sync) {
				html = html.replace(
					'</body>',
					`<script type="text/javascript" src="${manifest['runtime/blocks.js']}"></script></body>`
				);
			}
		}
		if (!staticPath) {
			blockScripts.forEach((blockScript, i) => {
				writtenAssets.push(blockScript);
				html = html.replace('</body>', `<script type="text/javascript" src="${blockScript}"></script></body>`);
			});
		}
		const htmlPath = join(output, ...path.split('/'), 'index.html');
		if (path) {
			writtenHtmlFiles.push(htmlPath);
		}
		outputFileSync(htmlPath, html);
		parentPort.postMessage(writtenHtmlFiles);
	}
);
