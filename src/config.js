const fs = require('fs');
const path = require('path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function load(userDataDir, appRoot) {
  const userPath = configPath(userDataDir);
  if (fs.existsSync(userPath)) {
    return JSON.parse(fs.readFileSync(userPath, 'utf8'));
  }
  const defaults = JSON.parse(
    fs.readFileSync(path.join(appRoot, 'config.default.json'), 'utf8')
  );
  fs.writeFileSync(userPath, JSON.stringify(defaults, null, 2));
  return defaults;
}

function save(userDataDir, cfg) {
  fs.writeFileSync(configPath(userDataDir), JSON.stringify(cfg, null, 2));
}

module.exports = { load, save, configPath };
