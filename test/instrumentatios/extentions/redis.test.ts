/*
 * Copyright The Cisco Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// IN ORDER TO RUN THIS UNIT_TEST, RUN 'npm run redis'

import { Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { configureRedisInstrumentation } from '../../../src/instrumentations/extentions/redis';
import { RedisResponseCustomAttributeFunction } from '@opentelemetry/instrumentation-redis/build/src/types';

const instrumentation = new RedisInstrumentation();
instrumentation.enable();

import * as redisTypes from 'redis';
import { testOptions } from '../../utils';
import { SemanticAttributes } from 'cisco-opentelemetry-specifications';

const memoryExporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider();
const redis = require('redis');
provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
instrumentation.setTracerProvider(provider);
instrumentation.enable();
let client: redisTypes.RedisClient;
const key = 'key1';
const value = 'value1';
const hash = 'myhash';
const host = process.env.REDIS_HOST || 'localhost';
const port = process.env.REDIS_PORT || '6379';
const URL = `redis://${host}:${port}`;

describe('Test redis', () => {
  const RUN_REDIS_TESTS = process.env.RUN_REDIS_TESTS as string;
  let shouldTest = true;
  if (!RUN_REDIS_TESTS) {
    console.log('Skipping test-redis. Run Redis to test');
    shouldTest = false;
  }

  before(done => {
    if (shouldTest) {
      client = redis.createClient(URL);
      client.on('error', err => {
        done(err);
      });
      client.on('ready', done);
    } else {
      done();
    }
  });

  beforeEach(function shouldSkip(this: any, done) {
    if (!shouldTest) {
      this.skip();
    }
    done();
  });

  after(done => {
    if (shouldTest) {
      if (client) {
        client.quit(done);
      } else {
        done();
      }
    } else {
      done();
    }
  });

  afterEach(done => {
    if (!shouldTest) {
      done();
    } else {
      client.del('myhash', () => {
        memoryExporter.reset();
        done();
      });
    }
  });

  describe('Test 2 response hooks', () => {
    it('Should return attributes set by both hooks', done => {
      const responseHook: RedisResponseCustomAttributeFunction = (
        span: Span,
        _cmdName: string,
        _cmdArgs: string[],
        response: unknown
      ) => {
        span.setAttribute('someFieldName', 'someData');
      };
      instrumentation.disable();
      instrumentation.setConfig({ responseHook });
      configureRedisInstrumentation(instrumentation, testOptions);
      instrumentation.enable();

      client.hset(hash, key, value, () => {
        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 1);
        const firstHookAtt = spans[0].attributes['someFieldName'];
        assert.strictEqual(firstHookAtt, 'someData');
        const secondHookAtt =
          spans[0].attributes[SemanticAttributes.DB_REDIS_RESPONSE.key];
        assert.strictEqual(secondHookAtt, '1');
        done();
      });
    });
  });

  describe('Test redis commands', () => {
    before(() => {
      instrumentation.disable();
      configureRedisInstrumentation(instrumentation, testOptions);
      instrumentation.enable();
    });

    const REDIS_OPERATIONS: Array<{
      prepare: (cb) => unknown;
      description: string;
      command: string;
      args: string[];
      responseShouldBe: string;
      method: (cb: redisTypes.Callback<unknown>) => unknown;
    }> = [
      {
        prepare: cb => client.hset(hash, key, value, cb),
        description: `hekys command: should return ${key}`,
        command: 'hkeys',
        args: [hash],
        responseShouldBe: `["${key}"]`,
        method: cb => client.hkeys(hash, cb),
      },
      {
        prepare: cb => client.hset(hash, key, value, cb),
        description: `hget command: should return ${value} for key: ${key}`,
        command: 'hget',
        args: [hash, key],
        responseShouldBe: `"${value}"`,
        method: cb => client.hget(hash, key, cb),
      },
      {
        prepare: cb => client.hset(hash, key, value, cb),
        description: `hgetall command: should return ${key}:${value} for hash: ${hash}`,
        command: 'hgetall',
        args: [hash],
        responseShouldBe: `{"${key}":"${value}"}`,
        method: cb => client.hgetall(hash, cb),
      },
      {
        prepare: () => {},
        description: `hset command: set ${key} and return the number of fields that were added`,
        command: 'hset',
        args: [hash, key, value],
        responseShouldBe: '1',
        method: cb => client.hset(hash, key, value, cb),
      },
      {
        prepare: cb => client.set(key, value, cb),
        description: `del command: should delete the element ${key} in ${hash} and return 1`,
        command: 'del',
        args: [key],
        responseShouldBe: '1',
        method: cb => client.del(key, cb),
      },
      {
        prepare: cb => client.hset(hash, key, '1', cb),
        description: `hincrby command: should increase the value of ${key} by 1 and return 2`,
        command: 'hincrby',
        args: [hash, key, '1'],
        responseShouldBe: '2',
        method: cb => client.hincrby(hash, key, 1, cb),
      },
    ];

    REDIS_OPERATIONS.forEach(operation => {
      it(operation.description, done => {
        operation.prepare(() => {
          memoryExporter.reset();
        });
        operation.method(() => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          const res =
            spans[0].attributes[SemanticAttributes.DB_REDIS_RESPONSE.key];
          assert.strictEqual(res, operation.responseShouldBe);
          const arg = spans[0].attributes[
            SemanticAttributes.DB_REDIS_ARGUMENTS.key
          ] as string;
          assert.deepEqual(JSON.parse(arg), operation.args);
          done();
        });
      });
    });

    it(`multi & exec commands: should use multi eo execute the command hset and return ${value}`, done => {
      const multi = client.multi();
      multi.hset(hash, key, value);
      multi.exec(() => {
        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 3);
        const multiRes = spans[0].attributes[
          SemanticAttributes.DB_REDIS_RESPONSE.key
        ] as string;
        assert.equal(JSON.parse(multiRes), 'OK');
        const execRes =
          spans[2].attributes[SemanticAttributes.DB_REDIS_RESPONSE.key];
        assert.strictEqual(execRes, '[1]');
        done();
      });
    });
  });
});
