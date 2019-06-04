import loader from '../../../src/css-module-decorator-loader/loader';

const { assert } = intern.getPlugin('chai');
const { describe, it } = intern.getInterface('bdd');

describe('css-module-decorator-loader', () => {
	it('should not effect content without local exports', () => {
		const content = `exports = 'abc'
		exports.push(['a', 'b'])`;

		const result = loader.call({ resourcePath: 'blah' } as any, content);
		assert.equal(result, content);
	});

	it('should wrap local exports with decorator', () => {
		const content = `exports.locals = { "hello": "world" };`;

		const result = loader.bind({ resourcePath: 'testFile.m.css' } as any)(content);
		assert.equal(
			result.replace(/\n|\t/g, ''),
			'exports.locals = {" _key": "@dojo/webpack-contrib/testFile", "hello": "world" };'
		);
	});

	it('should wrap multi line local exports with decorator', () => {
		const content = `exports.locals = {
			"hello": "world",
			"foo": "bar"
		};`;

		const result = loader.bind({ resourcePath: 'testFile.m.css' } as any)(content);
		assert.equal(
			result.replace(/\n|\t/g, ''),
			'exports.locals = {" _key": "@dojo/webpack-contrib/testFile","hello": "world","foo": "bar"};'
		);
	});

	it('should support inline requires used for composes', () => {
		const content = `exports.locals = {
			 "hello": "world " + require("-!stuff!./base.css").locals["hello"] + "",
			 "foo": "bar"
		};`;

		const result = loader.bind({ resourcePath: 'testFile.m.css' } as any)(content);
		assert.equal(
			result.replace(/\n|\t/g, ''),
			'exports.locals = {" _key": "@dojo/webpack-contrib/testFile", "hello": "world " + require("-!stuff!./base.css").locals["hello"] + "", "foo": "bar"};'
		);
	});
});
