const fs = require('fs');
const path = require('path');

exports.download = (pathname, directory = path.join(__dirname, 'runtime')) => {
  const match = /^\/downloads\/runtime\/([a-f0-9]{16})\/(0|[1-9]\d?)$/.exec(pathname);
  if (!match) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const index = Number(match[2]);
  if (match[1] !== manifest.id || !manifest.parts[index]) return null;
  const bytes = fs.readFileSync(path.join(directory, `${index}.bin`));
  return { data: bytes.toString('base64') };
};
