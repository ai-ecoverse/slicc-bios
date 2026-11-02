export const namespaceEnabled = (scene) =>
  Boolean(scene.sameOriginChild || scene.standaloneControl);

export const namespaceCommand = (scene, command) =>
  namespaceEnabled(scene) ? `SLICC_WEBMCP_TRACE=1 ${command}` : command;

export const namespaceTrace = (stdout) =>
  stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
