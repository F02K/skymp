# skymp5-front

This repo contains GUI demo for Skyrim Multiplayer. Original chat interface by **davinchi59** has been ported.

* `yarn build` is used to build the project.
* `yarn watch` is used to start live-reload server.

In the main SkyMP build, this UI is no longer part of the immutable Core
client. `BUILD_FRONT=ON` writes a reference Client Pack staging tree to
`build/client-packs/skymp5-front`, with the compiled frontend under
`Platform/UI`. Package it with:

```text
skymp-buildtool.cmd package client-pack build\client-packs\skymp5-front build\client-packs\skymp5-front.zip
```

If you start a live-reload server and Skyrim Multiplayer server on the same machine, then live-reload would work in the game.

## How To Use This 

Create `config.js` and specify an output folder.
```js
module.exports = {
    /* TIP: Change to '<your_server_path>/data/ui' */
    outputPath: "./dist",
};
```
