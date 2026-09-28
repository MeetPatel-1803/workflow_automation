// Only used by Jest, and only to transform the small set of ESM-only
// node_modules packages listed in each jest config's transformIgnorePatterns
// (currently @nestjs/bullmq's dependency @nestjs/bull-shared ships raw
// `export`/`import` syntax with no CJS build). Application/build code never
// goes through Babel — that's ts-jest/tsc, unaffected by this file.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
