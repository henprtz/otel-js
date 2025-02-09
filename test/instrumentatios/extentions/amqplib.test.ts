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

// in order to these tests locally, run: docker run `export RUN_RABBITMQ_TESTS=1'; npm run rabbitmq`
import { AmqplibInstrumentation } from 'opentelemetry-instrumentation-amqplib';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';

const instrumentation = new AmqplibInstrumentation();
instrumentation.enable();
const memoryExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
instrumentation.setTracerProvider(provider);
provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));

import * as amqp from 'amqplib';
import { Channel, ConfirmChannel } from 'amqplib/callback_api';
import { configureAmqplibInstrumentation } from '../../../src/instrumentations/extentions/amqplib';
import { assertExpectedObj, testOptions } from '../../utils';
import { SemanticAttributes } from 'cisco-opentelemetry-specifications';

const TEST_RABBITMQ_HOST = process.env.TEST_RABBITMQ_HOST || '127.0.0.1';
const TEST_RABBITMQ_PASS = process.env.TEST_RABBITMQ_PASS || 'password';
const TEST_RABBITMQ_PORT = process.env.TEST_RABBITMQ_PORT || '5672';
const TEST_RABBITMQ_USER = process.env.TEST_RABBITMQ_USER || 'username';

const QUEUE_NAME = 'test-rabbitmq-queue';

// signal that the channel is closed in test, thus it should not be closed again in afterEach.
// could not find a way to get this from amqplib directly.
const CHANNEL_CLOSED_IN_TEST = Symbol(
  'opentelemetry.amqplib.unittest.channel_closed_in_test'
);

export const asyncConsume = (
  channel: amqp.Channel | Channel | amqp.ConfirmChannel | ConfirmChannel,
  queueName: string,
  callback: ((msg: amqp.Message) => unknown)[],
  options?: amqp.Options.Consume
): Promise<amqp.Message[]> => {
  const msgs: amqp.Message[] = [];
  return new Promise(resolve =>
    channel.consume(
      queueName,
      msg => {
        msgs.push(<amqp.Message>msg);
        try {
          callback[msgs.length - 1]?.(<amqp.Message>msg);
          if (msgs.length >= callback.length) {
            setImmediate(() => resolve(msgs));
          }
        } catch (err) {
          setImmediate(() => resolve(msgs));
          throw err;
        }
      },
      options
    )
  );
};

