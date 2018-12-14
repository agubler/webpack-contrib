var has = require('@dojo/framework/has/has');
var global = require('@dojo/framework/shim/global');

if (!has.exists('build-time-render')) {
	has.add('build-time-render', false, false);
}

if (!has.exists('build-serve')) {
	has.add('build-serve', false, false);
}

if (global.default.__public_path__) {
	// @ts-ignore
	__webpack_public_path__ = window.location.origin + global.default.__public_path__;
	has.add('public-path', global.default.__public_path__, true);
}
