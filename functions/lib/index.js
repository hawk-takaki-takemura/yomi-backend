"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledIngestTick = exports.translateStories = void 0;
// Firebase Admin は各モジュールより先に初期化する
require("./initFirebase.js");
var translateStories_js_1 = require("./translateStories.js");
Object.defineProperty(exports, "translateStories", { enumerable: true, get: function () { return translateStories_js_1.translateStories; } });
var ingestPlaceholder_js_1 = require("./scheduled/ingestPlaceholder.js");
Object.defineProperty(exports, "scheduledIngestTick", { enumerable: true, get: function () { return ingestPlaceholder_js_1.scheduledIngestTick; } });
//# sourceMappingURL=index.js.map