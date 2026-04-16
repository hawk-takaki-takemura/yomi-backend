"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledEnrichTick = exports.scheduledIngestTick = exports.translateHnComments = exports.translateStories = void 0;
// Firebase Admin は各モジュールより先に初期化する
require("./initFirebase.js");
var translateStories_js_1 = require("./translateStories.js");
Object.defineProperty(exports, "translateStories", { enumerable: true, get: function () { return translateStories_js_1.translateStories; } });
var translateHnComments_js_1 = require("./translateHnComments.js");
Object.defineProperty(exports, "translateHnComments", { enumerable: true, get: function () { return translateHnComments_js_1.translateHnComments; } });
var scheduledIngest_js_1 = require("./scheduled/scheduledIngest.js");
Object.defineProperty(exports, "scheduledIngestTick", { enumerable: true, get: function () { return scheduledIngest_js_1.scheduledIngestTick; } });
var scheduledEnrich_js_1 = require("./scheduled/scheduledEnrich.js");
Object.defineProperty(exports, "scheduledEnrichTick", { enumerable: true, get: function () { return scheduledEnrich_js_1.scheduledEnrichTick; } });
//# sourceMappingURL=index.js.map