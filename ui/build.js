const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'public/bundle.js',
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(config).then(ctx => ctx.watch());
} else {
  esbuild.buildSync(config);
}
