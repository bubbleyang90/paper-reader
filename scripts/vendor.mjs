// Reproducible browser-preview dependencies. Desktop Markdown parsing runs in Rust.
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../web/vendor/', import.meta.url);
await mkdir(root, { recursive: true });
const packages = [
  { name: 'marked', version: '18.1.1', files: { 'package/lib/marked.umd.js': 'marked.umd.js', 'package/LICENSE': 'marked.LICENSE.md' } },
  { name: 'dompurify', version: '3.4.17', files: { 'package/dist/purify.min.js': 'purify.min.js', 'package/LICENSE': 'DOMPurify.LICENSE' } },
];
for (const pkg of packages) {
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`);
  if (!response.ok) throw new Error(`${pkg.name}: HTTP ${response.status}`);
  const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const remaining = new Set(Object.keys(pkg.files));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    if (pkg.files[name]) {
      await writeFile(new URL(pkg.files[name], root), tar.subarray(offset + 512, offset + 512 + size));
      remaining.delete(name); console.log(`${pkg.name}@${pkg.version}: ${pkg.files[name]} (${size} bytes)`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (remaining.size) throw new Error(`Missing files: ${[...remaining].join(', ')}`);
}
