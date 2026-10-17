"use strict";
// Both preview routes always redact the permanent key.
exports.handler = require("./admin-members-prepare-email").handler;
