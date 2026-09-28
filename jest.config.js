const path = require('node:path');

/** Unit-test config. E2E lives in test/jest-e2e.config.js */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  setupFiles: ['reflect-metadata'],
  testRegex: '.*\.spec\.ts$',
  // @nestjs/bullmq and its dep @nestjs/bull-shared ship pure ESM with no CJS
  // build — un-ignore them so Jest transforms instead of choking on
  // `export`/`import`. Plain forward slashes: jest-config's own
  // normalizeUnmockedModulePathPatterns() rewrites '/' to the platform
  // separator before this is used, so writing an explicit '\\' here would
  // (and did) get double-converted and match nothing.
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs/(bullmq|bull-shared))/)',
  ],
  transform: {
    '^.+\.ts$': 'ts-jest',
    // babel-jest's own config search is bounded by `root` (= this config's
    // rootDir, "src") and never escapes it — since babel.config.js lives at
    // the real project root (one level up), that search silently finds
    // nothing for any node_modules file, and babel-jest then returns the
    // source untransformed. Passing configFile explicitly bypasses that
    // bounded search entirely.
    '^.+\.js$': [
      'babel-jest',
      { configFile: path.resolve(__dirname, 'babel.config.js') },
    ],
  },
  collectCoverageFrom: ['**/*.ts', '!main.ts', '!**/*.module.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
};
