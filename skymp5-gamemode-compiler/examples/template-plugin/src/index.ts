import { formatFormId } from "./format";
import { loadPluginSettings } from "./settings";

const settings = loadPluginSettings();

console.log("[template-plugin] Loaded");

mp.on("connect", (userId) => {
  if (settings.logConnections) {
    console.log(`[template-plugin] User ${userId} connected`);
  }
});

mp.on("disconnect", (userId) => {
  if (settings.logConnections) {
    console.log(`[template-plugin] User ${userId} disconnected`);
  }
});

mp.onActivate = (targetId, casterId) => {
  if (settings.logActivations) {
    console.log(
      `[template-plugin] ${formatFormId(casterId)} activated ${formatFormId(targetId)}`,
    );
  }

  // Returning true allows the event to continue.
  return true;
};
