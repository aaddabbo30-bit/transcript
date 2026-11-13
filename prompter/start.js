// Starts the Suggeritore from a terminal (npm start), VS Code's included.
// VS Code sets ELECTRON_RUN_AS_NODE for the programs it starts: Electron would
// then run as plain Node and open no window. The desktop icon doesn't need this.

const { spawn } = require("node:child_process");
const electron = require("electron"); // from Node, the path of the Electron program

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [__dirname], { env, detached: true, stdio: "ignore" }).unref();