describe('amqplib instrumentation callback model', () => {
  // For these tests, rabbitmq must be running. Add RUN_MONGODB_TESTS to run
  // these tests.
  const RUN_RABBITMQ_TESTS = process.env.RUN_RABBITMQ_TESTS as string;
  let shouldTest = true;
  if (!RUN_RABBITMQ_TESTS) {
    console.log('Skipping test-rabbitmq. Run RabbitMQ to test');
    shouldTest = false;
  }

  const url = `amqp://${TEST_RABBITMQ_USER}:${TEST_RABBITMQ_PASS}@${TEST_RABBITMQ_HOST}:${TEST_RABBITMQ_PORT}`;
  let conn: amqp.Connection;

  const MESSAGE_HEADERS = {
    'some-request-header': 'some-request-value',
    'andd-another-one': 'yoyoyo',
  };
  const MESSAGE_TO_SEND =
    'Some message we send over the queue. Not too long but no too short';

  before(async () => {
    if (shouldTest) {
      configureAmqplibInstrumentation(instrumentation, testOptions);
      conn = await amqp.connect(url);
    }
  });

  beforeEach(function shouldSkip(this: any, done) {
    if (!shouldTest) {
      this.skip();
    }
    done();
  });

  after(async () => {
    if (shouldTest) await conn.close();
  });

  describe('channel payload & headers capture test', () => {
    let channel: amqp.Channel;
    beforeEach(async () => {
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE_NAME, { durable: false });
      await channel.purgeQueue(QUEUE_NAME);
      // install an error handler, otherwise when we have tests that create error on the channel,
      // it throws and crash process
      channel.on('error', err => {});
      memoryExporter.reset();
    });

    afterEach(async () => {
      if (!channel[CHANNEL_CLOSED_IN_TEST]) {
        try {
          await new Promise<void>(resolve => {
            channel.on('close', resolve);
            channel.close();
          });
        } catch {}
      }
    });

    it('simple publish and consume from queue', async () => {
      const hadSpaceInBuffer = channel.sendToQueue(
        QUEUE_NAME,
        Buffer.from(MESSAGE_TO_SEND),
        { headers: MESSAGE_HEADERS }
      );
      assert(hadSpaceInBuffer);

      await asyncConsume(channel, QUEUE_NAME, [msg => {}], { noAck: true });

      const [publishSpan, consumeSpan] = memoryExporter.getFinishedSpans();

      assertExpectedObj(
        publishSpan,
        MESSAGE_HEADERS,
        SemanticAttributes.MESSAGING_RABBITMQ_MESSAGE_HEADER.key
      );
      assertExpectedObj(
        consumeSpan,
        MESSAGE_HEADERS,
        SemanticAttributes.MESSAGING_RABBITMQ_MESSAGE_HEADER.key
      );

      assert.strictEqual(
        publishSpan.attributes[
          SemanticAttributes.MESSAGING_RABBITMQ_PAYLOAD_SIZE.key
        ],
        MESSAGE_TO_SEND.length
      );
      assert.strictEqual(
        consumeSpan.attributes[
          SemanticAttributes.MESSAGING_RABBITMQ_PAYLOAD_SIZE.key
        ],
        MESSAGE_TO_SEND.length
      );

      assert.strictEqual(
        publishSpan.attributes[
          SemanticAttributes.MESSAGING_RABBITMQ_PAYLOAD.key
        ],
        MESSAGE_TO_SEND
      );
      assert.strictEqual(
        consumeSpan.attributes[
          SemanticAttributes.MESSAGING_RABBITMQ_PAYLOAD.key
        ],
        MESSAGE_TO_SEND
      );
    });

    describe('when user configuration specified', () => {
      afterEach(() => {
        instrumentation.setConfig({});
        configureAmqplibInstrumentation(instrumentation, testOptions);
      });

      it('should see and not override user publishHook, consumeHook', async () => {
        instrumentation.setConfig({
          publishHook: (span, publishParams) => {
            span.setAttribute('user.attribute', 'hey! publish! dont change me');
            span.setAttribute(
              'messaging.message.header.missed-header',
              'header-u-missed'
            );
          },
          consumeHook: (span, msg) => {
            span.setAttribute(
              'user.attribute',
              'hey! consumer! dont change me'
            );
            span.setAttribute(
              'messaging.message.header.missed-header',
              'header-u-missed'
            );
          },
        });

        configureAmqplibInstrumentation(instrumentation, testOptions);

        const hadSpaceInBuffer = channel.sendToQueue(
          QUEUE_NAME,
          Buffer.from(MESSAGE_TO_SEND),
          { headers: MESSAGE_HEADERS }
        );
        assert(hadSpaceInBuffer);

        await asyncConsume(channel, QUEUE_NAME, [msg => {}], { noAck: true });

        const [publishSpan, consumeSpan] = memoryExporter.getFinishedSpans();

        assert.strictEqual(
          publishSpan.attributes['user.attribute'],
          'hey! publish! dont change me'
        );
        assert.strictEqual(
          publishSpan.attributes['messaging.message.header.missed-header'],
          'header-u-missed'
        );

        assert.strictEqual(
          consumeSpan.attributes['user.attribute'],
          'hey! consumer! dont change me'
        );
        assert.strictEqual(
          consumeSpan.attributes['messaging.message.header.missed-header'],
          'header-u-missed'
        );
      });
    });
  });
});
