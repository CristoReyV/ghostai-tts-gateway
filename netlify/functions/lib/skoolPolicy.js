"use strict";
function skoolBlocked(member, now = Date.now()) {
  return member?.access_plan === "skool" && (!member.skool_source_id || !!member.skool_removed_at || !!member.skool_expires_at && Date.parse(member.skool_expires_at) <= now);
}
module.exports = { skoolBlocked };
