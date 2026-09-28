const path = require('node:path');

/** E2E config: runs against a real Postgres + Redis (see README "Running tests"). */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\.e2e-spec\.ts$',
  // See jest.config.js for why this is needed: @nestjs/bullmq (and its dep
  // @nestjs/bull-shared) ship pure ESM with no CJS build.
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs/(bullmq|bull-shared))/)',
  ],
  transform: {
    '^.+\.ts$': 'ts-jest',
    '^.+\.js$': [
      'babel-jest',
      { configFile: path.resolve(__dirname, '../babel.config.js') },
    ],
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
};
