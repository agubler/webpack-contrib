"use strict";
(function main() {
    var app = document.getElementById('app');
    var div = document.createElement('div');
    /** @preserve dojoBuildBridgeCache 'foo.build' **/
    window.__dojoBuildBridge('foo.build', ['a']).then(function (result) {
        div.innerHTML = result;
    });
    app.appendChild(div);
})();
//# sourceMappingURL=main.js.map