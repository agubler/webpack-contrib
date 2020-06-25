export interface BuildTimePath {
	path: string;
	match?: string[];
	static?: boolean;
}

export interface WriteRenderResult {
	path?: string | BuildTimePath;
	head: string[];
	content: string;
	styles: string;
	script: string;
	blockScripts: string[];
	additionalScripts: string[];
	additionalCss: string[];
}

export interface RenderResult {
	paths: string[];
	renderResult?: WriteRenderResult;
	blockResult: any;
	warnings: any[];
	errors: any[];
}
