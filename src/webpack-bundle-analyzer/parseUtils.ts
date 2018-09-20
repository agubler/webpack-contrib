import * as fs from 'fs';
import * as _ from 'lodash';
import * as acorn from 'acorn';
const walk = require('acorn/dist/walk');

export function parseBundle(bundlePath: any) {
	const content = fs.readFileSync(bundlePath, 'utf8');
	const ast = acorn.parse(content, { sourceType: 'script', ecmaVersion: 2017 });
	const walkState = {
		locations: null
	};

	walk.recursive(ast, walkState, {
		CallExpression(node: any, state: any, c: any) {
			if (state.sizes) {
				return;
			}

			const args = node.arguments;
			if (
				node.callee.type === 'Identifier' &&
				args.length >= 2 &&
				isArgumentContainsChunkIds(args[0]) &&
				isArgumentContainsModulesList(args[1])
			) {
				state.locations = getModulesLocationFromFunctionArgument(args[1]);
				return;
			}

			if (
				node.callee.type === 'Identifier' &&
				(args.length === 2 || args.length === 3) &&
				isArgumentContainsChunkIds(args[0]) &&
				isArgumentArrayConcatContainingChunks(args[1])
			) {
				state.locations = getModulesLocationFromArrayConcat(args[1]);
				return;
			}

			if (
				node.callee.type === 'FunctionExpression' &&
				!node.callee.id &&
				args.length === 1 &&
				isArgumentContainsModulesList(args[0])
			) {
				state.locations = getModulesLocationFromFunctionArgument(args[0]);
				return;
			}

			if (
				isWindowPropertyPushExpression(node) &&
				args.length === 1 &&
				isArgumentContainingChunkIdsAndModulesList(args[0])
			) {
				state.locations = getModulesLocationFromFunctionArgument(args[0].elements[1]);
				return;
			}

			_.each(args, (arg) => c(arg, state));
		}
	});

	if (!walkState.locations) {
		return null;
	}

	return {
		src: content,
		modules: _.mapValues(walkState.locations, (loc: any) => content.slice(loc.start, loc.end))
	};
}

function isArgumentContainsChunkIds(arg: any) {
	// Array of numeric or string ids. Chunk IDs are strings when NamedChunksPlugin is used
	return arg.type === 'ArrayExpression' && _.every(arg.elements, isModuleId);
}

function isArgumentContainsModulesList(arg: any) {
	if (arg.type === 'ObjectExpression') {
		return _(arg.properties)
			.map('value')
			.every(isModuleWrapper);
	}

	if (arg.type === 'ArrayExpression') {
		// Modules are contained in array.
		// Array indexes are module ids
		return _.every(
			arg.elements,
			(elem) =>
				// Some of array items may be skipped because there is no module with such id
				!elem || isModuleWrapper(elem)
		);
	}

	return false;
}

function isArgumentContainingChunkIdsAndModulesList(arg: any) {
	if (
		arg.type === 'ArrayExpression' &&
		arg.elements.length >= 2 &&
		isArgumentContainsChunkIds(arg.elements[0]) &&
		isArgumentContainsModulesList(arg.elements[1])
	) {
		return true;
	}
	return false;
}

function isArgumentArrayConcatContainingChunks(arg: any) {
	if (
		arg.type === 'CallExpression' &&
		arg.callee.type === 'MemberExpression' &&
		arg.callee.object.type === 'CallExpression' &&
		arg.callee.object.callee.type === 'Identifier' &&
		arg.callee.object.callee.name === 'Array' &&
		arg.callee.object.arguments.length === 1 &&
		isNumericId(arg.callee.object.arguments[0]) &&
		arg.callee.property.type === 'Identifier' &&
		arg.callee.property.name === 'concat' &&
		arg.arguments.length === 1 &&
		arg.arguments[0].type === 'ArrayExpression'
	) {
		return true;
	}

	return false;
}

function isWindowPropertyPushExpression(node: any) {
	return (
		node.callee.type === 'MemberExpression' &&
		node.callee.property.name === 'push' &&
		node.callee.object.type === 'AssignmentExpression' &&
		node.callee.object.left.object.name === 'window'
	);
}

function isModuleWrapper(node: any) {
	return (
		// It's an anonymous function expression that wraps module
		((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && !node.id) ||
		// If `DedupePlugin` is used it can be an ID of duplicated module...
		isModuleId(node) ||
		// or an array of shape [<module_id>, ...args]
		(node.type === 'ArrayExpression' && node.elements.length > 1 && isModuleId(node.elements[0]))
	);
}

function isModuleId(node: any) {
	return node.type === 'Literal' && (isNumericId(node) || typeof node.value === 'string');
}

function isNumericId(node: any) {
	return node.type === 'Literal' && Number.isInteger(node.value) && node.value >= 0;
}

function getModulesLocationFromFunctionArgument(arg: any) {
	if (arg.type === 'ObjectExpression') {
		const modulesNodes = arg.properties;

		return _.transform(
			modulesNodes,
			(result, moduleNode: any) => {
				const moduleId = moduleNode.key.name || moduleNode.key.value;

				result[moduleId] = getModuleLocation(moduleNode.value);
			},
			{}
		);
	}

	if (arg.type === 'ArrayExpression') {
		const modulesNodes = arg.elements;

		return _.transform(
			modulesNodes,
			(result, moduleNode, i) => {
				if (!moduleNode) {
					return;
				}

				result[i] = getModuleLocation(moduleNode);
			},
			{}
		);
	}

	return {};
}

function getModulesLocationFromArrayConcat(arg: any) {
	// arg(CallExpression) =
	//   Array([minId]).concat([<minId module>, <minId+1 module>, ...])
	//
	// Get the [minId] value from the Array() call first argument literal value
	const minId = arg.callee.object.arguments[0].value;
	// The modules reside in the `concat()` function call arguments
	const modulesNodes = arg.arguments[0].elements;

	return _.transform(
		modulesNodes,
		(result, moduleNode, i) => {
			if (!moduleNode) {
				return;
			}

			result[i + minId] = getModuleLocation(moduleNode);
		},
		{}
	);
}

function getModuleLocation(node: any) {
	return _.pick(node, 'start', 'end');
}
