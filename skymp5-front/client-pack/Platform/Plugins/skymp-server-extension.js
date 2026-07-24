(function () {
  const definition = {
    id: "skymp5-front",
    apiVersion: 1,
    activate: function () {
      return {
        connected: function () {},
        disconnected: function () {},
        cleanup: function () {}
      };
    }
  };
  if (globalThis.registerServerExtension) {
    globalThis.registerServerExtension(definition);
  } else {
    (globalThis.__skympServerExtensionQueue ??= []).push(definition);
  }
})();
